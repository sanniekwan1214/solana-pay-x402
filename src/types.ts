import { PublicKey } from '@solana/web3.js'

/**
 * Store for tracking used payment signatures to prevent replay attacks
 */
export interface SignatureStore {
  has(signature: string): Promise<boolean> | boolean
  add(signature: string, ttlMs?: number): Promise<void> | void
  /**
   * Atomically add the signature only if absent, returning true when it was added
   * (claimed) and false when it was already present (replay). Custom stores should
   * implement this (e.g. Redis SET NX) — without it the bridge falls back to a
   * non-atomic has()+add(), which leaves a small window where concurrent requests
   * carrying the same payment header can both pass the replay check.
   */
  addIfAbsent?(signature: string, ttlMs?: number): Promise<boolean> | boolean
  /**
   * Remove a signature. Used to release a claimed v2 payment header when
   * verification or blocking settlement fails (no funds moved, no content served),
   * so the client can safely retry the identical signed transaction. Without it,
   * a transient facilitator failure permanently burns the header for the TTL.
   */
  delete?(signature: string): Promise<void> | void
}

/**
 * In-memory signature store (use Redis or database in production)
 */
export class InMemorySignatureStore implements SignatureStore {
  private signatures = new Map<string, number>()
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(cleanupIntervalMs = 60000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs)
  }

  has(signature: string): boolean {
    return this.signatures.has(signature)
  }

  add(signature: string, ttlMs = 3600000): void {
    this.signatures.set(signature, Date.now() + ttlMs)
  }

  addIfAbsent(signature: string, ttlMs = 3600000): boolean {
    if (this.signatures.has(signature)) {
      return false
    }
    this.signatures.set(signature, Date.now() + ttlMs)
    return true
  }

  delete(signature: string): void {
    this.signatures.delete(signature)
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [sig, expiry] of this.signatures) {
      if (expiry < now) {
        this.signatures.delete(sig)
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

/**
 * SPL token configuration with decimals
 */
export interface SplTokenConfig {
  mint: string | PublicKey
  decimals: number
}

/**
 * Configuration for a single accepted token with its price
 */
export interface AcceptedTokenConfig {
  /** Token mint address */
  mint: string | PublicKey
  /** Token decimals */
  decimals: number
  /** Fixed amount in atomic units, or converter: (baseAmount) => tokenAmount.
   *  The converter can be async (e.g. to fetch live exchange rates). */
  amount?: number | string | ((baseAmount: number | string) => number | string | Promise<number | string>)
  /** Human label, e.g. "USDC", "SOL" */
  label?: string
}

/**
 * Configuration for Solana Pay x402 integration
 */
export interface SolanaPayX402Config {
  /** Solana RPC endpoint URL */
  rpcUrl: string
  /** Merchant's Solana wallet address to receive payments */
  recipient: string | PublicKey
  /** x402 facilitator API endpoint (default: https://facilitator.payai.network) */
  facilitatorUrl?: string
  /** SPL Token configuration (optional, defaults to SOL) */
  splToken?: SplTokenConfig
  /** Network: 'mainnet-beta' | 'devnet' | 'testnet' */
  network?: 'mainnet-beta' | 'devnet' | 'testnet'
  /** Label for the payment (appears in wallet) */
  label?: string
  /** Custom message or memo for the payment */
  message?: string
  /** Enable automatic settlement via facilitator (default: true) */
  autoSettle?: boolean
  /**
   * Controls whether facilitator settlement (x402 v2 flow) blocks the response.
   * - 'blocking' (default): await facilitator settlement before running the protected
   *   handler. If settlement fails, the request is rejected with a 402 instead of the
   *   handler ever running — funds and content stay in sync.
   * - 'async': fire-and-forget settlement (legacy behavior). The handler runs immediately
   *   after verification, and settlement failures are only observable via `onSettlementFailed`.
   */
  settlementMode?: 'blocking' | 'async'
  /** Signature store for replay attack prevention */
  signatureStore?: SignatureStore
  /** Accept multiple tokens. First entry is primary (used for Solana Pay QR).
   *  Takes precedence over splToken when set. */
  acceptedTokens?: AcceptedTokenConfig[]
}

/**
 * Payment request details
 */
export interface PaymentRequest {
  /** Amount in token units (e.g., lamports for SOL, or token decimals) */
  amount: string | number
  /** Optional reference ID for tracking this payment */
  reference?: string
  /** Optional label override for this specific payment */
  label?: string
  /** Optional memo for this specific payment */
  memo?: string
  /** Metadata to attach to the payment */
  metadata?: Record<string, unknown>
}

/**
 * Solana Pay URL components
 */
export interface SolanaPayUrl {
  /** The complete solana: URL */
  url: string
  /** The reference public key for tracking */
  reference: PublicKey
  /** QR code data (base64 or URL) */
  qrCode?: string
}

/**
 * Re-export PaymentRequirements from x402-solana v2
 */
export type { PaymentRequirements } from 'x402-solana/types'

/**
 * Payment verification result
 */
export interface PaymentVerification {
  /** Whether the payment is valid */
  valid: boolean
  /** Transaction signature */
  signature: string
  /** Amount paid (in smallest unit) */
  amount?: number
  /** Sender's wallet address */
  sender?: string
  /** Error message if invalid */
  error?: string
  /** Metadata from the payment */
  metadata?: Record<string, unknown>
  /** Settlement transaction signature (if auto-settled) */
  settlementSignature?: string
}

/**
 * Result of a settlement attempt.
 * - 'settled': funds moved (or, for Solana Pay, were already on-chain). `signature` may be
 *   null if the facilitator did not return a transaction signature.
 * - 'skipped': settlement was not attempted because `autoSettle` is disabled.
 * - 'failed': settlement was attempted but did not succeed.
 */
export type SettlementResult =
  | { status: 'settled'; signature: string | null }
  | { status: 'skipped' }
  | { status: 'failed'; error: string }
