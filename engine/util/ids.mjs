// Generic id generator. Used for event ids (schema), in-prompt separators
// (drivers), and anywhere else a unique identifier is needed.

import { randomBytes } from 'node:crypto'

// UUID v7: 48-bit unix-ms timestamp + 4-bit version + 12 bits + 2-bit
// variant + 62 bits random. Time-prefix gives lexicographic sort = causal
// order; collision resistance dominated by 74 random bits — sufficient
// for our scale.
export function uuidv7 () {
  const ms = Date.now()
  const random = randomBytes(10)
  const buf = Buffer.alloc(16)
  buf.writeUIntBE(ms, 0, 6)
  buf[6] = 0x70 | (random[0] & 0x0f)
  buf[7] = random[1]
  buf[8] = 0x80 | (random[2] & 0x3f)
  buf[9] = random[3]
  random.copy(buf, 10, 4, 10)
  const hex = buf.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
