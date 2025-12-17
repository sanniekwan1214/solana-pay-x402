import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemorySignatureStore } from '../types'

describe('InMemorySignatureStore', () => {
  let store: InMemorySignatureStore

  beforeEach(() => {
    vi.useFakeTimers()
    store = new InMemorySignatureStore(1000) // 1 second cleanup interval
  })

  afterEach(() => {
    store.destroy()
    vi.useRealTimers()
  })

  describe('has', () => {
    it('returns false for unknown signature', () => {
      expect(store.has('unknown-sig')).toBe(false)
    })

    it('returns true for known signature', () => {
      store.add('test-sig')
      expect(store.has('test-sig')).toBe(true)
    })
  })

  describe('add', () => {
    it('adds signature to store', () => {
      store.add('new-sig')
      expect(store.has('new-sig')).toBe(true)
    })

    it('allows multiple signatures', () => {
      store.add('sig-1')
      store.add('sig-2')
      store.add('sig-3')
      expect(store.has('sig-1')).toBe(true)
      expect(store.has('sig-2')).toBe(true)
      expect(store.has('sig-3')).toBe(true)
    })
  })

  describe('cleanup', () => {
    it('removes expired signatures', () => {
      store.add('short-lived', 500) // 500ms TTL
      expect(store.has('short-lived')).toBe(true)

      // Advance time past TTL and cleanup interval
      vi.advanceTimersByTime(1500)

      expect(store.has('short-lived')).toBe(false)
    })

    it('keeps non-expired signatures', () => {
      store.add('long-lived', 5000) // 5 second TTL
      expect(store.has('long-lived')).toBe(true)

      // Advance time but not past TTL
      vi.advanceTimersByTime(1500)

      expect(store.has('long-lived')).toBe(true)
    })

    it('handles mixed expiry times', () => {
      store.add('expires-soon', 500)
      store.add('expires-later', 3000)

      vi.advanceTimersByTime(1500)

      expect(store.has('expires-soon')).toBe(false)
      expect(store.has('expires-later')).toBe(true)
    })
  })

  describe('destroy', () => {
    it('stops cleanup interval', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
      store.destroy()
      expect(clearIntervalSpy).toHaveBeenCalled()
    })

    it('can be called multiple times safely', () => {
      store.destroy()
      store.destroy() // Should not throw
    })
  })

  describe('replay attack prevention', () => {
    it('detects duplicate signatures', () => {
      const signature = '4WRtQDUsdpMVZN7TwT9EnAqZmAnKevuetMCnf6itBG2TD1brMgbGbyNjioS2gkHMPGjEDHd6o8xgNV118jAZKZK1'

      expect(store.has(signature)).toBe(false)
      store.add(signature)
      expect(store.has(signature)).toBe(true)

      // Simulating second request with same signature
      const isReplay = store.has(signature)
      expect(isReplay).toBe(true)
    })
  })
})
