import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupTempRoots, createTempRepo, ENGINE_FILES_CORE, ENGINE_FILES_UTIL, installEngineRuntime, runNode } from '../_helpers.js'

afterEach(cleanupTempRoots)

const installCheckpoint = (root: string) => {
  installEngineRuntime(root, ['engine/cli/checkpoint.mjs', ...ENGINE_FILES_CORE, ...ENGINE_FILES_UTIL])
}

describe('artel-checkpoint', () => {
  it('appends a valid checkpoint event with all mandatory fields', () => {
    const root = createTempRepo()
    installCheckpoint(root)

    const result = runNode(
      root,
      ['engine/cli/checkpoint.mjs', '--completed', 'parsed feed', '--next', 'validate schema', '--artefact', 'src/feed.ts', '--notes', 'looking good'],
      {
        ARTEL_TASK: 'demo-task',
        ARTEL_ROLE: 'implementer',
        ARTEL_DISPATCH_ID: '01934f00-0000-7000-8000-000000000abc',
        ARTEL_TRACE_ID: '01934f00-0000-7000-8000-000000000def',
      },
    )
    expect(result.status).toBe(0)

    const events = readFileSync(join(root, '.artel', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      schema: 'v1',
      kind: 'workload',
      type: 'checkpoint',
      task: 'demo-task',
      dispatch_id: '01934f00-0000-7000-8000-000000000abc',
      trace_id: '01934f00-0000-7000-8000-000000000def',
      owner_role: 'implementer',
      last_completed_step: 'parsed feed',
      next_safe_step: 'validate schema',
      artefact: 'src/feed.ts',
      notes: 'looking good',
      fence_token: 0,
    })
    expect(events[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(events[0].cluster_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(events[0].instance_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects when --completed or --next is missing', () => {
    const root = createTempRepo()
    installCheckpoint(root)
    const env = { ARTEL_TASK: 't', ARTEL_ROLE: 'implementer', ARTEL_DISPATCH_ID: '01934f00-0000-7000-8000-000000000aaa' }
    const noCompleted = runNode(root, ['engine/cli/checkpoint.mjs', '--next', 'foo'], env)
    expect(noCompleted.status).not.toBe(0)
    expect(noCompleted.stderr).toMatch(/required/)

    const noNext = runNode(root, ['engine/cli/checkpoint.mjs', '--completed', 'foo'], env)
    expect(noNext.status).not.toBe(0)
  })

  it('rejects when ARTEL_DISPATCH_ID env missing', () => {
    const root = createTempRepo()
    installCheckpoint(root)
    const result = runNode(root, ['engine/cli/checkpoint.mjs', '--completed', 'a', '--next', 'b'], {
      ARTEL_TASK: 't', ARTEL_ROLE: 'implementer', ARTEL_DISPATCH_ID: '',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/ARTEL_DISPATCH_ID/)
  })

  it('trace_id defaults to dispatch_id when not provided', () => {
    const root = createTempRepo()
    installCheckpoint(root)
    const result = runNode(
      root,
      ['engine/cli/checkpoint.mjs', '--completed', 'a', '--next', 'b'],
      { ARTEL_TASK: 't', ARTEL_ROLE: 'implementer', ARTEL_DISPATCH_ID: '01934f00-0000-7000-8000-000000000bbb' },
    )
    expect(result.status).toBe(0)
    const events = readFileSync(join(root, '.artel', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    expect(events[0].trace_id).toBe('01934f00-0000-7000-8000-000000000bbb')
  })
})
