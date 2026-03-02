/**
 * Next.js App Router adapter for Solana Pay + x402 integration
 *
 * @example
 * ```typescript
 * // app/api/content/route.ts
 * import { withSolanaPay402 } from 'solana-pay-x402/nextjs'
 *
 * export const GET = withSolanaPay402(async (req, { payment }) => {
 *   return Response.json({
 *     data: 'Premium content',
 *     payment: { signature: payment?.signature },
 *   })
 * }, {
 *   rpcUrl: process.env.SOLANA_RPC_URL!,
 *   recipient: process.env.MERCHANT_WALLET!,
 *   getPaymentAmount: () => 100000, // 0.10 USDC
 * })
 * ```
 */

export { withSolanaPay402 } from './middleware'
export type { NextJsMiddlewareOptions, PaymentContext } from './middleware'
