import { PublicKey } from '@solana/web3.js'

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
  /** SPL Token mint address for payments (optional, defaults to SOL) */
  splToken?: string | PublicKey
  /** Network: 'mainnet-beta' | 'devnet' | 'testnet' */
  network?: 'mainnet-beta' | 'devnet' | 'testnet'
  /** Label for the payment (appears in wallet) */
  label?: string
  /** Custom message or memo for the payment */
  message?: string
  /** Enable automatic settlement via facilitator (default: true) */
  autoSettle?: boolean
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
 * x402 payment challenge (HTTP 402 response)
 * Note: Using any type here as x402-solana handles this internally
 */
export type X402Challenge = any

/**
 * x402 payment proof (submitted by client)
 * Note: Using any type here as x402-solana handles this internally
 */
export type X402PaymentProof = any

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
