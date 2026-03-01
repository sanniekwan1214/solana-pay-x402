import type { Request, Response, NextFunction } from 'express'
import { SolanaPayX402Bridge } from '../core/bridge'
import type { PaymentRequirements } from 'x402-solana/types'
import type {
  SolanaPayX402Config,
  PaymentRequest,
  PaymentVerification,
} from '../types'

export interface ExpressMiddlewareOptions extends SolanaPayX402Config {
  /**
   * Function to determine payment amount for a request
   * Return null/undefined to skip payment for this request
   */
  getPaymentAmount: (req: Request) => number | string | null | Promise<number | string | null>

  /**
   * Custom payment metadata
   */
  getPaymentMetadata?: (req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>

  /**
   * Custom reference generator
   */
  getReference?: (req: Request) => string | Promise<string>

  /**
   * Called after successful payment verification
   */
  onPaymentVerified?: (req: Request, verification: PaymentVerification) => void | Promise<void>

  /**
   * Called when payment fails
   */
  onPaymentFailed?: (req: Request, error: string) => void | Promise<void>
}

/**
 * Express middleware for Solana Pay + x402 integration
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
      res.status(500).json({
        error: 'Payment processing error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }
}

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

  // Use path only (without query params) to avoid mismatch between challenge and verification
  const resource = `${req.protocol}://${req.get('host')}${req.path}`

  const { paymentRequirements, solanaPayUrl } = await bridge.createPaymentChallenge(
    paymentRequest,
    resource
  )

  const response402 = bridge.create402Response(paymentRequirements, resource)

  // x402 v2 spec: set PAYMENT-REQUIRED header (base64-encoded payment requirements)
  const paymentRequiredHeader = Buffer.from(JSON.stringify(response402.body)).toString('base64')
  res.setHeader('PAYMENT-REQUIRED', paymentRequiredHeader)

  res.status(402).json({
    ...response402.body,
    solanaPay: {
      url: solanaPayUrl.url,
      reference: solanaPayUrl.reference.toString(),
    },
  })
}

async function handlePaymentVerification(
  bridge: SolanaPayX402Bridge,
  options: ExpressMiddlewareOptions,
  req: Request,
  res: Response,
  next: NextFunction,
  paymentHeader: string
) {
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

  const resource = `${req.protocol}://${req.get('host')}${req.path}`

  const decimals = options.splToken?.decimals ?? 9
  const tokenAddress = options.splToken
    ? (typeof options.splToken.mint === 'string' ? options.splToken.mint : options.splToken.mint.toString())
    : 'So11111111111111111111111111111111111111112'

  const routeConfig = {
    amount,
    asset: { address: tokenAddress, decimals },
    description: options.label || 'Payment',
  }

  const paymentRequirements = await bridge.getX402Handler().createPaymentRequirements(routeConfig, resource) as PaymentRequirements

  const verification = await bridge.verifyPayment(paymentHeader, paymentRequirements)

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

  (req as Request & { solanaPayment: PaymentVerification }).solanaPayment = verification

  // Settlement is non-blocking - don't delay response
  bridge.settlePayment(paymentHeader, paymentRequirements).then((sig) => {
    if (sig) verification.settlementSignature = sig
  }).catch(() => {})

  next()
}

/**
 * Extract payment info from request after verification
 */
export function getPaymentInfo(req: Request): PaymentVerification | undefined {
  return (req as Request & { solanaPayment?: PaymentVerification }).solanaPayment
}
