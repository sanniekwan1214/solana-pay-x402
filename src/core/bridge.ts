import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js'
import { encodeURL } from '@solana/pay'
import BigNumber from 'bignumber.js'
import { X402PaymentHandler } from 'x402-solana/server'
import type {
  SolanaPayX402Config,
  PaymentRequest,
  SolanaPayUrl,
  PaymentVerification
} from '../types'

/**
 * Core bridge between Solana Pay and x402 protocol
 * Combines Solana Pay's familiar URL/QR flow with x402's HTTP payment verification
 */
export class SolanaPayX402Bridge {
  private connection: Connection
  private x402Handler: X402PaymentHandler
  private config: Required<Omit<SolanaPayX402Config, 'splToken' | 'message' | 'facilitatorUrl' | 'autoSettle'>> &
    Pick<SolanaPayX402Config, 'splToken' | 'message' | 'facilitatorUrl' | 'autoSettle'>

  constructor(config: SolanaPayX402Config) {
    this.connection = new Connection(config.rpcUrl, 'confirmed')

    const recipientPubkey = typeof config.recipient === 'string'
      ? new PublicKey(config.recipient)
      : config.recipient

    this.config = {
      ...config,
      recipient: recipientPubkey,
      network: config.network || 'mainnet-beta',
      label: config.label || 'Payment',
      rpcUrl: config.rpcUrl,
      facilitatorUrl: config.facilitatorUrl,
      autoSettle: config.autoSettle !== false,
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
   * This creates the full x402 response including Solana Pay URL
   */
  async createPaymentChallenge(payment: PaymentRequest, resource: string) {
    const amount = typeof payment.amount === 'number'
      ? payment.amount.toString()
      : payment.amount

    const tokenAddress = this.config.splToken
      ? (typeof this.config.splToken === 'string' ? this.config.splToken : this.config.splToken.toString())
      : undefined

    const priceConfig = tokenAddress
      ? {
          amount,
          asset: { address: tokenAddress, decimals: 9 },
        }
      : {
          amount,
          asset: { address: 'So11111111111111111111111111111111111111112', decimals: 9 },
        }

    const paymentRequirements = await this.x402Handler.createPaymentRequirements({
      price: priceConfig,
      network: this.config.network === 'devnet' ? 'solana-devnet' : 'solana',
      config: {
        description: payment.label || this.config.label || 'Payment',
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
   * This generates the solana: URL that wallets understand for QR codes
   */
  async createSolanaPayUrl(payment: PaymentRequest): Promise<SolanaPayUrl> {
    const reference = payment.reference
      ? new PublicKey(payment.reference)
      : Keypair.generate().publicKey
    const recipient = this.config.recipient

    const amountValue = typeof payment.amount === 'number'
      ? payment.amount / LAMPORTS_PER_SOL
      : parseFloat(payment.amount) / LAMPORTS_PER_SOL

    const amount = new BigNumber(amountValue)

    console.log('[Solana Pay URL] Building URL with:', {
      recipient: recipient.toString(),
      amount: amount.toString(),
      reference: reference.toString(),
      label: payment.label || this.config.label,
      message: payment.memo || this.config.message,
    })

    if (this.config.splToken) {
      const splToken = typeof this.config.splToken === 'string'
        ? new PublicKey(this.config.splToken)
        : this.config.splToken

      const url = encodeURL({
        recipient: recipient as PublicKey,
        amount,
        splToken,
        reference,
        label: payment.label || this.config.label,
        message: payment.memo || this.config.message,
      })

      return {
        url: url.toString(),
        reference,
      }
    } else {
      const url = encodeURL({
        recipient: recipient as PublicKey,
        amount,
        reference,
        label: payment.label || this.config.label,
        message: payment.memo || this.config.message,
      })

      return {
        url: url.toString(),
        reference,
      }
    }
  }

  /**
   * Create 402 response using x402-solana handler
   */
  create402Response(paymentRequirements: any) {
    return this.x402Handler.create402Response(paymentRequirements)
  }

  /**
   * Extract payment from request headers
   */
  extractPayment(headers: any) {
    console.log('[Bridge] extractPayment called with headers:', {
      'x-payment-proof': headers['x-payment-proof'],
      'x-payment-reference': headers['x-payment-reference'],
      allHeaders: Object.keys(headers),
    })
    const result = this.x402Handler.extractPayment(headers)
    console.log('[Bridge] extractPayment result:', result ? 'Found payment' : 'No payment found')
    if (result) {
      console.log('[Bridge] Payment details:', result)
    }
    return result
  }

  /**
   * Verify payment using x402 facilitator with fallback to on-chain
   */
  async verifyPayment(
    paymentHeader: any,
    paymentRequirements: any
  ): Promise<PaymentVerification> {
    try {
      console.log('[Bridge] Starting payment verification via x402 facilitator...')
      console.log('[Bridge] Facilitator URL:', this.config.facilitatorUrl || 'https://facilitator.payai.network')
      console.log('[Bridge] Payment network:', this.config.network)

      // Try x402 facilitator verification first
      try {
        const verified = await this.x402Handler.verifyPayment(paymentHeader, paymentRequirements)

        if (verified) {
          console.log('[Bridge] ✓ Payment verified via x402 facilitator!')

          // Parse signature from payment header
          let payment = typeof paymentHeader === 'string' ? JSON.parse(paymentHeader) : paymentHeader

          return {
            valid: true,
            signature: payment.signature || '',
            amount: parseInt(paymentRequirements.maxAmountRequired),
          }
        }
      } catch (facilitatorError) {
        console.warn('[Bridge] Facilitator verification failed, falling back to on-chain verification')
        console.warn('[Bridge] Facilitator error:', facilitatorError instanceof Error ? facilitatorError.message : facilitatorError)
      }

      // Fallback: Direct on-chain verification
      console.log('[Bridge] Using fallback: direct on-chain verification...')

      // Parse payment header
      let payment = typeof paymentHeader === 'string' ? JSON.parse(paymentHeader) : paymentHeader
      const signature = payment.signature

      if (!signature) {
        return {
          valid: false,
          signature: '',
          error: 'No signature provided',
        }
      }

      // Fetch and verify transaction on-chain
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

      // Verify amount
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

      console.log('[Bridge] ✓ Payment verified on-chain (facilitator unavailable)!')

      return {
        valid: true,
        signature,
        amount: balanceChange,
      }
    } catch (error) {
      console.error('[Bridge] Verification error:', error)
      let sig = ''
      try {
        const payment = typeof paymentHeader === 'string' ? JSON.parse(paymentHeader) : paymentHeader
        sig = payment?.signature || ''
      } catch (e) {}

      return {
        valid: false,
        signature: sig,
        error: error instanceof Error ? error.message : 'Unknown verification error',
      }
    }
  }

  /**
   * Settle payment through facilitator
   * Note: Settlement is optional - payment has already been verified
   */
  async settlePayment(paymentHeader: any, paymentRequirements: any): Promise<string | null> {
    if (!this.config.autoSettle) {
      return null
    }

    try {
      console.log('[Bridge] Attempting settlement via facilitator...')

      // Try using the x402 handler, but the facilitator might have gzip issues on devnet
      const settlement = await this.x402Handler.settlePayment(paymentHeader, paymentRequirements)

      if (settlement?.transaction) {
        console.log('[Bridge] ✓ Settlement recorded:', settlement.transaction)
        return settlement.transaction
      }

      return null
    } catch (error) {
      // Settlement failures are not critical - payment is already verified
      const errorMsg = error instanceof Error ? error.message : String(error)

      if (errorMsg.includes('not valid JSON') || errorMsg.includes('Unexpected token')) {
        console.log('[Bridge] Settlement skipped: Facilitator response format issue (known devnet issue)')
        console.log('[Bridge] Note: Payment verification succeeded - settlement is just for facilitator accounting')
      } else {
        console.warn('[Bridge] Settlement failed:', errorMsg)
      }

      return null
    }
  }

  /**
   * Get the Solana connection instance
   */
  getConnection(): Connection {
    return this.connection
  }

  /**
   * Get the x402 handler instance for advanced usage
   */
  getX402Handler(): X402PaymentHandler {
    return this.x402Handler
  }
}
