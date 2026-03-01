/**
 * Debug utilities for x402 facilitator troubleshooting
 *
 * Usage: Set DEBUG_X402=true to enable verbose logging
 *
 * These utilities were used to diagnose facilitator 500 errors
 * and can be re-enabled for future debugging.
 */

export const DEBUG = process.env.DEBUG_X402 === 'true'

export function debugLog(category: string, message: string, data?: Record<string, unknown>) {
  if (!DEBUG) return
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [x402:${category}]`
  if (data) {
    console.log(`${prefix} ${message}`)
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(`${prefix} ${message}`)
  }
}

/**
 * Fetch interceptor for logging facilitator API calls
 * Call setupFetchInterceptor() once at startup to enable
 */
export function setupFetchInterceptor() {
  if (!DEBUG) return

  const originalFetch = global.fetch
  global.fetch = async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const urlStr = url.toString()
    const isFacilitator = urlStr.includes('facilitator') || urlStr.includes('payai')

    if (!isFacilitator) {
      return originalFetch(url, init)
    }

    const startTime = Date.now()

    console.log('\n' + '='.repeat(60))
    console.log('[FACILITATOR REQUEST]')
    console.log('='.repeat(60))
    console.log('Timestamp:', new Date().toISOString())
    console.log('URL:', urlStr)
    console.log('Method:', init?.method || 'GET')
    console.log('Headers:', JSON.stringify(init?.headers || {}, null, 2))

    if (init?.body && typeof init.body === 'string') {
      console.log('Request Body:')
      try {
        const parsed = JSON.parse(init.body)
        console.log(JSON.stringify(parsed, null, 2))
      } catch {
        console.log(init.body)
      }
    }

    const response = await originalFetch(url, init)
    const elapsed = Date.now() - startTime

    const clone = response.clone()
    const buffer = await clone.arrayBuffer()
    const bytes = Buffer.from(buffer)
    const bodyText = bytes.toString('utf-8')

    console.log('\n' + '-'.repeat(60))
    console.log('[FACILITATOR RESPONSE]')
    console.log('-'.repeat(60))
    console.log('Status:', response.status, response.statusText)
    console.log('Elapsed:', elapsed, 'ms')
    console.log('Headers:')
    response.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`)
    })

    console.log('Response Body:')
    try {
      const parsed = JSON.parse(bodyText)
      console.log(JSON.stringify(parsed, null, 2))
    } catch {
      console.log('  Raw (hex):', bytes.slice(0, 100).toString('hex'))
      console.log('  Raw (utf8):', bodyText.slice(0, 500))
    }

    if (response.status >= 500) {
      console.log('\n[ERROR] Server returned 5xx error - facilitator-side issue')
    }
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      console.log('\n[WARNING] Response appears GZIP compressed (magic: 1f8b)')
    }

    console.log('='.repeat(60) + '\n')

    return response
  }
}
