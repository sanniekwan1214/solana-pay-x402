# Solana Pay x402

Express middleware that puts any API endpoint behind a Solana payment. Drop it into a route and your endpoint returns `402 Payment Required` until the client pays.

Two payment flows, one middleware — the server figures out which one the client is using:

- **x402 v2**: Client signs a transaction, facilitator submits it and pays gas. Good for dApps, APIs, and anything programmatic.
- **Solana Pay**: Client scans a QR code with a mobile wallet, pays on-chain directly. Good for mobile, retail, POS.

## Quick Start

```bash
npm install solana-pay-x402
```

```typescript
import express from 'express'
import { solanaPay402 } from 'solana-pay-x402/express'

const app = express()

app.get('/api/premium',
  solanaPay402({
    rpcUrl: 'https://api.devnet.solana.com',
    recipient: 'YOUR_WALLET_ADDRESS',
    network: 'devnet',
    getPaymentAmount: () => 0.01 * 1e9, // 0.01 SOL in lamports
  }),
  (req, res) => {
    res.json({ content: 'You paid for this.' })
  }
)

app.listen(3000)
```

That's it. The middleware handles the 402 response, payment verification, and settlement.

## How It Works

### x402 v2 Flow (Programmatic)

```
Client                    Server                   Facilitator
  |-- GET /api/premium ----->|                          |
  |<---- 402 + requirements -|                          |
  |                          |                          |
  | (build tx, sign with wallet, don't submit)          |
  |                          |                          |
  |-- GET /api/premium ----->|                          |
  |   + PAYMENT-SIGNATURE    |-- verify + settle ------>|
  |                          |<---- ok, tx submitted ---|
  |<---- 200 + content ------|                          |
```

The client signs a transaction but never submits it. The facilitator submits it, verifies payment, and covers gas fees. This is the x402 protocol — the client just uses `createX402Client` from `x402-solana/client` and it handles everything behind a `fetch()` call.

### Solana Pay Flow (QR Code)

```
Client                    Server                   Solana
  |-- GET /api/premium ----->|                        |
  |<---- 402 + QR URL ------|                        |
  |                          |                        |
  | (scan QR, wallet submits tx on-chain)             |
  |                          |                   tx on-chain
  |-- GET /api/premium ----->|                        |
  |   + PAYMENT-SIGNATURE    |-- getTransaction ----->|
  |     (tx signature)       |<---- tx details -------|
  |<---- 200 + content ------|                        |
```

The client scans a QR code, their wallet submits the transaction directly on-chain, and the client sends the transaction signature back. The server verifies on-chain.

### 402 Response

When a request hits a gated endpoint without payment, the response includes both payment options:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "10",
    "payTo": "YOUR_WALLET",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "extra": { "feePayer": "..." }
  }],
  "solanaPay": {
    "url": "solana:YOUR_WALLET?amount=0.00001&spl-token=EPjFW...",
    "reference": "Bx7j8K..."
  }
}
```

x402 clients read the `accepts` array. Solana Pay clients use the `solanaPay.url` for QR codes. The middleware auto-detects which flow the client used when they come back with the `PAYMENT-SIGNATURE` header.

## Configuration

```typescript
solanaPay402({
  // Required
  rpcUrl: 'https://api.devnet.solana.com',
  recipient: 'YOUR_WALLET_ADDRESS',
  getPaymentAmount: (req) => 1000000,  // return null to skip payment

  // Optional
  network: 'devnet',                    // default: 'mainnet-beta'
  label: 'My API',                      // shown in wallet
  message: 'Thanks for paying',         // memo field
  autoSettle: true,                     // default: true
  facilitatorUrl: 'https://...',        // default: PayAI Network

  // SPL token (defaults to native SOL)
  splToken: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    decimals: 6,
  },

  // Callbacks
  onPaymentVerified: (req, verification) => {
    console.log('Paid:', verification.signature, verification.amount)
  },
  onPaymentFailed: (req, error) => {
    console.error('Failed:', error)
  },
})
```

## Examples

### Dynamic Pricing

```typescript
const pricing = { small: 1000000, medium: 5000000, large: 10000000 }

app.get('/api/data/:size',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL,
    recipient: process.env.MERCHANT_WALLET,
    getPaymentAmount: (req) => pricing[req.params.size] || null,
  }),
  (req, res) => {
    res.json({ data: `Content for ${req.params.size}` })
  }
)
```

### USDC Payments

```typescript
app.get('/api/premium',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL,
    recipient: process.env.MERCHANT_WALLET,
    splToken: {
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
    },
    getPaymentAmount: () => 100, // $0.0001 USDC
  }),
  (req, res) => {
    res.json({ content: 'Paid with USDC' })
  }
)
```

### Reading Payment Info After Verification

```typescript
import { getPaymentInfo } from 'solana-pay-x402/express'

app.get('/api/premium',
  solanaPay402({ /* config */ }),
  (req, res) => {
    const payment = getPaymentInfo(req)
    res.json({
      content: 'Premium stuff',
      paidAmount: payment?.amount,
      txSignature: payment?.signature,
    })
  }
)
```

## Client-Side: x402 v2

Use `x402-solana/client` for automatic payment handling. It wraps `fetch()` — if the server returns 402, it builds a transaction, asks the wallet to sign, and retries with the payment header. One line:

```typescript
import { createX402Client } from 'x402-solana/client'

const client = createX402Client({
  wallet: phantomWallet, // any Solana wallet adapter
  network: 'solana-devnet',
})

// This handles 402 → sign → retry automatically
const response = await client.fetch('http://localhost:3000/api/premium')
const data = await response.json()
```

## Client-Side: Solana Pay

For QR-based payments, the 402 response includes a `solanaPay.url` that you display as a QR code. After the user pays with their mobile wallet, send the transaction signature back:

```javascript
// 1. Request endpoint, get 402
const res = await fetch('/api/premium')
const { solanaPay } = await res.json()

// 2. Show QR code with solanaPay.url
displayQR(solanaPay.url)

// 3. After user pays and you have the tx signature
const proof = btoa(JSON.stringify({ signature: txSig, scheme: 'exact' }))
const content = await fetch('/api/premium', {
  headers: { 'PAYMENT-SIGNATURE': proof }
})
```

## Demo

The repo includes a working demo with both flows:

```bash
cd demo
SOLANA_NETWORK=devnet npx tsx server.ts
```

Open `http://localhost:3000` — pick an endpoint, try x402 with Phantom browser extension or Solana Pay with the QR code.

## How This Compares to x402-solana

| | solana-pay-x402 | x402-solana |
|---|---|---|
| What it is | Express middleware | Protocol implementation |
| Solana Pay QR | Built-in | Not included |
| x402 v2 | Built-in | Built-in |
| Setup | One-line middleware | Wire it up yourself |
| Best for | Ship fast on Express | Custom setups, other frameworks |

This package uses `x402-solana` under the hood. If you're on Express and want both payment flows without the plumbing, this is the shortcut.

## Development

```bash
npm install
npm run build
npm test
```

## Environment Variables

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
MERCHANT_WALLET=YOUR_WALLET_ADDRESS
SOLANA_NETWORK=devnet
PORT=3000
```

## Disclaimer

This software is provided as-is, without warranty. It has not been independently audited. Use at your own risk, especially on mainnet with real funds.

This package relies on the PayAI Network facilitator for x402 v2 payment verification and settlement. The authors are not responsible for facilitator downtime, failed transactions, or lost funds.

Always test on devnet before deploying to mainnet. The authors are not liable for any financial losses resulting from the use of this software. See LICENSE for full terms.

## License

MIT

## Links

- [x402 Protocol](https://www.x402.org/)
- [Solana Pay](https://docs.solanapay.com/)
- [x402-solana](https://www.npmjs.com/package/x402-solana)
- [PayAI Network](https://facilitator.payai.network)
