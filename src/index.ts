/**
 * Solana Pay x402 - Bridge between Solana Pay and x402 HTTP Payment Protocol
 *
 * This package provides middleware to easily integrate Solana Pay payments
 * into your Express.js applications using the x402 HTTP payment standard.
 *
 * @packageDocumentation
 */

export { SolanaPayX402Bridge } from './core/bridge'
export type {
  SolanaPayX402Config,
  PaymentRequest,
  SolanaPayUrl,
  X402Challenge,
  X402PaymentProof,
  PaymentVerification,
} from './types'

// Re-export Express middleware (users can also import from /express)
export { solanaPay402, getPaymentInfo } from './express'
export type { ExpressMiddlewareOptions } from './express'
