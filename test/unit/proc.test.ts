// Unit tests for engine/util/proc.mjs#parseDuration (V3.9.b).
// Shared parser for `dispatch.timeout_ms`, `handler.exec.timeout_ms`,
// and dispatchLifecycle's env / built-in fallback. Tested
// directly so the contract stays observable.

import { describe, expect, it } from 'vitest'
import { parseDuration } from '../../engine/util/proc.mjs'

describe('parseDuration (V3.9.b)', () => {
  it('returns null for null / undefined / empty string', () => {
    expect(parseDuration(null)).toBe(null)
    expect(parseDuration(undefined)).toBe(null)
    expect(parseDuration('')).toBe(null)
  })

  it('passes through positive integers as ms', () => {
    expect(parseDuration(1)).toBe(1)
    expect(parseDuration(60000)).toBe(60000)
  })

  it('parses suffix-strings into ms', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('60s')).toBe(60_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1d')).toBe(86_400_000)
  })

  it('parses bare-number strings as ms (no suffix)', () => {
    expect(parseDuration('60')).toBe(60)
    expect(parseDuration('60000')).toBe(60_000)
  })

  it('trims leading/trailing whitespace; rejects internal whitespace', () => {
    expect(parseDuration(' 60s ')).toBe(60_000)
    expect(parseDuration('\t60s\n')).toBe(60_000)
    expect(() => parseDuration('60 s')).toThrow(/positive integer ms or string with suffix/)
    expect(() => parseDuration('5 m')).toThrow(/positive integer ms or string with suffix/)
  })

  it('rejects zero / negative / fractional numbers', () => {
    expect(() => parseDuration(0)).toThrow(/positive integer/)
    expect(() => parseDuration(-100)).toThrow(/positive integer/)
    expect(() => parseDuration(1.5)).toThrow(/positive integer/)
    expect(() => parseDuration('0s')).toThrow(/positive integer/)
  })

  it('rejects malformed strings', () => {
    expect(() => parseDuration('60x')).toThrow(/positive integer/)
    expect(() => parseDuration('abc')).toThrow(/positive integer/)
    expect(() => parseDuration('60sec')).toThrow(/positive integer/)
    expect(() => parseDuration('-60s')).toThrow(/positive integer/)
  })

  it('rejects Infinity / NaN', () => {
    expect(() => parseDuration(Infinity)).toThrow(/positive integer/)
    expect(() => parseDuration(NaN)).toThrow(/positive integer/)
  })

  it('rejects non-number / non-string types', () => {
    expect(() => parseDuration(true as unknown as number)).toThrow(/positive integer/)
    expect(() => parseDuration({} as unknown as number)).toThrow(/positive integer/)
    expect(() => parseDuration([] as unknown as number)).toThrow(/positive integer/)
  })

  it('uses the supplied label in error messages', () => {
    expect(() => parseDuration('bad', 'my field'))
      .toThrow(/^my field must be a positive integer/)
  })
})
