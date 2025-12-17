import { describe, it, expect, beforeEach, vi, Mock } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

// Mock x402-solana before importing middleware
vi.mock('x402-solana/server', () => ({
  X402PaymentHandler: vi.fn().mockImplementation(() => ({
    createPaymentRequirements: vi.fn().mockResolvedValue({
      scheme: 'exact',
      network: 'solana',
      maxAmountRequired: '100000',
      resource: 'http://localhost:3000/api/test',
      description: 'Test Payment',
      payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
      maxTimeoutSeconds: 300,
      asset: 'So11111111111111111111111111111111111111112',
    }),
    create402Response: vi.fn().mockReturnValue({
      status: 402,
      body: { paymentRequired: true },
      headers: { 'X-Payment-Required': 'true' },
    }),
    extractPayment: vi.fn().mockImplementation((headers) => {
      return headers['x-payment'] || null
    }),
    verifyPayment: vi.fn().mockResolvedValue({ isValid: true }),
    settlePayment: vi.fn().mockResolvedValue({ success: true, transaction: 'tx-sig' }),
  })),
}))

vi.mock('@solana/pay', () => ({
  encodeURL: vi.fn().mockReturnValue(new URL('solana:ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8?amount=0.0001')),
}))

import { solanaPay402, getPaymentInfo } from '../express/middleware'

describe('solanaPay402 middleware', () => {
  const baseOptions = {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    recipient: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
    network: 'mainnet-beta' as const,
    label: 'Test Payment',
    getPaymentAmount: vi.fn().mockReturnValue(100000),
  }

  let mockReq: Partial<Request>
  let mockRes: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    vi.clearAllMocks()

    mockReq = {
      headers: {},
      path: '/api/test',
      protocol: 'http',
      get: vi.fn().mockReturnValue('localhost:3000'),
      params: {},
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    }

    mockNext = vi.fn()
  })

  describe('payment required flow', () => {
    it('returns 402 when no payment header and amount required', async () => {
      const middleware = solanaPay402(baseOptions)

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(402)
      expect(mockRes.json).toHaveBeenCalled()
      const jsonCall = (mockRes.json as Mock).mock.calls[0][0]
      expect(jsonCall.solanaPay).toBeDefined()
      expect(jsonCall.solanaPay.url).toContain('solana:')
    })

    it('calls next() when no payment required (amount is null)', async () => {
      const middleware = solanaPay402({
        ...baseOptions,
        getPaymentAmount: vi.fn().mockReturnValue(null),
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
      expect(mockRes.status).not.toHaveBeenCalled()
    })

    it('calls next() when amount is 0', async () => {
      const middleware = solanaPay402({
        ...baseOptions,
        getPaymentAmount: vi.fn().mockReturnValue(0),
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })

  describe('payment verification flow', () => {
    it('verifies payment and calls next on success', async () => {
      const paymentHeader = Buffer.from(JSON.stringify({
        signature: 'valid-sig',
        scheme: 'exact',
      })).toString('base64')

      mockReq.headers = { 'x-payment': paymentHeader }

      const middleware = solanaPay402(baseOptions)
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })

    it('attaches payment info to request on success', async () => {
      const paymentHeader = Buffer.from(JSON.stringify({
        signature: 'valid-sig',
        scheme: 'exact',
      })).toString('base64')

      mockReq.headers = { 'x-payment': paymentHeader }

      const middleware = solanaPay402(baseOptions)
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      const paymentInfo = getPaymentInfo(mockReq as Request)
      expect(paymentInfo).toBeDefined()
    })
  })

  describe('callbacks', () => {
    it('calls onPaymentVerified callback on success', async () => {
      const onPaymentVerified = vi.fn()
      const paymentHeader = Buffer.from(JSON.stringify({
        signature: 'valid-sig',
        scheme: 'exact',
      })).toString('base64')

      mockReq.headers = { 'x-payment': paymentHeader }

      const middleware = solanaPay402({
        ...baseOptions,
        onPaymentVerified,
      })
      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(onPaymentVerified).toHaveBeenCalled()
    })
  })

  describe('async getPaymentAmount', () => {
    it('supports async getPaymentAmount function', async () => {
      const middleware = solanaPay402({
        ...baseOptions,
        getPaymentAmount: vi.fn().mockResolvedValue(100000),
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(402)
    })
  })

  describe('dynamic pricing based on request', () => {
    it('uses request params for pricing', async () => {
      mockReq.params = { tier: 'premium' }
      const pricing: Record<string, number> = {
        basic: 100000,
        premium: 500000,
      }

      const middleware = solanaPay402({
        ...baseOptions,
        getPaymentAmount: (req) => pricing[req.params.tier] || null,
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(402)
    })

    it('skips payment for unknown tier', async () => {
      mockReq.params = { tier: 'unknown' }
      const pricing: Record<string, number> = {
        basic: 100000,
        premium: 500000,
      }

      const middleware = solanaPay402({
        ...baseOptions,
        getPaymentAmount: (req) => pricing[req.params.tier] || null,
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockNext).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      const middleware = solanaPay402({
        ...baseOptions,
        getPaymentAmount: vi.fn().mockRejectedValue(new Error('Database error')),
      })

      await middleware(mockReq as Request, mockRes as Response, mockNext)

      expect(mockRes.status).toHaveBeenCalledWith(500)
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Payment processing error',
        message: 'Database error',
      })
    })
  })
})

describe('getPaymentInfo', () => {
  it('returns undefined when no payment info', () => {
    const req = {} as Request
    expect(getPaymentInfo(req)).toBeUndefined()
  })

  it('returns payment info when attached', () => {
    const req = {
      solanaPayment: {
        valid: true,
        signature: 'test-sig',
        amount: 100000,
      },
    } as unknown as Request

    const info = getPaymentInfo(req)
    expect(info).toBeDefined()
    expect(info?.signature).toBe('test-sig')
  })
})
