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

  let responseBody: Record<string, unknown>
  let solanaPayData: { url: string; reference: string }

  if (bridge.isMultiToken()) {
    const { paymentRequirements, solanaPayUrl } = await bridge.createMultiTokenPaymentChallenge(
      paymentRequest,
      resource
    )
    const response402 = bridge.create402ResponseMultiToken(paymentRequirements, resource)
    responseBody = response402.body
    solanaPayData = { url: solanaPayUrl.url, reference: solanaPayUrl.reference.toString() }
  } else {
    const { paymentRequirements, solanaPayUrl } = await bridge.createPaymentChallenge(
      paymentRequest,
      resource
    )
    const response402 = bridge.create402Response(paymentRequirements, resource)
    responseBody = response402.body
    solanaPayData = { url: solanaPayUrl.url, reference: solanaPayUrl.reference.toString() }
  }

  // x402 v2 spec: set PAYMENT-REQUIRED header (base64-encoded payment requirements)
  const paymentRequiredHeader = Buffer.from(JSON.stringify(responseBody)).toString('base64')
  res.setHeader('PAYMENT-REQUIRED', paymentRequiredHeader)

  res.status(402).json({
    ...responseBody,
    solanaPay: solanaPayData,
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

  let paymentRequirements: PaymentRequirements

  if (bridge.isMultiToken()) {
    paymentRequirements = await resolveMultiTokenRequirements(
      bridge, options, paymentHeader, amount, resource
    )
  } else {
    const decimals = options.splToken?.decimals ?? 9
    const tokenAddress = options.splToken
      ? (typeof options.splToken.mint === 'string' ? options.splToken.mint : options.splToken.mint.toString())
      : 'So11111111111111111111111111111111111111112'

    const routeConfig = {
      amount,
      asset: { address: tokenAddress, decimals },
      description: options.label || 'Payment',
    }

    paymentRequirements = await bridge.getX402Handler().createPaymentRequirements(routeConfig, resource) as PaymentRequirements
  }

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

async function resolveMultiTokenRequirements(
  bridge: SolanaPayX402Bridge,
  options: ExpressMiddlewareOptions,
  paymentHeader: string,
  baseAmount: string,
  resource: string
): Promise<PaymentRequirements> {
  // Extract which token the client chose from the v2 payload's accepted field
  let acceptedAsset: string | undefined
  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
    if (decoded.x402Version === 2 && decoded.accepted) {
      acceptedAsset = decoded.accepted.asset
    }
  } catch {
    // Fall through to first-token fallback
  }

  const tokens = options.acceptedTokens || []

  let matchedToken = tokens.find(t => {
    const mint = typeof t.mint === 'string' ? t.mint : t.mint.toString()
    return mint === acceptedAsset
  })

  // Fallback to first token if no match (e.g., Solana Pay flow)
  if (!matchedToken && tokens.length > 0) {
    matchedToken = tokens[0]
  }

  if (!matchedToken) {
    throw new Error('No accepted tokens configured')
  }

  const mintStr = typeof matchedToken.mint === 'string' ? matchedToken.mint : matchedToken.mint.toString()

  // Resolve amount for this specific token (supports async converters)
  let tokenAmount = baseAmount
  if (matchedToken.amount) {
    if (typeof matchedToken.amount === 'function') {
      const result = await matchedToken.amount(baseAmount)
      tokenAmount = typeof result === 'number' ? result.toString() : result
    } else {
      tokenAmount = typeof matchedToken.amount === 'number'
        ? matchedToken.amount.toString()
        : matchedToken.amount
    }
  }

  const routeConfig = {
    amount: tokenAmount,
    asset: { address: mintStr, decimals: matchedToken.decimals },
    description: options.label || 'Payment',
  }

  return bridge.getX402Handler().createPaymentRequirements(routeConfig, resource) as Promise<PaymentRequirements>
}

/**
 * Extract payment info from request after verification
 */
export function getPaymentInfo(req: Request): PaymentVerification | undefined {
  return (req as Request & { solanaPayment?: PaymentVerification }).solanaPayment
}
