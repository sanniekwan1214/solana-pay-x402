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

  describe('addIfAbsent', () => {
    it('returns true and stores the signature when absent', () => {
      expect(store.addIfAbsent('fresh-sig')).toBe(true)
      expect(store.has('fresh-sig')).toBe(true)
    })

    it('returns false when the signature is already present', () => {
      store.add('taken-sig')
      expect(store.addIfAbsent('taken-sig')).toBe(false)
    })

    it('only lets one of two claims for the same signature succeed', () => {
      const first = store.addIfAbsent('contested-sig')
      const second = store.addIfAbsent('contested-sig')
      expect(first).toBe(true)
      expect(second).toBe(false)
    })

    it('respects TTL like add', () => {
      store.addIfAbsent('short-claim', 500)
      vi.advanceTimersByTime(1500)
      expect(store.has('short-claim')).toBe(false)
    })
  })

  describe('delete', () => {
    it('removes a stored signature so it can be claimed again', () => {
      store.add('to-release')
      expect(store.has('to-release')).toBe(true)

      store.delete('to-release')

      expect(store.has('to-release')).toBe(false)
      expect(store.addIfAbsent('to-release')).toBe(true)
    })

    it('is a no-op for unknown signatures', () => {
      expect(() => store.delete('never-added')).not.toThrow()
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
