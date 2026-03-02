import express from 'express'
import { solanaPay402, getPaymentInfo } from 'solana-pay-x402/express'

const app = express()
app.use(express.json())

app.get(
  '/api/premium-data',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    recipient: process.env.MERCHANT_WALLET || 'YOUR_WALLET_ADDRESS_HERE',
    network: 'devnet',
    label: 'Premium Data Access',
    message: 'Payment for premium data',
    getPaymentAmount: () => 0.01 * 1e9,
  }),
  (req, res) => {
    const payment = getPaymentInfo(req)

    res.json({
      message: 'Premium data access granted!',
      data: {
        secret: 'This is premium content',
        timestamp: new Date().toISOString(),
      },
      payment: {
        signature: payment?.signature,
        amount: payment?.amount,
        sender: payment?.sender,
      },
    })
  }
)

app.get(
  '/api/data/:size',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    recipient: process.env.MERCHANT_WALLET || 'YOUR_WALLET_ADDRESS_HERE',
    network: 'devnet',

    getPaymentAmount: (req) => {
      const size = req.params.size
      const basePrice = 0.001
      if (size === 'small') return basePrice * 1e9
      if (size === 'medium') return basePrice * 5 * 1e9
      if (size === 'large') return basePrice * 10 * 1e9
      return null
    },

    getPaymentMetadata: (req) => ({
      dataSize: req.params.size,
      requestPath: req.path,
    }),

    onPaymentVerified: (req, verification) => {
      console.log('Payment verified:', verification.signature)
    },

    onPaymentFailed: (req, error) => {
      console.error('Payment failed:', error)
    },
  }),
  (req, res) => {
    const size = req.params.size
    const payment = getPaymentInfo(req)

    res.json({
      message: `Data package (${size}) delivered`,
      data: generateDataBySize(size),
      payment: {
        signature: payment?.signature,
        amount: payment?.amount,
      },
    })
  }
)

// Multi-token pricing: accept USDC or SOL for the same endpoint
// The amount converter can be async — fetch live exchange rates
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL_MINT = 'So11111111111111111111111111111111111111112'

async function usdcToSol(baseAmount: number | string): Promise<string> {
  // Fetch live SOL price from Jupiter (or your preferred oracle)
  const resp = await fetch(`https://api.jup.ag/price/v2?ids=${SOL_MINT}`)
  const data = await resp.json()
  const solPrice = parseFloat(data.data?.[SOL_MINT]?.price) || 150
  const usdcDisplay = Number(baseAmount) / 1e6
  return Math.round((usdcDisplay / solPrice) * 1e9).toString()
}

app.get(
  '/api/multi-token',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    recipient: process.env.MERCHANT_WALLET || 'YOUR_WALLET_ADDRESS_HERE',
    network: 'devnet',
    label: 'Multi-Token API',
    acceptedTokens: [
      { mint: USDC_MINT, decimals: 6, label: 'USDC' },                        // base price
      { mint: SOL_MINT, decimals: 9, amount: usdcToSol, label: 'SOL' },       // live rate
    ],
    getPaymentAmount: () => 100000, // 0.10 USDC
  }),
  (req, res) => {
    const payment = getPaymentInfo(req)
    res.json({
      message: 'Paid with your choice of token!',
      payment: {
        signature: payment?.signature,
        amount: payment?.amount,
      },
    })
  }
)

app.get('/api/free-data', (req, res) => {
  res.json({
    message: 'Free endpoint',
    data: { public: 'information' },
  })
})

app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

function generateDataBySize(size: string) {
  const datasets: Record<string, { records: number; type: string }> = {
    small: { records: 10, type: 'basic' },
    medium: { records: 100, type: 'standard' },
    large: { records: 1000, type: 'comprehensive' },
  }
  return datasets[size] || { records: 0, type: 'unknown' }
}

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
