/**
 * Taking a person's records out of our custody, and keeping them anchored after.
 *
 * By default we hold the key: it is derived from one master seed, which is what
 * lets somebody who has never held a wallet own a record on chain at all. This
 * is the way out of that, for anybody who wants it — the shape Apple ships
 * Advanced Data Protection in, recoverable by default and strong custody opt-in.
 *
 * The phrase never reaches this server. The device generates it, derives the
 * account, and sends only the public key and the address. A route here that
 * accepted a phrase, even to be helpful, would have quietly taken custody back.
 *
 * The consequence is the part that needs real machinery rather than a flag: we
 * can still write their records, because encrypting needs only a public key, and
 * we can no longer sign as the owner. So anchoring becomes a handshake — we say
 * what needs signing, their device signs it, and the relayer still pays.
 */

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import { ethers } from 'ethers'
import { recoverAnchorSigner } from '@ogt/og'
import type { Database } from '../db/index.ts'
import { currentUserId } from '../plugins/auth.ts'
import { snapshots, users } from '../db/schema.ts'

/**
 * A compressed secp256k1 public key, and the address it belongs to.
 *
 * Both are sent because both are stored, and neither is trusted: the address is
 * re-derived from the key below. A mismatch would encrypt records to one account
 * and anchor them to another, which is the failure that loses somebody their
 * history while every individual step reports success.
 */
const TakeCustodyBody = z.object({
  publicKey: z.string().regex(/^0x0[23][0-9a-fA-F]{64}$/, 'expected a compressed public key'),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address'),
})

const SignatureBody = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'expected an EIP-712 signature'),
  deadline: z.union([z.string(), z.number()]).transform((value) => BigInt(value)),
})

/** The snapshot's own id is the nonce, exactly as the anchor worker computes it. */
function nonceFor(snapshotId: string): bigint {
  return BigInt('0x' + snapshotId.replaceAll('-', ''))
}

export interface CustodyRouteDeps {
  db: Database
  /** Needed to tell a device what it is signing. Absent means anchoring is off. */
  anchorAddress: string | undefined
  chainId: number
}

export async function registerCustodyRoutes(
  app: FastifyInstance,
  deps: CustodyRouteDeps,
): Promise<void> {
  /** Where a person stands: ours, or theirs. */
  app.get('/users/me/custody', async (request, reply) => {
    const userId = currentUserId(request)

    const [user] = await deps.db
      .select({
        custodyTakenAt: users.custodyTakenAt,
        anchorAddress: users.anchorAddress,
        recordPubKey: users.recordPubKey,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    return reply.status(200).send({
      // Named for what it means to a person rather than for the column.
      selfCustody: Boolean(user?.custodyTakenAt),
      since: user?.custodyTakenAt?.toISOString() ?? null,
      address: user?.anchorAddress ?? null,
      publicKey: user?.recordPubKey ?? null,
    })
  })

  /**
   * Hand custody to the person.
   *
   * One way on purpose. Handing it back would mean us generating a key for them
   * again, and a product that can undo this on request has not really given
   * anything away — the honest version is that this is theirs now.
   */
  app.post('/users/me/custody', async (request, reply) => {
    const userId = currentUserId(request)
    const body = TakeCustodyBody.parse(request.body)

    /*
     * The address must be the one this key produces. Anything else means the
     * device sent a mismatched pair, and accepting it would encrypt records to
     * a key whose owner cannot claim them on chain — recoverable only by
     * somebody holding both halves, which is nobody.
     */
    const address = ethers.computeAddress(body.publicKey)
    if (address.toLowerCase() !== body.address.toLowerCase()) {
      return reply.status(400).send({
        error: 'key_mismatch',
        message: 'That public key does not belong to that address.',
      })
    }

    const [existing] = await deps.db
      .select({ custodyTakenAt: users.custodyTakenAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (existing?.custodyTakenAt) {
      // Not something to do twice: a second key would orphan every record
      // written to the first, and there is no way back from that.
      return reply.status(409).send({
        error: 'already_self_custody',
        message: 'You already hold your own key. Taking custody again would orphan your records.',
      })
    }

    const takenAt = new Date()
    await deps.db
      .update(users)
      .set({
        recordPubKey: body.publicKey,
        anchorAddress: address,
        custodyTakenAt: takenAt,
        updatedAt: takenAt,
      })
      .where(eq(users.id, userId))

    return reply.status(200).send({ selfCustody: true, since: takenAt.toISOString(), address })
  })

  /**
   * What this person's device needs to sign.
   *
   * Only for people who took custody — for everyone else the worker signs and
   * there is nothing to ask.
   */
  app.get('/users/me/anchors/pending', async (request, reply) => {
    const userId = currentUserId(request)

    const [user] = await deps.db
      .select({ custodyTakenAt: users.custodyTakenAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (!user?.custodyTakenAt) {
      return reply.status(200).send({ contract: null, chainId: deps.chainId, pending: [] })
    }

    const rows = await deps.db
      .select({
        id: snapshots.id,
        rootHashes: snapshots.rootHashes,
        schemaVersion: snapshots.schemaVersion,
        createdAt: snapshots.createdAt,
        ownerSignature: snapshots.ownerSignature,
      })
      .from(snapshots)
      .where(and(eq(snapshots.userId, userId), isNull(snapshots.anchorTxHash)))
      .orderBy(snapshots.createdAt)
      .limit(50)

    return reply.status(200).send({
      contract: deps.anchorAddress ?? null,
      chainId: deps.chainId,
      pending: rows.map((row) => ({
        id: row.id,
        rootHashes: row.rootHashes,
        schemaVersion: row.schemaVersion,
        createdAt: row.createdAt.toISOString(),
        // The nonce the contract will see, sent rather than left for the client
        // to reconstruct: two implementations of one derivation is one more
        // than there should be.
        nonce: nonceFor(row.id).toString(),
        signed: row.ownerSignature !== null,
      })),
    })
  })

  /**
   * Accept a signature their device produced.
   *
   * Verified here before it is stored. An invalid one would be submitted by the
   * worker, reverted by the contract, and paid for by us — and the failure would
   * surface far from its cause.
   */
  app.post('/users/me/anchors/:id/signature', async (request, reply) => {
    const userId = currentUserId(request)
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = SignatureBody.parse(request.body)

    if (!deps.anchorAddress) {
      return reply.status(503).send({
        error: 'anchoring_unavailable',
        message: 'Anchoring is not configured on this deployment.',
      })
    }

    const [user] = await deps.db
      .select({ custodyTakenAt: users.custodyTakenAt, anchorAddress: users.anchorAddress })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)

    if (!user?.custodyTakenAt || !user.anchorAddress) {
      return reply.status(409).send({
        error: 'not_self_custody',
        message: 'We hold your key, so we sign your anchors. There is nothing for you to sign.',
      })
    }

    const [snapshot] = await deps.db
      .select({
        id: snapshots.id,
        rootHashes: snapshots.rootHashes,
        schemaVersion: snapshots.schemaVersion,
        anchorTxHash: snapshots.anchorTxHash,
      })
      .from(snapshots)
      // Scoped to this user. A signature is only ever valid for their own
      // snapshot, and looking one up by id alone would let anybody probe for
      // the existence of somebody else's.
      .where(and(eq(snapshots.id, id), eq(snapshots.userId, userId)))
      .limit(1)

    if (!snapshot) return reply.status(404).send({ error: 'not_found' })
    if (snapshot.anchorTxHash) return reply.status(409).send({ error: 'already_anchored' })

    if (body.deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      return reply.status(400).send({
        error: 'expired',
        message: 'That signature has already expired. Sign again.',
      })
    }

    /*
     * Verified with the same code that signs, imported rather than restated.
     * The first version of this route wrote the domain and the type definition
     * out again and named the struct `Anchor` instead of `AnchorSnapshot`, so
     * it rejected every honest signature as a forgery — a hand-maintained
     * mirror of an authoritative definition, which is the defect that has
     * accounted for most of the bugs in this repository.
     */
    const recovered = recoverAnchorSigner(deps.anchorAddress, deps.chainId, {
      rootHashes: snapshot.rootHashes,
      schemaVersion: snapshot.schemaVersion,
      nonce: nonceFor(snapshot.id),
      deadline: body.deadline,
      signature: body.signature,
    })

    if (recovered.toLowerCase() !== user.anchorAddress.toLowerCase()) {
      return reply.status(400).send({
        error: 'wrong_signer',
        message: 'That signature is not from the key that owns these records.',
      })
    }

    await deps.db
      .update(snapshots)
      .set({ ownerSignature: body.signature, signatureDeadline: body.deadline })
      .where(eq(snapshots.id, id))

    return reply.status(200).send({ ok: true })
  })
}
