import { describe, it, expect, beforeEach, vi, Mock } from 'vitest'

// Hoisted so individual tests can override verifyPayment/settlePayment behavior
// (e.g. simulate a facilitator settlement failure) while sharing the same mock
// instance across every `new SolanaPayX402Bridge(...)` created in a test.
const x402Mocks = vi.hoisted(() => ({
  createPaymentRequirements: vi.fn(),
  create402Response: vi.fn(),
  extractPayment: vi.fn(),
  verifyPayment: vi.fn(),
  settlePayment: vi.fn(),
}))

// Mock x402-solana before importing
vi.mock('x402-solana/server', () => ({
  X402PaymentHandler: vi.fn().mockImplementation(() => x402Mocks),
}))

vi.mock('@solana/pay', () => ({
  encodeURL: vi.fn().mockReturnValue(new URL('solana:ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8?amount=0.0001')),
}))

import { withSolanaPay402 } from '../nextjs/middleware'
import type { PaymentContext } from '../nextjs/middleware'

describe('withSolanaPay402 (Next.js)', () => {
  const baseOptions = {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    recipient: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
    network: 'mainnet-beta' as const,
    label: 'Test Payment',
    getPaymentAmount: vi.fn().mockReturnValue(100000),
  }

  const mockHandler = vi.fn().mockImplementation((_req: Request, ctx: PaymentContext) => {
    return Response.json({ ok: true, payment: ctx.payment })
  })

  beforeEach(() => {
    vi.clearAllMocks()

    x402Mocks.createPaymentRequirements.mockResolvedValue({
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '100000',
      payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
      maxTimeoutSeconds: 300,
      asset: 'So11111111111111111111111111111111111111112',
      extra: {},
    })
    x402Mocks.create402Response.mockReturnValue({
      status: 402,
      body: { x402Version: 2, accepts: [], resource: {} },
    })
    x402Mocks.extractPayment.mockImplementation((headers) => {
      return headers['payment-signature'] || headers['PAYMENT-SIGNATURE'] || null
    })
    x402Mocks.verifyPayment.mockResolvedValue({ isValid: true })
    x402Mocks.settlePayment.mockResolvedValue({ success: true, transaction: 'tx-sig' })
  })

  function makeRequest(path: string, headers?: Record<string, string>): Request {
    return new Request(`http://localhost:3000${path}`, {
      headers: headers || {},
    })
  }

  describe('payment required flow', () => {
    it('returns 402 when no payment header and amount required', async () => {
      const handler = withSolanaPay402(mockHandler, baseOptions)
      const resp = await handler(makeRequest('/api/test'))

      expect(resp.status).toBe(402)
      const body = await resp.json()
      expect(body.solanaPay).toBeDefined()
      expect(body.solanaPay.url).toContain('solana:')
    })

    it('sets PAYMENT-REQUIRED header on 402 response', async () => {
      const handler = withSolanaPay402(mockHandler, baseOptions)
      const resp = await handler(makeRequest('/api/test'))

      expect(resp.headers.get('PAYMENT-REQUIRED')).toBeTruthy()
    })

    it('calls handler when no payment required (amount is null)', async () => {
      const handler = withSolanaPay402(mockHandler, {
        ...baseOptions,
        getPaymentAmount: vi.fn().mockReturnValue(null),
      })

      const resp = await handler(makeRequest('/api/test'))

      expect(resp.status).toBe(200)
      expect(mockHandler).toHaveBeenCalled()
    })

    it('calls handler when amount is 0', async () => {
      const handler = withSolanaPay402(mockHandler, {
        ...baseOptions,
        getPaymentAmount: vi.fn().mockReturnValue(0),
      })

      const resp = await handler(makeRequest('/api/test'))

      expect(resp.status).toBe(200)
      expect(mockHandler).toHaveBeenCalled()
    })
  })

  describe('payment verification flow', () => {
    const makeV2PaymentHeader = () => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'http://localhost:3000/api/test' },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      },
      payload: { transaction: 'base64-signed-tx' },
    })).toString('base64')

    it('verifies payment and calls handler with payment context', async () => {
      const handler = withSolanaPay402(mockHandler, baseOptions)
      const resp = await handler(makeRequest('/api/test', {
        'payment-signature': makeV2PaymentHeader(),
      }))

      expect(resp.status).toBe(200)
      expect(mockHandler).toHaveBeenCalled()
      // Check handler received payment context
      const ctx = mockHandler.mock.calls[0][1] as PaymentContext
      expect(ctx.payment).toBeDefined()
      expect(ctx.payment?.valid).toBe(true)
    })

    it('blocks on settlement by default and records the settlement signature', async () => {
      const handler = withSolanaPay402(mockHandler, baseOptions)
      const resp = await handler(makeRequest('/api/test', {
        'payment-signature': makeV2PaymentHeader(),
      }))

      expect(x402Mocks.settlePayment).toHaveBeenCalled()
      expect(resp.status).toBe(200)
      const ctx = mockHandler.mock.calls[0][1] as PaymentContext
      expect(ctx.payment?.settlementSignature).toBe('tx-sig')
    })
  })

  describe('settlement failure handling (blocking mode, default)', () => {
    const makeV2PaymentHeader = () => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'http://localhost:3000/api/test' },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      },
      payload: { transaction: 'base64-signed-tx' },
    })).toString('base64')

    it('returns 402 and does not call the handler when facilitator settlement reports failure', async () => {
      x402Mocks.settlePayment.mockResolvedValueOnce({ success: false, errorReason: 'blockhash_expired' })
      const onSettlementFailed = vi.fn()

      const handler = withSolanaPay402(mockHandler, { ...baseOptions, onSettlementFailed })
      const resp = await handler(makeRequest('/api/test', {
        'payment-signature': makeV2PaymentHeader(),
      }))

      expect(resp.status).toBe(402)
      const body = await resp.json()
      expect(body.error).toBe('Payment settlement failed')
      expect(body.message).toBe('blockhash_expired')
      expect(onSettlementFailed).toHaveBeenCalledWith(expect.any(Request), 'blockhash_expired')
      expect(mockHandler).not.toHaveBeenCalled()
    })

    it('returns 402 and does not call the handler when settlePayment rejects', async () => {
      x402Mocks.settlePayment.mockRejectedValueOnce(new Error('facilitator unreachable'))
      const onSettlementFailed = vi.fn()

      const handler = withSolanaPay402(mockHandler, { ...baseOptions, onSettlementFailed })
      const resp = await handler(makeRequest('/api/test', {
        'payment-signature': makeV2PaymentHeader(),
      }))

      expect(resp.status).toBe(402)
      const body = await resp.json()
      expect(body.error).toBe('Payment settlement failed')
      expect(body.message).toBe('facilitator unreachable')
      expect(onSettlementFailed).toHaveBeenCalledWith(expect.any(Request), 'facilitator unreachable')
      expect(mockHandler).not.toHaveBeenCalled()
    })

    it('releases replay protection on settlement failure so the identical header can be retried', async () => {
      x402Mocks.settlePayment.mockResolvedValueOnce({ success: false, errorReason: 'blockhash_expired' })
      const header = makeV2PaymentHeader()

      const handler = withSolanaPay402(mockHandler, baseOptions)
      const failedResp = await handler(makeRequest('/api/test', { 'payment-signature': header }))

      expect(failedResp.status).toBe(402)
      expect(mockHandler).not.toHaveBeenCalled()

      // Same signed transaction retried — the only double-payment-safe retry.
      // Settlement now succeeds (mock default), so the request must go through
      // instead of being rejected as a replay.
      const retryResp = await handler(makeRequest('/api/test', { 'payment-signature': header }))

      expect(retryResp.status).toBe(200)
      expect(mockHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('settlementMode: async', () => {
    const makeV2PaymentHeader = () => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'http://localhost:3000/api/test' },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      },
      payload: { transaction: 'base64-signed-tx' },
    })).toString('base64')

    it('calls the handler immediately and reports settlement failure asynchronously', async () => {
      x402Mocks.settlePayment.mockResolvedValueOnce({ success: false, errorReason: 'blockhash_expired' })
      const onSettlementFailed = vi.fn()

      const handler = withSolanaPay402(mockHandler, {
        ...baseOptions,
        settlementMode: 'async',
        onSettlementFailed,
      })
      const resp = await handler(makeRequest('/api/test', {
        'payment-signature': makeV2PaymentHeader(),
      }))

      // Handler proceeds immediately, before settlement resolves
      expect(resp.status).toBe(200)
      expect(mockHandler).toHaveBeenCalled()
      expect(onSettlementFailed).not.toHaveBeenCalled()

      // Flush microtasks so the fire-and-forget settlement promise resolves
      await new Promise((resolve) => setImmediate(resolve))

      expect(onSettlementFailed).toHaveBeenCalledWith(expect.any(Request), 'blockhash_expired')
    })
  })

  describe('autoSettle: false', () => {
    const makeV2PaymentHeader = () => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'http://localhost:3000/api/test' },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      },
      payload: { transaction: 'base64-signed-tx' },
    })).toString('base64')

    it('calls the handler without calling the facilitator settlePayment', async () => {
      const handler = withSolanaPay402(mockHandler, { ...baseOptions, autoSettle: false })
      const resp = await handler(makeRequest('/api/test', {
        'payment-signature': makeV2PaymentHeader(),
      }))

      expect(resp.status).toBe(200)
      expect(mockHandler).toHaveBeenCalled()
      expect(x402Mocks.settlePayment).not.toHaveBeenCalled()
    })
  })

  describe('v2 replay protection', () => {
    const makeV2PaymentHeader = () => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'http://localhost:3000/api/test' },
      accepted: {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      },
      // Note: this fake transaction payload won't deserialize as a real Solana
      // transaction, so the sha256-of-header fallback replay key is what's
      // exercised here — that's expected for this fixture.
      payload: { transaction: 'base64-signed-tx' },
    })).toString('base64')

    it('rejects the second use of the same v2 payment header with a 402', async () => {
      const handler = withSolanaPay402(mockHandler, baseOptions)
      const header = makeV2PaymentHeader()

      const firstResp = await handler(makeRequest('/api/test', { 'payment-signature': header }))
      expect(firstResp.status).toBe(200)

      const secondResp = await handler(makeRequest('/api/test', { 'payment-signature': header }))
      expect(secondResp.status).toBe(402)
      const body = await secondResp.json()
      expect(body.message).toEqual(expect.stringContaining('already used'))
    })
  })

  describe('callbacks', () => {
    it('calls onPaymentVerified on success', async () => {
      const onPaymentVerified = vi.fn()
      const paymentHeader = Buffer.from(JSON.stringify({
        x402Version: 2,
        resource: { url: 'http://localhost:3000/api/test' },
        accepted: {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          amount: '100000',
          payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
          maxTimeoutSeconds: 300,
          asset: 'So11111111111111111111111111111111111111112',
          extra: {},
        },
        payload: { transaction: 'base64-signed-tx' },
      })).toString('base64')

      const handler = withSolanaPay402(mockHandler, {
        ...baseOptions,
        onPaymentVerified,
      })
      await handler(makeRequest('/api/test', { 'payment-signature': paymentHeader }))

      expect(onPaymentVerified).toHaveBeenCalled()
    })
  })

  describe('multi-token flow', () => {
    const multiTokenOptions = {
      ...baseOptions,
      acceptedTokens: [
        { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, label: 'USDC' },
        { mint: 'So11111111111111111111111111111111111111112', decimals: 9, label: 'SOL' },
      ],
    }

    it('returns 402 with multiple accepts when acceptedTokens configured', async () => {
      const handler = withSolanaPay402(mockHandler, multiTokenOptions)
      const resp = await handler(makeRequest('/api/test'))

      expect(resp.status).toBe(402)
      const body = await resp.json()
      expect(body.accepts).toBeDefined()
      expect(body.solanaPay).toBeDefined()
    })
  })

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      const handler = withSolanaPay402(mockHandler, {
        ...baseOptions,
        getPaymentAmount: vi.fn().mockRejectedValue(new Error('Database error')),
      })

      const resp = await handler(makeRequest('/api/test'))

      expect(resp.status).toBe(500)
      const body = await resp.json()
      expect(body.error).toBe('Payment processing error')
      expect(body.message).toBe('Database error')
    })
  })

  describe('async getPaymentAmount', () => {
    it('supports async getPaymentAmount', async () => {
      const handler = withSolanaPay402(mockHandler, {
        ...baseOptions,
        getPaymentAmount: vi.fn().mockResolvedValue(100000),
      })

      const resp = await handler(makeRequest('/api/test'))

      expect(resp.status).toBe(402)
    })
  })
})
