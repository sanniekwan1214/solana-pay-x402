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
  X402PaymentHeader,
} from '../types'
import { InMemorySignatureStore } from '../types'

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
   */
  extractPayment(headers: Record<string, string | string[] | undefined>): X402PaymentHeader | null {
    const result = this.x402Handler.extractPayment(headers)
    if (!result) return null
    if (typeof result === 'string') {
      try {
        return JSON.parse(result)
      } catch {
        return { signature: result }
      }
    }
    return result as X402PaymentHeader
  }

  /**
   * Verify payment using x402 facilitator with fallback to on-chain
   */
  async verifyPayment(
    paymentHeader: X402PaymentHeader | string,
    paymentRequirements: X402PaymentRequirements
  ): Promise<PaymentVerification> {
    const payment: X402PaymentHeader = typeof paymentHeader === 'string'
      ? JSON.parse(paymentHeader)
      : paymentHeader

    const signature = payment.signature

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
      // Try x402 facilitator verification first (may fail due to gzip issues)
      const headerStr = typeof paymentHeader === 'string' ? paymentHeader : JSON.stringify(paymentHeader)
      try {
        const verified = await this.x402Handler.verifyPayment(headerStr, paymentRequirements as Parameters<typeof this.x402Handler.verifyPayment>[1])

        if (verified) {
          await this.signatureStore.add(signature)
          return {
            valid: true,
            signature,
            amount: parseInt(paymentRequirements.maxAmountRequired),
          }
        }
      } catch {
        // Facilitator unavailable or gzip response issue, fall back to on-chain
      }

      // Fallback: Direct on-chain verification
      const tx = await this.connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0
      })

      if (!tx || tx.meta?.err) {
        return {
          valid: false,
          signature,
          error: 'Transaction not found or failed',
        }
      }

      const expectedAmount = parseInt(paymentRequirements.maxAmountRequired)
      const recipientPubkey = new PublicKey(paymentRequirements.payTo)

      const accountKeys = 'accountKeys' in tx.transaction.message
        ? tx.transaction.message.accountKeys
        : tx.transaction.message.getAccountKeys().keySegments().flat()

      const recipientIndex = accountKeys.findIndex(
        (key: PublicKey) => key.toString() === recipientPubkey.toString()
      )

      if (recipientIndex === -1 || !tx.meta) {
        return {
          valid: false,
          signature,
          error: 'Recipient not found in transaction',
        }
      }

      const balanceChange = tx.meta.postBalances[recipientIndex] - tx.meta.preBalances[recipientIndex]

      if (balanceChange < expectedAmount) {
        return {
          valid: false,
          signature,
          error: `Insufficient payment: expected ${expectedAmount}, got ${balanceChange}`,
        }
      }

      await this.signatureStore.add(signature)

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
    paymentHeader: X402PaymentHeader | string,
    paymentRequirements: X402PaymentRequirements
  ): Promise<string | null> {
    if (!this.config.autoSettle) {
      return null
    }

    try {
      const headerStr = typeof paymentHeader === 'string' ? paymentHeader : JSON.stringify(paymentHeader)
      const settlement = await this.x402Handler.settlePayment(headerStr, paymentRequirements as Parameters<typeof this.x402Handler.settlePayment>[1])
      return settlement?.transaction ?? null
    } catch {
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
