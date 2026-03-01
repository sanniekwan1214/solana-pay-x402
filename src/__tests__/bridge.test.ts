import { describe, it, expect, beforeEach, vi, Mock } from 'vitest'
import { PublicKey } from '@solana/web3.js'

// Mock x402-solana before importing bridge
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
    verifyPayment: vi.fn().mockResolvedValue({ isValid: false, invalidReason: 'unexpected_verify_error' }),
    settlePayment: vi.fn().mockResolvedValue({ success: false, errorReason: 'unexpected_settle_error' }),
  })),
}))

// Mock @solana/pay
vi.mock('@solana/pay', () => ({
  encodeURL: vi.fn().mockReturnValue(new URL('solana:ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8?amount=0.0001')),
}))

import { SolanaPayX402Bridge } from '../core/bridge'
import type { SolanaPayX402Config, SignatureStore } from '../types'

describe('SolanaPayX402Bridge', () => {
  const validConfig: SolanaPayX402Config = {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    recipient: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
    network: 'mainnet-beta',
    label: 'Test Payment',
  }

  describe('constructor', () => {
    it('creates bridge with valid config', () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      expect(bridge).toBeDefined()
    })

    it('throws error for invalid RPC URL', () => {
      expect(() => new SolanaPayX402Bridge({
        ...validConfig,
        rpcUrl: 'not-a-url',
      })).toThrow('Invalid RPC URL')
    })

    it('throws error for empty RPC URL', () => {
      expect(() => new SolanaPayX402Bridge({
        ...validConfig,
        rpcUrl: '',
      })).toThrow('Invalid RPC URL')
    })

    it('throws error for invalid recipient address', () => {
      expect(() => new SolanaPayX402Bridge({
        ...validConfig,
        recipient: 'invalid-address',
      })).toThrow('Invalid recipient address')
    })

    it('accepts PublicKey as recipient', () => {
      const bridge = new SolanaPayX402Bridge({
        ...validConfig,
        recipient: new PublicKey('ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8'),
      })
      expect(bridge).toBeDefined()
    })

    it('accepts SPL token config', () => {
      const bridge = new SolanaPayX402Bridge({
        ...validConfig,
        splToken: {
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          decimals: 6,
        },
      })
      expect(bridge).toBeDefined()
    })

    it('throws error for invalid SPL token mint', () => {
      expect(() => new SolanaPayX402Bridge({
        ...validConfig,
        splToken: {
          mint: 'invalid-mint',
          decimals: 6,
        },
      })).toThrow('Invalid SPL token mint address')
    })

    it('uses default network mainnet-beta', () => {
      const bridge = new SolanaPayX402Bridge({
        rpcUrl: validConfig.rpcUrl,
        recipient: validConfig.recipient,
      })
      expect(bridge).toBeDefined()
    })

    it('accepts custom signature store', () => {
      const customStore: SignatureStore = {
        has: vi.fn().mockReturnValue(false),
        add: vi.fn(),
      }
      const bridge = new SolanaPayX402Bridge({
        ...validConfig,
        signatureStore: customStore,
      })
      expect(bridge).toBeDefined()
    })
  })

  describe('createSolanaPayUrl', () => {
    let bridge: SolanaPayX402Bridge

    beforeEach(() => {
      bridge = new SolanaPayX402Bridge(validConfig)
    })

    it('creates URL with amount in lamports', async () => {
      const result = await bridge.createSolanaPayUrl({
        amount: 100000, // 0.0001 SOL in lamports
      })

      expect(result.url).toContain('solana:')
      expect(result.reference).toBeDefined()
    })

    it('creates URL with string amount', async () => {
      const result = await bridge.createSolanaPayUrl({
        amount: '100000',
      })

      expect(result.url).toBeDefined()
    })

    it('uses provided reference', async () => {
      const reference = '11111111111111111111111111111112'
      const result = await bridge.createSolanaPayUrl({
        amount: 100000,
        reference,
      })

      expect(result.reference.toString()).toBe(reference)
    })

    it('generates random reference if not provided', async () => {
      const result1 = await bridge.createSolanaPayUrl({ amount: 100000 })
      const result2 = await bridge.createSolanaPayUrl({ amount: 100000 })

      expect(result1.reference.toString()).not.toBe(result2.reference.toString())
    })
  })

  describe('createPaymentChallenge', () => {
    let bridge: SolanaPayX402Bridge

    beforeEach(() => {
      bridge = new SolanaPayX402Bridge(validConfig)
    })

    it('creates payment challenge with requirements and URL', async () => {
      const result = await bridge.createPaymentChallenge(
        { amount: 100000 },
        'http://localhost:3000/api/test'
      )

      expect(result.paymentRequirements).toBeDefined()
      expect(result.solanaPayUrl).toBeDefined()
      expect(result.solanaPayUrl.url).toContain('solana:')
    })
  })

  describe('extractPayment', () => {
    let bridge: SolanaPayX402Bridge

    beforeEach(() => {
      bridge = new SolanaPayX402Bridge(validConfig)
    })

    it('extracts payment header from request', () => {
      const paymentHeader = Buffer.from(JSON.stringify({
        signature: 'test-sig',
        scheme: 'exact',
      })).toString('base64')

      const result = bridge.extractPayment({
        'payment-signature': paymentHeader,
      })

      expect(result).toBe(paymentHeader)
    })

    it('returns null when no payment header', () => {
      const result = bridge.extractPayment({})
      expect(result).toBeNull()
    })
  })

  describe('verifyPayment', () => {
    let bridge: SolanaPayX402Bridge
    let mockSignatureStore: SignatureStore

    beforeEach(() => {
      mockSignatureStore = {
        has: vi.fn().mockReturnValue(false),
        add: vi.fn(),
      }
      bridge = new SolanaPayX402Bridge({
        ...validConfig,
        signatureStore: mockSignatureStore,
      })
    })

    it('returns error for invalid base64 header', async () => {
      const result = await bridge.verifyPayment('not-valid-base64!!!', {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid payment header format')
    })

    it('returns error for missing signature', async () => {
      const header = Buffer.from(JSON.stringify({ scheme: 'exact' })).toString('base64')

      const result = await bridge.verifyPayment(header, {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('No signature provided')
    })

    it('detects replay attack', async () => {
      (mockSignatureStore.has as Mock).mockReturnValue(true)

      const header = Buffer.from(JSON.stringify({
        signature: 'already-used-sig',
        scheme: 'exact',
      })).toString('base64')

      const result = await bridge.verifyPayment(header, {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      })

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Payment signature already used')
    })
  })

  describe('create402Response', () => {
    let bridge: SolanaPayX402Bridge

    beforeEach(() => {
      bridge = new SolanaPayX402Bridge(validConfig)
    })

    it('creates 402 response with payment requirements', () => {
      const result = bridge.create402Response({
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      }, 'http://localhost:3000/api/test')

      expect(result.status).toBe(402)
      expect(result.body).toBeDefined()
    })
  })

  describe('getConnection', () => {
    it('returns Solana connection', () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      const connection = bridge.getConnection()
      expect(connection).toBeDefined()
    })
  })

  describe('getX402Handler', () => {
    it('returns x402 handler', () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      const handler = bridge.getX402Handler()
      expect(handler).toBeDefined()
    })
  })
})
