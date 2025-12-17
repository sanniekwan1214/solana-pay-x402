import type { Request, Response, NextFunction } from 'express'
import { SolanaPayX402Bridge } from '../core/bridge'
import type { SolanaPayX402Config, PaymentRequest } from '../types'

export interface ExpressMiddlewareOptions extends SolanaPayX402Config {
  /**
   * Function to determine payment amount for a request
   * Return null/undefined to skip payment for this request
   */
  getPaymentAmount: (req: Request) => number | string | null | Promise<number | string | null>

  /**
   * Optional: Custom payment metadata
   */
  getPaymentMetadata?: (req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>

  /**
   * Optional: Custom reference generator
   */
  getReference?: (req: Request) => string | Promise<string>

  /**
   * Optional: Called after successful payment verification
   */
  onPaymentVerified?: (req: Request, verification: any) => void | Promise<void>

  /**
   * Optional: Called when payment fails
   */
  onPaymentFailed?: (req: Request, error: string) => void | Promise<void>
}

/**
 * Express middleware for Solana Pay + x402 integration
 *
 * This middleware:
 * 1. Checks if payment is required for the request
 * 2. Returns HTTP 402 with Solana Pay URL if payment needed
 * 3. Verifies payment proof when submitted
 * 4. Allows request through if payment is valid
 *
 * @example
 * ```typescript
 * import express from 'express'
 * import { solanaPay402 } from 'solana-pay-x402/express'
 *
 * const app = express()
 *
 * app.use('/api/premium', solanaPay402({
 *   rpcUrl: process.env.SOLANA_RPC_URL,
 *   recipient: process.env.MERCHANT_WALLET,
 *   getPaymentAmount: (req) => 0.01 * 1e9, // 0.01 SOL in lamports
 * }))
 * ```
 */
export function solanaPay402(options: ExpressMiddlewareOptions) {
  const bridge = new SolanaPayX402Bridge(options)

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const paymentHeader = bridge.extractPayment(req.headers)

      if (paymentHeader) {
        return await handlePaymentVerification(bridge, options, req, res, next, paymentHeader)
      }

      const amount = await options.getPaymentAmount(req)

      if (!amount || amount === 0) {
        return next()
      }

      return await sendPaymentChallenge(bridge, options, req, res, amount)

    } catch (error) {
      console.error('Solana Pay x402 middleware error:', error)
      res.status(500).json({
        error: 'Payment processing error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }
}

/**
 * Send HTTP 402 Payment Required with Solana Pay URL and x402 challenge
 */
async function sendPaymentChallenge(
  bridge: SolanaPayX402Bridge,
  options: ExpressMiddlewareOptions,
  req: Request,
  res: Response,
  amount: number | string
) {
  const reference = options.getReference
    ? await options.getReference(req)
    : undefined

  const metadata = options.getPaymentMetadata
    ? await options.getPaymentMetadata(req)
    : undefined

  const paymentRequest: PaymentRequest = {
    amount,
    reference,
    metadata,
    label: options.label,
    memo: options.message,
  }

  const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`

  const { paymentRequirements, solanaPayUrl } = await bridge.createPaymentChallenge(
    paymentRequest,
    resource
  )

  console.log('[402 Response] Solana Pay URL:', solanaPayUrl.url)
  console.log('[402 Response] Reference:', solanaPayUrl.reference.toString())
  console.log('[402 Response] Amount:', paymentRequest.amount)

  const response402 = bridge.create402Response(paymentRequirements)

  res.status(402).json({
    ...response402.body,
    solanaPay: {
      url: solanaPayUrl.url,
      reference: solanaPayUrl.reference.toString(),
    },
    instructions: {
      step1: 'Open Solana wallet (Phantom, Solflare, etc.)',
      step2: `Scan QR code or use URL: ${solanaPayUrl.url}`,
      step3: 'Approve the payment in your wallet',
      step4: 'Retry request with payment proof in headers',
    },
  })
}

/**
 * Verify payment proof and allow request through if valid
 */
async function handlePaymentVerification(
  bridge: SolanaPayX402Bridge,
  options: ExpressMiddlewareOptions,
  req: Request,
  res: Response,
  next: NextFunction,
  paymentHeader: any
) {
  try {
    const expectedAmount = await options.getPaymentAmount(req)

    if (!expectedAmount) {
      res.status(400).json({
        error: 'Payment not required for this request',
      })
      return
    }

    const amount = typeof expectedAmount === 'string'
      ? expectedAmount
      : expectedAmount.toString()

    const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`
    const tokenAddress = options.splToken
      ? (typeof options.splToken === 'string' ? options.splToken : options.splToken.toString())
      : undefined

    const priceConfig = tokenAddress
      ? {
          amount,
          asset: { address: tokenAddress, decimals: 9 },
        }
      : {
          amount,
          asset: { address: 'So11111111111111111111111111111111111111112', decimals: 9 },
        }

    const paymentRequirements = await bridge.getX402Handler().createPaymentRequirements({
      price: priceConfig,
      network: options.network === 'devnet' ? 'solana-devnet' : 'solana',
      config: {
        description: options.label || 'Payment',
        resource: resource as `${string}://${string}`,
      },
    })

    console.log('[Payment Verification] Payment header received:', paymentHeader)
    console.log('[Payment Verification] Expected amount:', amount)
    console.log('[Payment Verification] Resource:', resource)

    const verification = await bridge.verifyPayment(paymentHeader, paymentRequirements)

    console.log('[Payment Verification] Verification result:', {
      valid: verification.valid,
      signature: verification.signature,
      amount: verification.amount,
      error: verification.error,
    })

    if (!verification.valid) {
      if (options.onPaymentFailed) {
        await options.onPaymentFailed(req, verification.error || 'Unknown error')
      }

      res.status(402).json({
        error: 'Payment verification failed',
        message: verification.error,
        signature: verification.signature,
      })
      return
    }

    if (options.onPaymentVerified) {
      await options.onPaymentVerified(req, verification)
    }

    const settlementSig = await bridge.settlePayment(paymentHeader, paymentRequirements)
    if (settlementSig) {
      verification.settlementSignature = settlementSig
    }

    (req as any).solanaPayment = verification

    next()

  } catch (error) {
    res.status(400).json({
      error: 'Invalid payment proof',
      message: error instanceof Error ? error.message : 'Unknown error',
    })
  }
}

/**
 * Helper middleware to extract payment info from request
 * Use this after solanaPay402 middleware to access payment details
 */
export function getPaymentInfo(req: Request) {
  return (req as any).solanaPayment as {
    valid: boolean
    signature: string
    amount?: number
    sender?: string
    settlementSignature?: string
  } | undefined
}
