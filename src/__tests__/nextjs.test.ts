import { describe, it, expect, beforeEach, vi, Mock } from 'vitest'

// Mock x402-solana before importing
vi.mock('x402-solana/server', () => ({
  X402PaymentHandler: vi.fn().mockImplementation(() => ({
    createPaymentRequirements: vi.fn().mockResolvedValue({
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '100000',
      payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
      maxTimeoutSeconds: 300,
      asset: 'So11111111111111111111111111111111111111112',
      extra: {},
    }),
    create402Response: vi.fn().mockReturnValue({
      status: 402,
      body: { x402Version: 2, accepts: [], resource: {} },
    }),
    extractPayment: vi.fn().mockImplementation((headers) => {
      return headers['payment-signature'] || headers['PAYMENT-SIGNATURE'] || null
    }),
    verifyPayment: vi.fn().mockResolvedValue({ isValid: true }),
    settlePayment: vi.fn().mockResolvedValue({ success: true, transaction: 'tx-sig' }),
  })),
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
