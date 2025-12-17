import express, { Request, Response } from 'express'
import path from 'path'
import { solanaPay402, getPaymentInfo } from '../src'

const app = express()
const PORT = process.env.PORT || 3000

const NETWORK = (process.env.SOLANA_NETWORK || 'mainnet-beta') as 'mainnet-beta' | 'devnet'
const RPC_URL = process.env.SOLANA_RPC_URL || (NETWORK === 'devnet'
  ? 'https://api.devnet.solana.com'
  : 'https://api.mainnet-beta.solana.com')
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || 'ACkPDYU2KiZ6nv24cF7aRu5ePY2jHMfE55YJNcEuVGv8'

// USDC on Solana mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDC_DECIMALS = 6

function log(level: string, message: string, data?: Record<string, unknown>) {
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`
  if (data) {
    console.log(`${prefix} ${message}`, JSON.stringify(data, null, 2))
  } else {
    console.log(`${prefix} ${message}`)
  }
}

app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json())

app.use((req: Request, _res: Response, next) => {
  log('req', `${req.method} ${req.path}`)
  next()
})

console.log('\n┌─────────────────────────────────────────┐')
console.log('│        Solana Pay x402 Demo             │')
console.log('├─────────────────────────────────────────┤')
console.log(`│  Network:  ${NETWORK.padEnd(28)}│`)
console.log(`│  Wallet:   ${MERCHANT_WALLET.slice(0, 8)}...${MERCHANT_WALLET.slice(-4).padEnd(17)}│`)
console.log(`│  RPC:      ${RPC_URL.slice(0, 28).padEnd(28)}│`)
console.log('└─────────────────────────────────────────┘\n')

// Prices in USDC (6 decimals)
const pricing: Record<string, number> = {
  content: 0.00001 * 1e6,      // $0.00001 USDC (10 units)
  basic: 0.00005 * 1e6,        // $0.00005 USDC (50 units)
  premium: 0.0001 * 1e6,       // $0.0001 USDC (100 units)
  enterprise: 0.0005 * 1e6,    // $0.0005 USDC (500 units)
}

app.get('/api/content',
  solanaPay402({
    rpcUrl: RPC_URL,
    recipient: MERCHANT_WALLET,
    network: NETWORK,
    label: 'Content Access',
    autoSettle: true,
    splToken: { mint: USDC_MINT, decimals: USDC_DECIMALS },
    getPaymentAmount: () => pricing.content,
    onPaymentVerified: (req, verification) => {
      log('payment', 'verified', {
        endpoint: req.path,
        signature: verification.signature,
        amount: verification.amount,
        settlement: verification.settlementSignature || 'pending',
      })
    },
    onPaymentFailed: (req, error) => {
      log('payment', 'failed', { endpoint: req.path, error })
    },
  }),
  (_req: Request, res: Response) => {
    const payment = getPaymentInfo(_req)
    res.json({
      data: { id: 1, type: 'premium', content: 'Protected content payload' },
      payment: { sig: payment?.signature, amount: payment?.amount },
    })
  }
)

app.get('/api/data/:tier',
  solanaPay402({
    rpcUrl: RPC_URL,
    recipient: MERCHANT_WALLET,
    network: NETWORK,
    label: 'Data API',
    autoSettle: true,
    splToken: { mint: USDC_MINT, decimals: USDC_DECIMALS },
    getPaymentAmount: (req) => pricing[req.params.tier] || null,
    onPaymentVerified: (req, verification) => {
      log('payment', 'verified', {
        endpoint: req.path,
        tier: req.params.tier,
        signature: verification.signature,
        amount: verification.amount,
      })
    },
    onPaymentFailed: (req, error) => {
      log('payment', 'failed', { endpoint: req.path, tier: req.params.tier, error })
    },
  }),
  (req: Request, res: Response) => {
    const { tier } = req.params
    const payment = getPaymentInfo(req)
    const records: Record<string, number> = { basic: 10, premium: 100, enterprise: 1000 }
    res.json({
      tier,
      records: records[tier] || 0,
      data: Array.from({ length: Math.min(records[tier] || 0, 3) }, (_, i) => ({ id: i + 1 })),
      payment: { sig: payment?.signature, amount: payment?.amount },
    })
  }
)

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', network: NETWORK, wallet: MERCHANT_WALLET, pricing })
})

app.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`)
  console.log('\nEndpoints:')
  console.log(`  GET /api/content         $${(pricing.content / 1e6).toFixed(5)} USDC`)
  console.log(`  GET /api/data/basic      $${(pricing.basic / 1e6).toFixed(5)} USDC`)
  console.log(`  GET /api/data/premium    $${(pricing.premium / 1e6).toFixed(4)} USDC`)
  console.log(`  GET /api/data/enterprise $${(pricing.enterprise / 1e6).toFixed(4)} USDC`)
  console.log(`  GET /api/health          free\n`)
})
