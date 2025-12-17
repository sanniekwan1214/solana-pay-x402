/**
 * Express middleware for Solana Pay + x402 integration
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { solanaPay402 } from 'solana-pay-x402/express'
 *
 * const app = express()
 *
 * // Protect a route with payment requirement
 * app.get('/api/premium-content',
 *   solanaPay402({
 *     rpcUrl: process.env.SOLANA_RPC_URL,
 *     recipient: process.env.MERCHANT_WALLET,
 *     facilitatorUrl: 'https://facilitator.example.com',
 *     getPaymentAmount: (req) => 0.01 * 1e9, // 0.01 SOL
 *   }),
 *   (req, res) => {
 *     res.json({ content: 'Premium content here!' })
 *   }
 * )
 * ```
 */

export { solanaPay402, getPaymentInfo } from './middleware'
export type { ExpressMiddlewareOptions } from './middleware'
