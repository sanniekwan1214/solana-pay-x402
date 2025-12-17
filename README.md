# Solana Pay x402

Express middleware for integrating **Solana Pay** with the **x402 HTTP payment protocol**. This package combines Solana Pay's familiar QR code/URL flow with x402's HTTP-native payment verification and settlement.

## What is this?

This package bridges two payment standards:

- **Solana Pay**: Protocol for Solana blockchain payments with QR codes and deep wallet links
- **x402**: HTTP-native payment protocol using status code 402 for payment-gated resources

The result: Accept Solana payments in your Express API using standard HTTP 402 responses, verified through the PayAI Network facilitator.

## Features

- Simple Express middleware - One-line integration for payment-gated routes
- Solana Pay compatible - Works with Phantom, Solflare, and other Solana wallets
- True x402 protocol - Uses x402-solana package with facilitator verification
- Dynamic pricing - Set prices per-request based on any logic
- Auto-settlement - Optional automatic payment settlement via facilitator
- TypeScript-first - Full type safety throughout
- Flexible - Supports both SOL and SPL tokens (USDC, USDT, etc.)

## Installation

```bash
npm install solana-pay-x402
```

## Quick Start

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
    res.json({ content: 'Premium content!' })
  }
)

app.listen(3000)
```

## How It Works

### The Payment Flow

1. **Client requests resource** - `GET /api/premium`
2. **Server responds with 402** - Returns Solana Pay URL + x402 payment requirements
3. **Client pays with wallet** - User scans QR or clicks URL, approves in Phantom/Solflare
4. **Client retries with proof** - Sends request with payment proof in headers
5. **Server verifies via facilitator** - Payment verified through PayAI Network
6. **Server delivers content** - Request proceeds to your route handler

### Example 402 Response

```json
{
  "error": "Payment Required",
  "message": "Please complete payment to access this resource",
  "solanaPay": {
    "url": "solana:RECIPIENT?amount=0.01&label=Payment",
    "reference": "Bx7j8K..."
  },
  "x402": {
    "version": 1,
    "price": {
      "amount": "10000000",
      "asset": {
        "address": "So11111111111111111111111111111111111111112",
        "decimals": 9
      }
    }
  },
  "instructions": {
    "step1": "Open Solana wallet (Phantom, Solflare, etc.)",
    "step2": "Scan QR code or use URL: solana:...",
    "step3": "Approve the payment in your wallet",
    "step4": "Retry request with payment proof in headers"
  }
}
```

## Configuration

### Basic Options

```typescript
interface SolanaPayX402Config {
  /** Solana RPC endpoint */
  rpcUrl: string

  /** Your wallet address (receives payments) */
  recipient: string

  /** x402 facilitator URL (default: PayAI Network) */
  facilitatorUrl?: string

  /** Network: 'mainnet-beta' | 'devnet' | 'testnet' */
  network?: string

  /** Payment label (shown in wallet) */
  label?: string

  /** Payment message/memo */
  message?: string

  /** SPL token mint (optional, defaults to SOL) */
  splToken?: string

  /** Enable automatic settlement (default: true) */
  autoSettle?: boolean
}
```

### Middleware Options

```typescript
interface ExpressMiddlewareOptions extends SolanaPayX402Config {
  /** Determine payment amount for each request */
  getPaymentAmount: (req: Request) => number | null

  /** Optional: Add custom metadata */
  getPaymentMetadata?: (req: Request) => Record<string, unknown>

  /** Optional: Generate custom payment reference */
  getReference?: (req: Request) => string

  /** Optional: Called when payment verified */
  onPaymentVerified?: (req: Request, verification: any) => void

  /** Optional: Called when payment fails */
  onPaymentFailed?: (req: Request, error: string) => void
}
```

## Examples

### Dynamic Pricing

```typescript
app.get('/api/data/:size',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL,
    recipient: process.env.MERCHANT_WALLET,
    network: 'devnet',

    getPaymentAmount: (req) => {
      const { size } = req.params
      if (size === 'small') return 0.001 * 1e9
      if (size === 'medium') return 0.005 * 1e9
      if (size === 'large') return 0.01 * 1e9
      return null // Free for unknown sizes
    },
  }),
  (req, res) => {
    res.json({ data: `Content for ${req.params.size}` })
  }
)
```

### Payment Tracking

```typescript
app.get('/api/premium',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL,
    recipient: process.env.MERCHANT_WALLET,
    network: 'devnet',
    getPaymentAmount: () => 0.01 * 1e9,

    onPaymentVerified: (req, verification) => {
      console.log('Payment received:', {
        signature: verification.signature,
        amount: verification.amount,
        settlement: verification.settlementSignature,
      })
    },

    onPaymentFailed: (req, error) => {
      console.error('Payment failed:', error)
    },
  }),
  (req, res) => {
    const payment = getPaymentInfo(req)
    res.json({
      content: 'Premium content',
      payment,
    })
  }
)
```

### SPL Token Payments (USDC)

```typescript
app.get('/api/premium',
  solanaPay402({
    rpcUrl: process.env.SOLANA_RPC_URL,
    recipient: process.env.MERCHANT_WALLET,
    network: 'devnet',

    // USDC devnet mint
    splToken: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',

    // 1 USDC (6 decimals)
    getPaymentAmount: () => 1 * 1e6,
  }),
  (req, res) => {
    res.json({ content: 'Paid with USDC!' })
  }
)
```

## Client-Side Integration

Clients can use the x402-solana client package for automatic payment handling:

```typescript
import { createX402Client } from 'x402-solana/client'
import { useWallet } from '@solana/wallet-adapter-react'

function MyComponent() {
  const wallet = useWallet()

  const client = createX402Client({
    wallet: {
      address: wallet.publicKey.toString(),
      signTransaction: async (tx) => await wallet.signTransaction(tx),
    },
    network: 'solana-devnet',
  })

  const response = await client.fetch('/api/premium')
  const data = await response.json()
}
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Development mode
npm run dev
```

## Environment Variables

Create a `.env` file:

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
MERCHANT_WALLET=YOUR_WALLET_ADDRESS
PORT=3000
```

## Use Cases

- API Metering - Charge per API call or by data volume
- Premium Features - Gate advanced features behind micropayments
- Content Access - Pay-per-view for digital content
- AI/ML APIs - Monetize compute-intensive endpoints
- Data Downloads - Charge for exported data or reports

## How This Differs from x402-solana

| Feature | solana-pay-x402 | x402-solana |
|---------|----------------|-------------|
| Purpose | Express middleware + Solana Pay UX | Framework-agnostic x402 implementation |
| Solana Pay URLs | Built-in QR code generation | Manual implementation needed |
| Express integration | One-line middleware | Manual setup required |
| Facilitator | PayAI Network (configurable) | Any facilitator |
| Best for | Quick Express API setup | Custom implementations |

## x402 Facilitator

This package uses the PayAI Network facilitator by default. The facilitator:
- Verifies payment signatures
- Handles on-chain settlement
- Provides payment guarantees
- Currently covers all transaction fees (on devnet)

You can use a custom facilitator by setting the `facilitatorUrl` option.

## Roadmap

- Support for Fastify framework
- QR code image generation
- Payment session caching with Redis
- Webhook notifications
- Admin dashboard for payment tracking

## Contributing

Contributions welcome! Please open an issue or PR.

## License

Apache-2.0

## Links

- [Solana Pay Docs](https://docs.solanapay.com/)
- [x402 Protocol](https://www.x402.org/)
- [x402-solana Package](https://www.npmjs.com/package/x402-solana)
- [PayAI Network Facilitator](https://facilitator.payai.network)

---

Built for the Solana ecosystem
