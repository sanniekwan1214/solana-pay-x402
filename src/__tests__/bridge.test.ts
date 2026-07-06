import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

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
import { InMemorySignatureStore } from '../types'
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

    describe('v2 x402 payload', () => {
      const v2Requirements = {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      }

      const makeV2Header = () => Buffer.from(JSON.stringify({
        x402Version: 2,
        resource: { url: 'http://localhost:3000/api/test' },
        accepted: v2Requirements,
        payload: { transaction: 'base64-signed-tx' },
      })).toString('base64')

      it('verifies successfully and records a replay key', async () => {
        (bridge.getX402Handler().verifyPayment as Mock).mockResolvedValueOnce({ isValid: true })

        const result = await bridge.verifyPayment(makeV2Header(), v2Requirements)

        expect(result.valid).toBe(true)
        expect(mockSignatureStore.add).toHaveBeenCalledWith(expect.stringMatching(/^x402v2:/))
      })

      it('rejects a replayed v2 payload before calling the facilitator', async () => {
        (mockSignatureStore.has as Mock).mockReturnValue(true)

        const result = await bridge.verifyPayment(makeV2Header(), v2Requirements)

        expect(result.valid).toBe(false)
        expect(result.error).toBe('Payment signature already used')
        expect(bridge.getX402Handler().verifyPayment).not.toHaveBeenCalled()
      })
    })

    describe('v2 replay protection with real partially-signed transactions', () => {
      // Reproduces the real x402 v2 wire format: the FACILITATOR is the fee payer
      // (first signer slot), which stays an all-zero placeholder until settle time —
      // only the paying user's slot carries a real signature.
      const facilitator = Keypair.generate().publicKey
      const v2Requirements = {
        scheme: 'exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        amount: '100000',
        payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
        maxTimeoutSeconds: 300,
        asset: 'So11111111111111111111111111111111111111112',
        extra: {},
      }

      const makeUserSignedHeader = (user: Keypair) => {
        const message = new TransactionMessage({
          payerKey: facilitator,
          recentBlockhash: facilitator.toBase58(),
          instructions: [
            SystemProgram.transfer({
              fromPubkey: user.publicKey,
              toPubkey: facilitator,
              lamports: 1000,
            }),
          ],
        }).compileToV0Message()
        const tx = new VersionedTransaction(message)
        tx.sign([user]) // fee-payer slot (signatures[0]) remains 64 zero bytes
        return Buffer.from(JSON.stringify({
          x402Version: 2,
          resource: { url: 'http://localhost:3000/api/test' },
          accepted: v2Requirements,
          payload: { transaction: Buffer.from(tx.serialize()).toString('base64') },
        })).toString('base64')
      }

      let store: InMemorySignatureStore
      let realTxBridge: SolanaPayX402Bridge

      beforeEach(() => {
        store = new InMemorySignatureStore()
        realTxBridge = new SolanaPayX402Bridge({
          ...validConfig,
          signatureStore: store,
        })
        ;(realTxBridge.getX402Handler().verifyPayment as Mock).mockResolvedValue({ isValid: true })
      })

      afterEach(() => {
        store.destroy()
      })

      it('accepts payments from two different users (unsigned fee-payer slot must not collide)', async () => {
        const userA = Keypair.generate()
        const userB = Keypair.generate()

        const resultA = await realTxBridge.verifyPayment(makeUserSignedHeader(userA), v2Requirements)
        const resultB = await realTxBridge.verifyPayment(makeUserSignedHeader(userB), v2Requirements)

        expect(resultA.valid).toBe(true)
        expect(resultB.valid).toBe(true)
      })

      it('rejects a replay of the same signed transaction', async () => {
        const header = makeUserSignedHeader(Keypair.generate())

        const first = await realTxBridge.verifyPayment(header, v2Requirements)
        const second = await realTxBridge.verifyPayment(header, v2Requirements)

        expect(first.valid).toBe(true)
        expect(second.valid).toBe(false)
        expect(second.error).toBe('Payment signature already used')
      })

      it('rejects concurrent requests with the same header while verification is in flight', async () => {
        const header = makeUserSignedHeader(Keypair.generate())
        ;(realTxBridge.getX402Handler().verifyPayment as Mock).mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({ isValid: true }), 50))
        )

        const [first, second] = await Promise.all([
          realTxBridge.verifyPayment(header, v2Requirements),
          realTxBridge.verifyPayment(header, v2Requirements),
        ])

        const validCount = [first, second].filter((r) => r.valid).length
        expect(validCount).toBe(1)
        const rejected = [first, second].find((r) => !r.valid)
        expect(rejected?.error).toBe('Payment signature already used')
      })

      it('releases the claim when facilitator verification fails, keeping the header retryable', async () => {
        const header = makeUserSignedHeader(Keypair.generate())
        ;(realTxBridge.getX402Handler().verifyPayment as Mock)
          .mockRejectedValueOnce(new Error('facilitator unreachable'))

        const failed = await realTxBridge.verifyPayment(header, v2Requirements)
        expect(failed.valid).toBe(false)

        const retried = await realTxBridge.verifyPayment(header, v2Requirements)
        expect(retried.valid).toBe(true)
      })

      it('releaseReplayProtection frees the header after a failed blocking settlement', async () => {
        const header = makeUserSignedHeader(Keypair.generate())

        const first = await realTxBridge.verifyPayment(header, v2Requirements)
        expect(first.valid).toBe(true)

        const replayed = await realTxBridge.verifyPayment(header, v2Requirements)
        expect(replayed.valid).toBe(false)

        await realTxBridge.releaseReplayProtection(header)

        const retried = await realTxBridge.verifyPayment(header, v2Requirements)
        expect(retried.valid).toBe(true)
      })
    })
  })

  describe('settlePayment', () => {
    const requirements = {
      scheme: 'exact',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      amount: '100000',
      payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
      maxTimeoutSeconds: 300,
      asset: 'So11111111111111111111111111111111111111112',
      extra: {},
    }

    const makeV2Header = () => Buffer.from(JSON.stringify({
      x402Version: 2,
      resource: { url: 'http://localhost:3000/api/test' },
      accepted: requirements,
      payload: { transaction: 'base64-signed-tx' },
    })).toString('base64')

    const makeSolanaPayHeader = (signature = 'onchain-tx-sig') => Buffer.from(JSON.stringify({
      signature,
      scheme: 'exact',
    })).toString('base64')

    it('returns skipped when autoSettle is disabled', async () => {
      const bridge = new SolanaPayX402Bridge({ ...validConfig, autoSettle: false })
      const result = await bridge.settlePayment(makeV2Header(), requirements)
      expect(result).toEqual({ status: 'skipped' })
    })

    it('returns failed for an invalid payment header', async () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      const result = await bridge.settlePayment('not-valid-base64!!!', requirements)
      expect(result).toEqual({ status: 'failed', error: 'Invalid payment header format' })
    })

    it('returns settled with the existing signature for Solana Pay payloads, skipping the facilitator', async () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      const result = await bridge.settlePayment(makeSolanaPayHeader('onchain-tx-sig'), requirements)
      expect(result).toEqual({ status: 'settled', signature: 'onchain-tx-sig' })
      expect(bridge.getX402Handler().settlePayment).not.toHaveBeenCalled()
    })

    it('returns settled with the facilitator transaction signature on success', async () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      ;(bridge.getX402Handler().settlePayment as Mock).mockResolvedValueOnce({
        success: true,
        transaction: 'facilitator-tx-sig',
      })
      const result = await bridge.settlePayment(makeV2Header(), requirements)
      expect(result).toEqual({ status: 'settled', signature: 'facilitator-tx-sig' })
    })

    it('returns failed when facilitator settlement reports success: false', async () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      // Module-level mock default resolves { success: false, errorReason: 'unexpected_settle_error' }
      const result = await bridge.settlePayment(makeV2Header(), requirements)
      expect(result).toEqual({ status: 'failed', error: 'unexpected_settle_error' })
    })

    it('falls back to errorMessage when errorReason is absent', async () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      ;(bridge.getX402Handler().settlePayment as Mock).mockResolvedValueOnce({
        success: false,
        errorMessage: 'facilitator down',
      })
      const result = await bridge.settlePayment(makeV2Header(), requirements)
      expect(result).toEqual({ status: 'failed', error: 'facilitator down' })
    })

    it('returns failed when the facilitator call throws', async () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      ;(bridge.getX402Handler().settlePayment as Mock).mockRejectedValueOnce(new Error('network error'))
      const result = await bridge.settlePayment(makeV2Header(), requirements)
      expect(result).toEqual({ status: 'failed', error: 'network error' })
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

  describe('multi-token configuration', () => {
    it('creates bridge with acceptedTokens config', () => {
      const bridge = new SolanaPayX402Bridge({
        ...validConfig,
        acceptedTokens: [
          { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, label: 'USDC' },
          { mint: 'So11111111111111111111111111111111111111112', decimals: 9, label: 'SOL' },
        ],
      })
      expect(bridge).toBeDefined()
      expect(bridge.isMultiToken()).toBe(true)
    })

    it('isMultiToken returns false for single-token config', () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      expect(bridge.isMultiToken()).toBe(false)
    })

    it('throws for invalid mint in acceptedTokens', () => {
      expect(() => new SolanaPayX402Bridge({
        ...validConfig,
        acceptedTokens: [
          { mint: 'invalid-mint', decimals: 6 },
        ],
      })).toThrow('Invalid token mint address')
    })

    it('warns when both splToken and acceptedTokens provided', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      new SolanaPayX402Bridge({
        ...validConfig,
        splToken: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
        acceptedTokens: [
          { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
        ],
      })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('acceptedTokens takes precedence'))
      spy.mockRestore()
    })
  })

  describe('createMultiTokenPaymentChallenge', () => {
    it('returns array of payment requirements, one per token', async () => {
      const bridge = new SolanaPayX402Bridge({
        ...validConfig,
        acceptedTokens: [
          { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, label: 'USDC' },
          { mint: 'So11111111111111111111111111111111111111112', decimals: 9, label: 'SOL' },
        ],
      })

      const result = await bridge.createMultiTokenPaymentChallenge(
        { amount: 100000 },
        'http://localhost:3000/api/test'
      )

      expect(result.paymentRequirements).toHaveLength(2)
      expect(result.solanaPayUrl).toBeDefined()
      expect(result.resource).toBe('http://localhost:3000/api/test')
    })

    it('calls createPaymentRequirements once per token', async () => {
      const bridge = new SolanaPayX402Bridge({
        ...validConfig,
        acceptedTokens: [
          { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amount: '100000' },
          { mint: 'So11111111111111111111111111111111111111112', decimals: 9, amount: (base) => Number(base) * 150 },
        ],
      })

      await bridge.createMultiTokenPaymentChallenge(
        { amount: 1000 },
        'http://localhost:3000/api/test'
      )

      const handler = bridge.getX402Handler()
      expect(handler.createPaymentRequirements).toHaveBeenCalledTimes(2)
    })
  })

  describe('create402ResponseMultiToken', () => {
    it('creates response with multiple accepts entries', () => {
      const bridge = new SolanaPayX402Bridge(validConfig)
      const requirements = [
        {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          amount: '100000',
          payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
          maxTimeoutSeconds: 300,
          asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          extra: {},
        },
        {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          amount: '15000000',
          payTo: 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8',
          maxTimeoutSeconds: 300,
          asset: 'So11111111111111111111111111111111111111112',
          extra: {},
        },
      ]

      const result = bridge.create402ResponseMultiToken(requirements, 'http://localhost:3000/api/test')
      expect(result.status).toBe(402)
      expect((result.body as { accepts: unknown[] }).accepts).toHaveLength(2)
      expect((result.body as { x402Version: number }).x402Version).toBe(2)
    })
  })
})
