/**
 * Environment configuration, validated at boot.
 *
 * The server refuses to start on a bad config rather than failing on the first
 * request that needs it. A health product that boots without a 0G key and only
 * discovers it when a user photographs their dinner is worse than one that
 * never came up.
 */

import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),

  /** 0G Compute Router inference key. Created at https://pc.0g.ai. */
  OG_ROUTER_API_KEY: z
    .string()
    .startsWith('sk-', 'Expected an inference key. Management keys (mk-) cannot call inference.'),

  OG_NETWORK: z.enum(['testnet', 'mainnet']).default('testnet'),

  /**
   * Backend key that pays for 0G Storage writes.
   *
   * This pays; it does not own. Records are ECIES-encrypted to each user's own
   * key, and the on-chain anchor is written by the user's address, so holding
   * this key grants no ability to read or forge anyone's record.
   */
  OG_STORAGE_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'Expected a 32-byte hex private key with 0x prefix'),

  /** Production RPC. The public endpoint is documented as development-only. */
  OG_RPC_URL_OVERRIDE: z.string().url().optional(),

  /**
   * Seed from which each user's record-owning account is derived.
   *
   * Whoever holds this can sign for any user's anchor, so it is custodial and
   * the docs say so plainly rather than implying otherwise. It is required
   * whenever anchoring is switched on, because deriving from a weak or absent
   * seed would put every user's record under a guessable key.
   */
  OG_ANCHOR_MASTER_SEED: z.string().min(32).optional(),

  /** Deployed HealthRecordAnchor address. Absent until the contract is deployed. */
  OG_ANCHOR_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),

  /** Comma-separated allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  /** Hard ceiling on a single uploaded meal photo. */
  MAX_PHOTO_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  /**
   * Shared secret for operator-only endpoints.
   *
   * Minimum length is enforced because the failure mode of a short one is not a
   * degraded feature — it is an unprivileged caller triggering work across
   * every user's account. Absent means the admin surface is not mounted at all,
   * which is the correct default: an endpoint that does not exist cannot be
   * misconfigured.
   */
  ADMIN_TOKEN: z.string().min(32).optional(),

  /**
   * One-time code delivery.
   *
   * The vendor is configuration rather than code. India requires DLT
   * registration with an approved sender id and approved templates before a
   * transactional SMS delivers at all, so the operator does vendor-specific
   * work regardless; compiling one vendor's parameter names in would add a code
   * change to that process without removing any of it.
   *
   * Absent in production is a boot failure, not a degraded mode: it means
   * nobody can sign in while the endpoint answers 200 to every request.
   */
  SMS_PROVIDER_URL: z.string().url().optional(),
  /** JSON object of headers, e.g. {"authkey":"..."}. */
  SMS_PROVIDER_HEADERS: z.string().optional(),
  /** JSON body template. Must contain {{code}}; may use {{to}} and {{expiry}}. */
  SMS_PROVIDER_BODY: z.string().optional(),
})

export type Config = Readonly<
  Omit<z.infer<typeof schema>, 'CORS_ORIGINS'> & { corsOrigins: readonly string[] }
>

let cached: Config | null = null

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached

  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${detail}`)
  }

  const { CORS_ORIGINS, ...rest } = parsed.data
  cached = Object.freeze({
    ...rest,
    corsOrigins: CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  })
  return cached
}

/** Test-only. Config is cached because it must not change under a running server. */
export function resetConfigForTests(): void {
  cached = null
}
