/**
 * @ogt/og — the 0G integration layer.
 *
 * Compute (Router) for inference, Storage for the user-owned encrypted record.
 * Both are load-bearing rather than decorative: Router pricing is what makes a
 * free tier affordable at Indian price points, and TEE attestation is what
 * turns "we cannot read your health data" into a provable claim.
 */

export {
  CHAINS,
  MODELS,
  assertAllChainsAreTeeAttested,
  type ModelSpec,
  type TaskName,
} from './models.ts'

export {
  OGRouterError,
  ROUTER_BASE_URL,
  complete,
  createClient,
  stripFences,
  type CompleteOptions,
  type CompleteResult,
  type RouterConfig,
  type Usage,
} from './router.ts'

export {
  describeReceipt,
  isProvable,
  isTrustworthy,
  readReceipt,
  type AttestationReceipt,
  type Trace,
} from './attestation.ts'

export {
  InsufficientBalanceError,
  NEURON_PER_OG,
  PAYMENT_LAYER,
  estimateCostNeuron,
  estimateDaysRemaining,
  formatOg,
  isInsufficientBalance,
  parseOg,
  readBalance,
  type Balance,
} from './payments.ts'

export {
  NETWORKS,
  OGStorage,
  publicKeyFor,
  type NetworkConfig,
  type SnapshotResult,
  type StorageConfig,
} from './storage.ts'

export {
  ANCHOR_ABI,
  AnchorClient,
  deriveOwnerAccount,
  signAnchor,
  SIGNATURE_TTL_SECONDS,
  type AnchorClientConfig,
  type AnchorRequest,
  type AnchorResult,
  type SignedAnchor,
} from './anchor.ts'

export {
  COACH_ABI,
  COACH_SIGNATURE_TTL_SECONDS,
  CoachClient,
  brainMetadataHash,
  type CoachClientConfig,
  type EvolveResult,
  type MintResult,
} from './coach-agent.ts'
