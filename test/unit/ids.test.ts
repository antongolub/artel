import { describe, expect, it } from 'vitest'
import { ids } from '../_helpers.js'

const { uuidv7 } = ids

describe('uuidv7', () => {
  it('produces 36-char hyphenated form with version-7 nibble', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is monotonically sortable across rapid calls (time-prefix)', () => {
    const xs: string[] = []
    for (let i = 0; i < 50; i++) xs.push(uuidv7())
    const sorted = [...xs].sort()
    for (let i = 1; i < sorted.length; i++) {
      // First 8 hex chars encode top 32 bits of ms timestamp — must be non-decreasing.
      expect(sorted[i].slice(0, 8) >= sorted[i - 1].slice(0, 8)).toBe(true)
    }
  })
})
