import { describe, expect, it } from 'vitest'
import { schema } from '../_helpers.js'

const { validateEventType, SCHEMA_VERSION, VALID_KINDS } = schema

describe('SCHEMA_VERSION', () => {
  it('is v1', () => {
    expect(SCHEMA_VERSION).toBe('v1')
  })
})

describe('VALID_KINDS', () => {
  it('covers the four axes', () => {
    for (const k of ['workload', 'infra', 'signal', 'control']) {
      expect(VALID_KINDS.has(k)).toBe(true)
    }
  })
})

describe('validateEventType', () => {
  it('accepts known workload types', () => {
    for (const t of [
      'dispatch.start', 'dispatch.end', 'checkpoint', 'parked',
      'queue_node.registered',
      // V3.4.a + V3.7.b + V3.10.e — pipeline lifecycle events
      'pipeline.registered', 'pipeline_run.started', 'pipeline_run.ended',
      'pipeline_handler.start', 'pipeline_handler.end',
      'pipeline_subpipeline.start', 'pipeline_subpipeline.end',
    ]) {
      expect(() => validateEventType('workload', t)).not.toThrow()
    }
  })

  it('accepts known infra types', () => {
    for (const t of ['cluster.heartbeat', 'role.registered', 'engine.available']) {
      expect(() => validateEventType('infra', t)).not.toThrow()
    }
  })

  it('accepts reserved control / signal namespaces', () => {
    expect(() => validateEventType('control', 'control.claim.requested')).not.toThrow()
    expect(() => validateEventType('control', 'control.peer.observed')).not.toThrow()
    expect(() => validateEventType('signal', 'signal.backoff_required')).not.toThrow()
  })

  it('accepts legacy claim / release for one cycle', () => {
    expect(() => validateEventType('workload', 'claim')).not.toThrow()
    expect(() => validateEventType('workload', 'release')).not.toThrow()
  })

  it('rejects unknown kind', () => {
    expect(() => validateEventType('garbage', 'whatever')).toThrow(/Invalid event kind/)
  })

  it('rejects unknown type within a kind', () => {
    expect(() => validateEventType('workload', 'something.unknown')).toThrow(/not in reserved/)
    expect(() => validateEventType('infra', 'unknown.thing')).toThrow(/not in reserved/)
    expect(() => validateEventType('signal', 'control.claim.requested')).toThrow(/not in reserved/)
  })
})
