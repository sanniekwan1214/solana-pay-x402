import { SolanaPayX402Bridge } from '../core/bridge'
import type { PaymentRequirements } from 'x402-solana/types'
import type {
  SolanaPayX402Config,
  PaymentRequest,
  PaymentVerification,
} from '../types'

export interface NextJsMiddlewareOptions extends SolanaPayX402Config {
  /** Return null/undefined/0 to skip payment for this request */
  getPaymentAmount: (req: Request) => number | string | null | Promise<number | string | null>
  getPaymentMetadata?: (req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>
  getReference?: (req: Request) => string | Promise<string>
  /**
   * Called after successful payment verification — BEFORE settlement. In the x402 v2
   * flow funds have not moved yet at this point, so use it for logging/metrics only;
   * treat the protected handler running (blocking mode) or a populated
   * `settlementSignature` as the "actually paid" signal.
   */
  onPaymentVerified?: (req: Request, verification: PaymentVerification) => void | Promise<void>
  onPaymentFailed?: (req: Request, error: string) => void | Promise<void>
  /**
   * Called when facilitator settlement (x402 v2 flow) fails, either in blocking mode
   * (before the 402 settlement-failure response is sent) or in async mode (after the
   * handler has already run).
   */
  onSettlementFailed?: (req: Request, error: string) => void | Promise<void>
}

export interface PaymentContext {
  payment?: PaymentVerification
}

type RouteHandler = (req: Request, ctx: PaymentContext) => Promise<Response> | Response

/**
 * Next.js App Router wrapper for Solana Pay + x402 integration
 *
 * @example
 * ```typescript
 * // app/api/content/route.ts
 * import { withSolanaPay402 } from 'solana-pay-x402/nextjs'
 *
 * export const GET = withSolanaPay402(async (req, { payment }) => {
 *   return Response.json({ data: 'premium content', payment })
 * }, {
 *   rpcUrl: process.env.SOLANA_RPC_URL!,
 *   recipient: process.env.MERCHANT_WALLET!,
 *   getPaymentAmount: () => 100000,
 * })
 * ```
 */
export function withSolanaPay402(handler: RouteHandler, options: NextJsMiddlewareOptions) {
  const bridge = new SolanaPayX402Bridge(options)

  return async (req: Request): Promise<Response> => {
    try {
      // Convert Headers to plain object for bridge.extractPayment()
      const headersObj: Record<string, string> = {}
      req.headers.forEach((value, key) => {
        headersObj[key] = value
      })

      const paymentHeader = bridge.extractPayment(headersObj)

      if (paymentHeader) {
        return await handlePaymentVerification(bridge, options, handler, req, paymentHeader)
      }

      const amount = await options.getPaymentAmount(req)

      if (!amount || amount === 0) {
        return handler(req, {})
      }

      return await sendPaymentChallenge(bridge, options, req, amount)

    } catch (error) {
      return Response.json(
        { error: 'Payment processing error', message: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      )
    }
  }
}

async function sendPaymentChallenge(
  bridge: SolanaPayX402Bridge,
  options: NextJsMiddlewareOptions,
  req: Request,
  amount: number | string
): Promise<Response> {
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

  const url = new URL(req.url)
  const resource = `${url.origin}${url.pathname}`

  let responseBody: Record<string, unknown>
  let solanaPayData: { url: string; reference: string }

  if (bridge.isMultiToken()) {
    const { paymentRequirements, solanaPayUrl } = await bridge.createMultiTokenPaymentChallenge(
      paymentRequest, resource
    )
    const response402 = bridge.create402ResponseMultiToken(paymentRequirements, resource)
    responseBody = response402.body
    solanaPayData = { url: solanaPayUrl.url, reference: solanaPayUrl.reference.toString() }
  } else {
    const { paymentRequirements, solanaPayUrl } = await bridge.createPaymentChallenge(
      paymentRequest, resource
    )
    const response402 = bridge.create402Response(paymentRequirements, resource)
    responseBody = response402.body
    solanaPayData = { url: solanaPayUrl.url, reference: solanaPayUrl.reference.toString() }
  }

  const paymentRequiredHeader = Buffer.from(JSON.stringify(responseBody)).toString('base64')

  return new Response(JSON.stringify({ ...responseBody, solanaPay: solanaPayData }), {
    status: 402,
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-REQUIRED': paymentRequiredHeader,
    },
  })
}

async function handlePaymentVerification(
  bridge: SolanaPayX402Bridge,
  options: NextJsMiddlewareOptions,
  handler: RouteHandler,
  req: Request,
  paymentHeader: string
): Promise<Response> {
  const expectedAmount = await options.getPaymentAmount(req)

  if (!expectedAmount) {
    return Response.json(
      { error: 'Payment not required for this request' },
      { status: 400 }
    )
  }

  const amount = typeof expectedAmount === 'string'
    ? expectedAmount
    : expectedAmount.toString()

  const url = new URL(req.url)
  const resource = `${url.origin}${url.pathname}`

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

    return Response.json(
      { error: 'Payment verification failed', message: verification.error, signature: verification.signature },
      { status: 402 }
    )
  }

  if (options.onPaymentVerified) {
    await options.onPaymentVerified(req, verification)
  }

  if (options.settlementMode === 'async') {
    // Fire-and-forget settlement (legacy behavior) - don't delay the response.
    // Still observable via onSettlementFailed; errors are swallowed here so nothing
    // rejects unhandled.
    void bridge.settlePayment(paymentHeader, paymentRequirements)
      .then(async (settlement) => {
        if (settlement.status === 'settled') {
          if (settlement.signature) verification.settlementSignature = settlement.signature
        } else if (settlement.status === 'failed' && options.onSettlementFailed) {
          await options.onSettlementFailed(req, settlement.error)
        }
      })
      .catch(() => {})

    return handler(req, { payment: verification })
  }

  // Blocking (default): await facilitator settlement before running the protected handler,
  // so a settlement failure never leaves content served without funds having moved.
  const settlement = await bridge.settlePayment(paymentHeader, paymentRequirements)

  if (settlement.status === 'failed') {
    // No funds moved and no content served — release the replay claim so the client
    // can retry the identical signed transaction (the only double-payment-safe retry).
    await bridge.releaseReplayProtection(paymentHeader)

    if (options.onSettlementFailed) {
      await options.onSettlementFailed(req, settlement.error)
    }

    return Response.json(
      { error: 'Payment settlement failed', message: settlement.error },
      { status: 402 }
    )
  }

  if (settlement.status === 'settled' && settlement.signature) {
    verification.settlementSignature = settlement.signature
  }

  return handler(req, { payment: verification })
}

async function resolveMultiTokenRequirements(
  bridge: SolanaPayX402Bridge,
  options: NextJsMiddlewareOptions,
  paymentHeader: string,
  baseAmount: string,
  resource: string
): Promise<PaymentRequirements> {
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

  if (!matchedToken && tokens.length > 0) {
    matchedToken = tokens[0]
  }

  if (!matchedToken) {
    throw new Error('No accepted tokens configured')
  }

  const mintStr = typeof matchedToken.mint === 'string' ? matchedToken.mint : matchedToken.mint.toString()

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
