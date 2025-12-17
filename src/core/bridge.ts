import { Connection, PublicKey, Keypair } from '@solana/web3.js'
import { encodeURL } from '@solana/pay'
import BigNumber from 'bignumber.js'
import { X402PaymentHandler } from 'x402-solana/server'
import type {
  SolanaPayX402Config,
  PaymentRequest,
  SolanaPayUrl,
  PaymentVerification,
  SignatureStore,
  X402PaymentRequirements,
} from '../types'
import { InMemorySignatureStore } from '../types'

import { debugLog, setupFetchInterceptor } from '../utils/debug'

setupFetchInterceptor()

const SOL_DECIMALS = 9
const SOL_MINT = 'So11111111111111111111111111111111111111112'

function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address)
    return true
  } catch {
    return false
  }
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

/**
 * Core bridge between Solana Pay and x402 protocol
 */
export class SolanaPayX402Bridge {
  private connection: Connection
  private x402Handler: X402PaymentHandler
  private signatureStore: SignatureStore
  private config: {
    recipient: PublicKey
    network: 'mainnet-beta' | 'devnet' | 'testnet'
    label: string
    rpcUrl: string
    facilitatorUrl?: string
    autoSettle: boolean
    splToken?: { mint: PublicKey; decimals: number }
    message?: string
  }

  constructor(config: SolanaPayX402Config) {
    if (!config.rpcUrl || !isValidUrl(config.rpcUrl)) {
      throw new Error('Invalid RPC URL')
    }

    const recipientStr = typeof config.recipient === 'string'
      ? config.recipient
      : config.recipient.toString()

    if (!isValidSolanaAddress(recipientStr)) {
      throw new Error('Invalid recipient address')
    }

    this.connection = new Connection(config.rpcUrl, 'confirmed')
    this.signatureStore = config.signatureStore || new InMemorySignatureStore()

    const recipientPubkey = new PublicKey(recipientStr)

    let splTokenConfig: { mint: PublicKey; decimals: number } | undefined
    if (config.splToken) {
      const mintStr = typeof config.splToken.mint === 'string'
        ? config.splToken.mint
        : config.splToken.mint.toString()

      if (!isValidSolanaAddress(mintStr)) {
        throw new Error('Invalid SPL token mint address')
      }

      splTokenConfig = {
        mint: new PublicKey(mintStr),
        decimals: config.splToken.decimals,
      }
    }

    this.config = {
      recipient: recipientPubkey,
      network: config.network || 'mainnet-beta',
      label: config.label || 'Payment',
      rpcUrl: config.rpcUrl,
      facilitatorUrl: config.facilitatorUrl,
      autoSettle: config.autoSettle !== false,
      splToken: splTokenConfig,
      message: config.message,
    }

    const x402Network = this.config.network === 'devnet' ? 'solana-devnet' : 'solana'

    this.x402Handler = new X402PaymentHandler({
      network: x402Network,
      treasuryAddress: this.config.recipient.toString(),
      facilitatorUrl: this.config.facilitatorUrl || 'https://facilitator.payai.network',
    })
  }

  /**
   * Create x402 payment requirements for a request
   */
  async createPaymentChallenge(payment: PaymentRequest, resource: string) {
    const decimals = this.config.splToken?.decimals ?? SOL_DECIMALS
    const tokenAddress = this.config.splToken?.mint.toString() ?? SOL_MINT

    const amount = typeof payment.amount === 'number'
      ? payment.amount.toString()
      : payment.amount

    const priceConfig = {
      amount,
      asset: { address: tokenAddress, decimals },
    }

    const paymentRequirements = await this.x402Handler.createPaymentRequirements({
      price: priceConfig,
      network: this.config.network === 'devnet' ? 'solana-devnet' : 'solana',
      config: {
        description: payment.label || this.config.label,
        resource: resource as `${string}://${string}`,
      },
    })

    const solanaPayUrl = await this.createSolanaPayUrl(payment)

    return {
      paymentRequirements,
      solanaPayUrl,
    }
  }

  /**
   * Create a Solana Pay URL from a payment request
   * Amount should be in lamports (or smallest token unit)
   */
  async createSolanaPayUrl(payment: PaymentRequest): Promise<SolanaPayUrl> {
    const reference = payment.reference
      ? new PublicKey(payment.reference)
      : Keypair.generate().publicKey

    const decimals = this.config.splToken?.decimals ?? SOL_DECIMALS
    const rawAmount = typeof payment.amount === 'number'
      ? payment.amount
      : parseFloat(payment.amount)

    // Convert from smallest unit to display unit
    const displayAmount = new BigNumber(rawAmount).dividedBy(Math.pow(10, decimals))

    const urlParams: Parameters<typeof encodeURL>[0] = {
      recipient: this.config.recipient,
      amount: displayAmount,
      reference,
      label: payment.label || this.config.label,
      message: payment.memo || this.config.message,
    }

    if (this.config.splToken) {
      urlParams.splToken = this.config.splToken.mint
    }

    const url = encodeURL(urlParams)

    return {
      url: url.toString(),
      reference,
    }
  }

  /**
   * Create 402 response using x402-solana handler
   */
  create402Response(paymentRequirements: X402PaymentRequirements) {
    return this.x402Handler.create402Response(paymentRequirements as Parameters<typeof this.x402Handler.create402Response>[0])
  }

  /**
   * Extract payment from request headers
   * Returns raw base64 string as expected by x402-solana
   */
  extractPayment(headers: Record<string, string | string[] | undefined>): string | null {
    return this.x402Handler.extractPayment(headers)
  }

  /**
   * Verify payment using x402 facilitator with fallback to on-chain
   * paymentHeader should be raw base64 string from extractPayment
   */
  async verifyPayment(
    paymentHeader: string,
    paymentRequirements: X402PaymentRequirements
  ): Promise<PaymentVerification> {
    // Decode base64 to get signature
    let signature: string
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
      signature = decoded.signature
    } catch {
      return {
        valid: false,
        signature: '',
        error: 'Invalid payment header format',
      }
    }

    if (!signature) {
      return {
        valid: false,
        signature: '',
        error: 'No signature provided',
      }
    }

    // Check for replay attack
    const alreadyUsed = await this.signatureStore.has(signature)
    if (alreadyUsed) {
      return {
        valid: false,
        signature,
        error: 'Payment signature already used',
      }
    }

    try {
      // Try x402 facilitator verification first
      try {
        debugLog('verify', 'Initiating facilitator verification', {
          signature,
          paymentHeaderBase64: paymentHeader,
          paymentRequirements: {
            scheme: paymentRequirements.scheme,
            network: paymentRequirements.network,
            maxAmountRequired: paymentRequirements.maxAmountRequired,
            resource: paymentRequirements.resource,
            payTo: paymentRequirements.payTo,
          },
        })

        const verified = await this.x402Handler.verifyPayment(paymentHeader, paymentRequirements as Parameters<typeof this.x402Handler.verifyPayment>[1])

        debugLog('verify', 'Facilitator response received', {
          result: verified as Record<string, unknown>,
        })

        if (verified && (verified as { isValid?: boolean }).isValid) {
          debugLog('verify', 'Facilitator verification SUCCESS')
          await this.signatureStore.add(signature)
          return {
            valid: true,
            signature,
            amount: parseInt(paymentRequirements.maxAmountRequired),
          }
        }
        debugLog('verify', 'Facilitator returned invalid, falling back to on-chain')
      } catch (err) {
        debugLog('verify', 'Facilitator verification failed', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
        debugLog('verify', 'Falling back to on-chain verification')
      }

      // Fallback: Direct on-chain verification
      debugLog('onchain', 'Fetching transaction from RPC', { signature })

      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      })

      if (!tx || tx.meta?.err) {
        debugLog('onchain', 'Transaction not found or failed', {
          found: !!tx,
          error: tx?.meta?.err,
        })
        return {
          valid: false,
          signature,
          error: 'Transaction not found or failed',
        }
      }

      debugLog('onchain', 'Transaction found', {
        slot: tx.slot,
        blockTime: tx.blockTime,
      })

      const expectedAmount = parseInt(paymentRequirements.maxAmountRequired)
      const recipientPubkey = new PublicKey(paymentRequirements.payTo)
      const tokenMint = this.config.splToken?.mint.toString()

      if (!tx.meta) {
        return {
          valid: false,
          signature,
          error: 'Transaction metadata not available',
        }
      }

      let balanceChange: number

      if (tokenMint && tokenMint !== SOL_MINT) {
        // SPL Token verification - check token balances
        debugLog('onchain', 'Verifying SPL token transfer', { mint: tokenMint })

        const preTokenBalances = tx.meta.preTokenBalances || []
        const postTokenBalances = tx.meta.postTokenBalances || []

        // Find recipient's token balance change
        const recipientPostBalance = postTokenBalances.find(
          (b) => b.mint === tokenMint && b.owner === recipientPubkey.toString()
        )
        const recipientPreBalance = preTokenBalances.find(
          (b) => b.mint === tokenMint && b.owner === recipientPubkey.toString()
        )

        const postAmount = recipientPostBalance?.uiTokenAmount?.amount
          ? parseInt(recipientPostBalance.uiTokenAmount.amount)
          : 0
        const preAmount = recipientPreBalance?.uiTokenAmount?.amount
          ? parseInt(recipientPreBalance.uiTokenAmount.amount)
          : 0

        balanceChange = postAmount - preAmount

        debugLog('onchain', 'SPL token balance change', {
          recipient: recipientPubkey.toString(),
          mint: tokenMint,
          preAmount,
          postAmount,
          change: balanceChange,
        })
      } else {
        // Native SOL verification
        const accountKeys = 'accountKeys' in tx.transaction.message
          ? tx.transaction.message.accountKeys
          : tx.transaction.message.getAccountKeys().keySegments().flat()

        const recipientIndex = accountKeys.findIndex(
          (key: PublicKey) => key.toString() === recipientPubkey.toString()
        )

        if (recipientIndex === -1) {
          return {
            valid: false,
            signature,
            error: 'Recipient not found in transaction',
          }
        }

        balanceChange = tx.meta.postBalances[recipientIndex] - tx.meta.preBalances[recipientIndex]
      }

      if (balanceChange < expectedAmount) {
        debugLog('onchain', 'Insufficient payment amount', {
          expected: expectedAmount,
          received: balanceChange,
        })
        return {
          valid: false,
          signature,
          error: `Insufficient payment: expected ${expectedAmount}, got ${balanceChange}`,
        }
      }

      await this.signatureStore.add(signature)

      debugLog('onchain', 'On-chain verification SUCCESS', {
        signature,
        amount: balanceChange,
        recipient: recipientPubkey.toString(),
      })

      return {
        valid: true,
        signature,
        amount: balanceChange,
      }
    } catch (error) {
      return {
        valid: false,
        signature,
        error: error instanceof Error ? error.message : 'Verification failed',
      }
    }
  }

  /**
   * Settle payment through facilitator
   */
  async settlePayment(
    paymentHeader: string,
    paymentRequirements: X402PaymentRequirements
  ): Promise<string | null> {
    if (!this.config.autoSettle) {
      debugLog('settle', 'Auto-settle disabled, skipping')
      return null
    }

    try {
      debugLog('settle', 'Initiating facilitator settlement', {
        paymentHeaderBase64: paymentHeader,
        paymentRequirements: {
          scheme: paymentRequirements.scheme,
          network: paymentRequirements.network,
          maxAmountRequired: paymentRequirements.maxAmountRequired,
          payTo: paymentRequirements.payTo,
        },
      })

      const settlement = await this.x402Handler.settlePayment(paymentHeader, paymentRequirements as Parameters<typeof this.x402Handler.settlePayment>[1])

      debugLog('settle', 'Facilitator settlement response', {
        result: settlement as Record<string, unknown>,
      })

      return settlement?.transaction ?? null
    } catch (err) {
      debugLog('settle', 'Facilitator settlement failed', {
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
      return null
    }
  }

  getConnection(): Connection {
    return this.connection
  }

  getX402Handler(): X402PaymentHandler {
    return this.x402Handler
  }
}
