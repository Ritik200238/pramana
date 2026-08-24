# Threat model — HealthRecordAnchor

Required by `CLAUDE.md` before mainnet. Written to be falsifiable: every claim
states what it does **not** protect against.

## What the contract holds

Only content-addressed 0G Storage root hashes, a schema version, a timestamp,
and a grant map. **No plaintext, no PII, no keys, no ciphertext.**

Everything written here is permanent and world-readable. That is the reason the
payload is restricted to hashes: a root hash reveals nothing about its contents,
but anything else written here could never be taken back.

## Trust model

| Actor | Can | Cannot |
|---|---|---|
| **Record owner** | Anchor their own snapshots; grant and revoke access to them | Touch anyone else's history |
| **Grantee (e.g. a doctor)** | Be authorised to read snapshots up to a pinned index | Anchor, grant, or revoke anything |
| **Admin / pauser** | Pause and unpause anchoring | Read, write, grant, or revoke any user's record |
| **Backend** | Pay for 0G Storage writes | Anchor on a user's behalf — there is no operator path |
| **Anyone** | Read the hash and grant maps | Decrypt anything without the user's private key |

The absence of an operator path is deliberate and tested
(`test_attackerCannotAnchorForSomeoneElse`, `test_adminHasNoAuthorityOverUserRecords`).
If we could anchor for a user, we could also anchor something they did not author,
and the ownership claim would be marketing rather than architecture.

## Threats considered

### Unauthorised writes to another user's record
**Mitigated.** Every write is keyed on `msg.sender`. There is no delegated or
administrative write path anywhere in the contract.

### Privilege escalation via the admin role
**Mitigated by scope.** `PAUSER_ROLE` gates only `pause`/`unpause`.
`DEFAULT_ADMIN_ROLE` can manage roles but grants no data authority — there is no
function an admin can call that reads or alters user records.

### Unbounded loops / gas griefing
**Mitigated.** `MAX_GRANTS_PER_CALL = 32` and `MAX_FRAGMENTS = 64` bound both
caller-supplied arrays. A caller cannot construct a transaction that fails for
everyone by exhausting block gas.

### Reentrancy
**Not applicable.** The contract makes no external calls and holds no value.
There is nothing to re-enter. No guard is present because adding one would
imply a risk that does not exist here.

### Grant creep — a share today exposing data logged later
**Mitigated.** Grants pin to the snapshot index current at grant time rather
than being open-ended. Tested directly
(`test_grantDoesNotExtendToFutureSnapshots`, `testFuzz_grantNeverLeaksFutureSnapshots`).

### Silent history rewriting
**Mitigated.** Snapshots are append-only. There is no update or delete path, so
a record has a verifiable timeline rather than a mutable current value.

### Empty or malformed anchors
**Mitigated.** Zero-length fragment lists and zero root hashes revert. An anchor
that cannot retrieve anything is worse than no anchor, because it looks like a
backup.

### Pause used to trap users
**Mitigated.** `revokeAccess` and all reads work while paused. A user
withdrawing access during an incident is precisely when they most need it to
work, so pausing deliberately cannot block it.

## What this contract does NOT protect against — stated plainly

1. **Revocation cannot retract what was already read.** Removing a grant emits a
   public revocation and blocks future authorisation. It cannot un-share bytes a
   grantee already downloaded, or a decryption key they already hold. No
   contract can. The product's user-facing copy must say this too; claiming
   otherwise would be a promise the chain cannot keep.

2. **Anchoring does not prove the payload is genuine.** It proves *this address
   committed to this hash at this time*. A user can anchor a hash for data that
   is wrong, or for nothing at all.

3. **Encryption strength lives off-chain.** Confidentiality comes from ECIES to
   the user's key in 0G Storage. If that key leaks, the anchor is irrelevant.

4. **Metadata is public.** Anyone can see how often an address anchors and who
   it grants to. That is a real privacy leak at the pattern level, mitigated
   only by addresses not being linked to identities on-chain.

5. **Timestamps are miner-influenced.** `block.timestamp` is good to a few
   seconds, not a legal record.

## Pre-mainnet checklist

- [x] 100% line, statement, branch, and function coverage
- [x] Fuzz tests on grant windows and arbitrary root hashes (512 runs each)
- [x] Adversarial tests for every unauthorised path
- [x] Custom errors throughout; events on every state change
- [x] Compiler warnings treated as errors (`deny = "warnings"`)
- [x] Bounded loops on all caller-supplied arrays
- [x] Deploy script refuses unrecognised chain ids and verifies roles post-deploy
- [ ] **External review by someone who did not write this** — not yet done
- [ ] Admin key held in a multisig, not an EOA — decision pending
- [ ] Testnet soak with real snapshot volumes

The last three are open. Until they are closed, this is reviewed code, not
audited code, and should be described that way.
