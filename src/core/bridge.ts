import { createHash } from 'crypto'
import { Connection, PublicKey, Keypair, VersionedTransaction, Transaction } from '@solana/web3.js'
import { encodeURL } from '@solana/pay'
import BigNumber from 'bignumber.js'
import { X402PaymentHandler } from 'x402-solana/server'
import type { PaymentRequirements } from 'x402-solana/types'
import type {
  SolanaPayX402Config,
  PaymentRequest,
  SolanaPayUrl,
  PaymentVerification,
  SignatureStore,
  SettlementResult,
} from '../types'
import { InMemorySignatureStore } from '../types'

import { debugLog, setupFetchInterceptor } from '../utils/debug'

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
    acceptedTokens?: Array<{
      mint: PublicKey
      decimals: number
      amount?: number | string | ((baseAmount: number | string) => number | string | Promise<number | string>)
      label?: string
    }>
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

    let acceptedTokensConfig: typeof this.config.acceptedTokens | undefined
    if (config.acceptedTokens && config.acceptedTokens.length > 0) {
      if (config.splToken) {
        console.warn('[solana-pay-x402] Both splToken and acceptedTokens provided; acceptedTokens takes precedence.')
      }
      acceptedTokensConfig = config.acceptedTokens.map(token => {
        const mintStr = typeof token.mint === 'string' ? token.mint : token.mint.toString()
        if (!isValidSolanaAddress(mintStr)) {
          throw new Error(`Invalid token mint address: ${mintStr}`)
        }
        return {
          mint: new PublicKey(mintStr),
          decimals: token.decimals,
          amount: token.amount,
          label: token.label,
        }
      })
    }

    this.config = {
      recipient: recipientPubkey,
      network: config.network || 'mainnet-beta',
      label: config.label || 'Payment',
      rpcUrl: config.rpcUrl,
      facilitatorUrl: config.facilitatorUrl,
      autoSettle: config.autoSettle !== false,
      splToken: splTokenConfig,
      acceptedTokens: acceptedTokensConfig,
      message: config.message,
    }

    const x402Network = this.config.network === 'devnet' ? 'solana-devnet' : 'solana'

    setupFetchInterceptor()

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

    const routeConfig = {
      amount,
      asset: { address: tokenAddress, decimals },
      description: payment.label || this.config.label,
    }

    const paymentRequirements = await this.x402Handler.createPaymentRequirements(routeConfig, resource)

    const solanaPayUrl = await this.createSolanaPayUrl(payment)

    return {
      paymentRequirements,
      solanaPayUrl,
      resource,
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

    // Use first accepted token (primary) or fall back to splToken / SOL
    const primaryToken = this.config.acceptedTokens?.[0]
    const decimals = primaryToken?.decimals ?? this.config.splToken?.decimals ?? SOL_DECIMALS
    const splMint = primaryToken?.mint ?? this.config.splToken?.mint

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

    if (splMint) {
      const mintStr = splMint.toString()
      if (mintStr !== SOL_MINT) {
        urlParams.splToken = splMint
      }
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
  create402Response(paymentRequirements: PaymentRequirements, resourceUrl: string): { status: 402; body: Record<string, unknown> } {
    return this.x402Handler.create402Response(paymentRequirements, resourceUrl) as { status: 402; body: Record<string, unknown> }
  }

  /**
   * Extract payment from request headers
   * Returns raw base64 string as expected by x402-solana
   */
  extractPayment(headers: Record<string, string | string[] | undefined>): string | null {
    return this.x402Handler.extractPayment(headers)
  }

  /**
   * Derive a replay-protection key for a v2 x402 payload.
   *
   * The x402 v2 facilitator flow has no pre-existing on-chain signature to key off of
   * (unlike Solana Pay), so we derive one from the signed-but-unsubmitted transaction.
   * The key must come from a signature the CLIENT actually produced: in the x402 flow
   * the fee payer is the facilitator, whose signature slot is an all-zero placeholder
   * until settle time, so slot 0 is the same for every payment from every user. We
   * therefore take the first NON-ZERO signature (the payer's — unforgeable per
   * transaction), falling back to hashing the raw payment header if the transaction
   * can't be parsed or carries no real signature.
   */
  private getV2ReplayKey(paymentHeader: string, decoded: Record<string, unknown>): string {
    try {
      const payload = decoded.payload as Record<string, unknown> | undefined
      const txBase64 = payload?.transaction as string | undefined
      if (txBase64) {
        const buf = Buffer.from(txBase64, 'base64')
        let allSigs: Array<Uint8Array | null>
        try {
          const versionedTx = VersionedTransaction.deserialize(buf)
          allSigs = versionedTx.signatures
        } catch {
          const legacyTx = Transaction.from(buf)
          allSigs = legacyTx.signatures.map((s) => s.signature)
        }
        // Skip unsigned placeholder slots (all zeros) — e.g. the facilitator fee payer.
        const sigBytes = allSigs.find((s) => s && s.length > 0 && s.some((b) => b !== 0))
        if (sigBytes) {
          return 'x402v2:' + Buffer.from(sigBytes).toString('base64')
        }
      }
    } catch {
      // Fall through to hash fallback below
    }
    return 'x402v2:' + createHash('sha256').update(paymentHeader).digest('hex')
  }

  /**
   * Atomically claim a replay key. Returns false if the key was already used.
   * Prefers the store's atomic addIfAbsent; falls back to non-atomic has()+add()
   * for stores that don't implement it.
   */
  private async claimReplayKey(key: string): Promise<boolean> {
    if (this.signatureStore.addIfAbsent) {
      return this.signatureStore.addIfAbsent(key)
    }
    const alreadyUsed = await this.signatureStore.has(key)
    if (alreadyUsed) {
      return false
    }
    await this.signatureStore.add(key)
    return true
  }

  /**
   * Release a previously claimed replay key (best effort — requires the store to
   * implement delete). Used when verification or blocking settlement fails, so the
   * client can retry the identical signed transaction instead of being locked out.
   */
  private async releaseReplayKey(key: string): Promise<void> {
    if (this.signatureStore.delete) {
      await this.signatureStore.delete(key)
    }
  }

  /**
   * Release the replay claim for a v2 payment header whose blocking settlement failed.
   * No funds moved and no content was served, so the same signed transaction must stay
   * retryable — resubmitting the identical transaction is idempotent on-chain, whereas
   * forcing the client to re-sign a fresh one risks double payment if the original
   * settle actually broadcast before erroring. No-op for Solana Pay payloads (their
   * funds already moved at verify time) and for stores without delete support.
   */
  async releaseReplayProtection(paymentHeader: string): Promise<void> {
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
      if ('x402Version' in decoded && decoded.x402Version === 2) {
        await this.releaseReplayKey(this.getV2ReplayKey(paymentHeader, decoded))
      }
    } catch {
      // Nothing to release for undecodable headers
    }
  }

  /**
   * Verify payment using x402 facilitator with fallback to on-chain
   * paymentHeader should be raw base64 string from extractPayment
   */
  async verifyPayment(
    paymentHeader: string,
    paymentRequirements: PaymentRequirements
  ): Promise<PaymentVerification> {
    // Decode base64 to get payment payload
    let decoded: Record<string, unknown>
    try {
      decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
    } catch {
      return {
        valid: false,
        signature: '',
        error: 'Invalid payment header format',
      }
    }

    // Determine if this is a v2 x402 payload or a Solana Pay (v1-style) payload
    // v2: { x402Version: 2, resource: {...}, accepted: {...}, payload: {...} }
    // Solana Pay: { signature: "tx-sig", scheme: "exact" }
    const isV2Payload = 'x402Version' in decoded && decoded.x402Version === 2
    const signature = isV2Payload ? '' : (decoded.signature as string)

    if (!isV2Payload && !signature) {
      return {
        valid: false,
        signature: '',
        error: 'No signature provided',
      }
    }

    // Check for replay attack (only for Solana Pay flow where we have a known signature)
    if (signature) {
      const alreadyUsed = await this.signatureStore.has(signature)
      if (alreadyUsed) {
        return {
          valid: false,
          signature,
          error: 'Payment signature already used',
        }
      }
    }

    try {
      // v2 x402 payload: use facilitator (the proper x402 flow)
      if (isV2Payload) {
        debugLog('verify', 'v2 payload detected, using facilitator verification', {
          x402Version: decoded.x402Version,
        })

        // Claim the replay key BEFORE the facilitator round trip. A non-atomic
        // check-then-add here would let N concurrent requests with the same header
        // all pass the replay check while the (slow) facilitator call is in flight.
        const replayKey = this.getV2ReplayKey(paymentHeader, decoded)
        const claimed = await this.claimReplayKey(replayKey)
        if (!claimed) {
          debugLog('verify', 'v2 payload replay detected', { replayKey })
          return {
            valid: false,
            signature: '',
            error: 'Payment signature already used',
          }
        }

        try {
          const verified = await this.x402Handler.verifyPayment(paymentHeader, paymentRequirements)

          debugLog('verify', 'Facilitator response received', {
            result: verified as Record<string, unknown>,
          })

          if (verified && verified.isValid) {
            debugLog('verify', 'Facilitator verification SUCCESS')
            return {
              valid: true,
              signature: '',
              amount: parseInt(paymentRequirements.amount),
            }
          }

          // Verification failed — no funds moved, so release the claim to keep the
          // header retryable (e.g. after a transient facilitator rejection).
          await this.releaseReplayKey(replayKey)
          return {
            valid: false,
            signature: '',
            error: verified?.invalidReason || 'Facilitator verification failed',
          }
        } catch (err) {
          await this.releaseReplayKey(replayKey)
          debugLog('verify', 'Facilitator verification failed', {
            error: err instanceof Error ? err.message : String(err),
          })
          return {
            valid: false,
            signature: '',
            error: err instanceof Error ? err.message : 'Facilitator verification failed',
          }
        }
      }

      // Solana Pay flow: verify directly on-chain (facilitator cannot handle pre-submitted tx)
      debugLog('verify', 'Solana Pay payload detected, using on-chain verification', { signature })
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

      const expectedAmount = parseInt(paymentRequirements.amount)
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
   * Settle payment through facilitator.
   *
   * v2 x402 flow: facilitator submits the signed transaction and settles — this is where
   * funds actually move, so the caller (middleware) should await this and treat a
   * 'failed' result as a hard failure rather than letting the protected handler run.
   * Solana Pay flow: transaction is already on-chain, settlement is a no-op that reports
   * the existing signature as already-settled.
   */
  async settlePayment(
    paymentHeader: string,
    paymentRequirements: PaymentRequirements
  ): Promise<SettlementResult> {
    if (!this.config.autoSettle) {
      debugLog('settle', 'Auto-settle disabled, skipping')
      return { status: 'skipped' }
    }

    // Detect payload type — skip facilitator for Solana Pay (v1-style) payloads
    let decoded: Record<string, unknown>
    try {
      decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'))
    } catch {
      return { status: 'failed', error: 'Invalid payment header format' }
    }

    if (!('x402Version' in decoded) || decoded.x402Version !== 2) {
      // Solana Pay flow: tx already submitted on-chain, no facilitator settlement needed
      debugLog('settle', 'Solana Pay flow detected, tx already on-chain, skipping facilitator')
      return { status: 'settled', signature: (decoded.signature as string) || null }
    }

    // v2 x402 flow: facilitator submits and settles the transaction
    try {
      debugLog('settle', 'v2 payload, initiating facilitator settlement')

      const settlement = await this.x402Handler.settlePayment(paymentHeader, paymentRequirements)

      debugLog('settle', 'Facilitator settlement response', {
        result: settlement as Record<string, unknown>,
      })

      if (settlement?.success) {
        return { status: 'settled', signature: settlement.transaction || null }
      }

      return {
        status: 'failed',
        error: settlement?.errorReason || settlement?.errorMessage || 'Settlement failed',
      }
    } catch (err) {
      debugLog('settle', 'Facilitator settlement failed', {
        error: err instanceof Error ? err.message : String(err),
      })
      return { status: 'failed', error: err instanceof Error ? err.message : 'Settlement failed' }
    }
  }

  /**
   * Check if multi-token mode is active.
   */
  isMultiToken(): boolean {
    return !!(this.config.acceptedTokens && this.config.acceptedTokens.length > 0)
  }

  /**
   * Create x402 payment requirements for multiple accepted tokens.
   */
  async createMultiTokenPaymentChallenge(
    payment: PaymentRequest,
    resource: string
  ): Promise<{
    paymentRequirements: PaymentRequirements[]
    solanaPayUrl: SolanaPayUrl
    resource: string
  }> {
    const tokens = this.getEffectiveTokens()
    const baseAmount = typeof payment.amount === 'number'
      ? payment.amount.toString()
      : payment.amount

    const requirementPromises = tokens.map(async (token) => {
      const tokenAmount = await this.resolveTokenAmount(token, baseAmount)
      const routeConfig = {
        amount: tokenAmount,
        asset: { address: token.mint.toString(), decimals: token.decimals },
        description: payment.label || this.config.label,
      }
      return this.x402Handler.createPaymentRequirements(routeConfig, resource)
    })

    const paymentRequirements = await Promise.all(requirementPromises)
    const solanaPayUrl = await this.createSolanaPayUrl(payment)

    return { paymentRequirements, solanaPayUrl, resource }
  }

  /**
   * Create 402 response with multiple accepted payment requirements.
   */
  create402ResponseMultiToken(
    paymentRequirements: PaymentRequirements[],
    resourceUrl: string
  ): { status: 402; body: Record<string, unknown> } {
    return {
      status: 402,
      body: {
        x402Version: 2,
        resource: {
          url: resourceUrl,
          description: (paymentRequirements[0]?.extra?.description as string) || '',
          mimeType: 'application/json',
        },
        accepts: paymentRequirements,
        error: 'Payment required',
      },
    }
  }

  private getEffectiveTokens(): Array<{
    mint: PublicKey
    decimals: number
    amount?: number | string | ((baseAmount: number | string) => number | string | Promise<number | string>)
  }> {
    if (this.config.acceptedTokens && this.config.acceptedTokens.length > 0) {
      return this.config.acceptedTokens
    }
    return [{
      mint: this.config.splToken?.mint ?? new PublicKey(SOL_MINT),
      decimals: this.config.splToken?.decimals ?? SOL_DECIMALS,
    }]
  }

  private async resolveTokenAmount(
    token: { amount?: number | string | ((baseAmount: number | string) => number | string | Promise<number | string>) },
    baseAmount: string
  ): Promise<string> {
    if (!token.amount) {
      return baseAmount
    }
    if (typeof token.amount === 'function') {
      const result = await token.amount(baseAmount)
      return typeof result === 'number' ? result.toString() : result
    }
    return typeof token.amount === 'number' ? token.amount.toString() : token.amount
  }

  getConnection(): Connection {
    return this.connection
  }

  getX402Handler(): X402PaymentHandler {
    return this.x402Handler
  }
}
