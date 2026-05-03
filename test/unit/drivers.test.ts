// Unit tests for engine/util/drivers.mjs — overlay-precedence loader (V6).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as driversModule from '../../engine/util/drivers.mjs'

type Mod = Record<string, unknown> & { args?: (...a: unknown[]) => unknown }

const { resolveDriverPath, listDrivers, loadDriver, discoverDrivers } = driversModule as {
  resolveDriverPath: (id: string) => { path: string; source: string } | null
  listDrivers: () => string[]
  loadDriver: (id: string) => Promise<{ id: string; source: string; path: string; module: Mod }>
  discoverDrivers: () => Promise<{ id: string; source: string; path: string; module: Mod }[]>
}

const tempRoots: string[] = []

const makeTemp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'artel-drivers-test-'))
  tempRoots.push(dir)
  return dir
}

const writeDriver = (dir: string, id: string, body: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.mjs`), body)
}

const minimalDriver = (label: string) =>
  `export const id = '${label}'\nexport const command = '${label}'\nexport const api_version = 1\nexport function args () { return ['from-${label}'] }\n`

let savedProject: string | undefined
let savedUser: string | undefined

beforeEach(() => {
  savedProject = process.env.ARTEL_PROJECT_DIR
  savedUser = process.env.ARTEL_USER_DRIVERS_DIR
})

afterEach(() => {
  if (savedProject) process.env.ARTEL_PROJECT_DIR = savedProject
  else delete process.env.ARTEL_PROJECT_DIR
  if (savedUser) process.env.ARTEL_USER_DRIVERS_DIR = savedUser
  else delete process.env.ARTEL_USER_DRIVERS_DIR
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('resolveDriverPath / listDrivers', () => {
  it('returns platform drivers when no overlays present', () => {
    process.env.ARTEL_PROJECT_DIR = makeTemp()
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    expect(listDrivers()).toEqual(expect.arrayContaining(['claude', 'codex', 'copilot']))
    const claude = resolveDriverPath('claude')
    expect(claude?.source).toBe('platform')
    expect(claude?.path).toMatch(/engine\/drivers\/claude\.mjs$/)
  })

  it('project overlay wins over user overlay and platform', () => {
    const project = makeTemp()
    const userHome = makeTemp()
    process.env.ARTEL_PROJECT_DIR = project
    process.env.ARTEL_USER_DRIVERS_DIR = userHome
    writeDriver(join(project, '.artel', 'drivers'), 'claude', minimalDriver('project-claude'))
    writeDriver(userHome, 'claude', minimalDriver('user-claude'))
    const hit = resolveDriverPath('claude')
    expect(hit?.source).toBe('project')
    expect(hit?.path).toContain(project)
  })

  it('user overlay wins over platform when project has no override', () => {
    const project = makeTemp()
    const userHome = makeTemp()
    process.env.ARTEL_PROJECT_DIR = project
    process.env.ARTEL_USER_DRIVERS_DIR = userHome
    writeDriver(userHome, 'claude', minimalDriver('user-claude'))
    const hit = resolveDriverPath('claude')
    expect(hit?.source).toBe('user')
    expect(hit?.path).toContain(userHome)
  })

  it('returns null for unknown engine ids', () => {
    process.env.ARTEL_PROJECT_DIR = makeTemp()
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    expect(resolveDriverPath('frobnicate')).toBeNull()
  })

  it('listDrivers includes overlay-only engines', () => {
    const project = makeTemp()
    process.env.ARTEL_PROJECT_DIR = project
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    writeDriver(join(project, '.artel', 'drivers'), 'custom-llama', minimalDriver('custom-llama'))
    expect(listDrivers()).toContain('custom-llama')
  })
})

describe('loadDriver', () => {
  it('imports and returns the resolved module', async () => {
    process.env.ARTEL_PROJECT_DIR = makeTemp()
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    const r = await loadDriver('claude')
    expect(r.source).toBe('platform')
    expect(typeof r.module.args).toBe('function')
  })

  it('throws on unknown engine id with helpful list', async () => {
    process.env.ARTEL_PROJECT_DIR = makeTemp()
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    await expect(loadDriver('does-not-exist')).rejects.toThrow(/Unknown engine: does-not-exist/)
  })

  it('rejects driver missing required `args` export', async () => {
    const project = makeTemp()
    process.env.ARTEL_PROJECT_DIR = project
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    writeDriver(
      join(project, '.artel', 'drivers'),
      'broken',
      `export const id = 'broken'\n`,
    )
    await expect(loadDriver('broken')).rejects.toThrow(/missing required export `args/)
  })
})

describe('discoverDrivers', () => {
  it('loads every visible driver including project overlays', async () => {
    const project = makeTemp()
    process.env.ARTEL_PROJECT_DIR = project
    process.env.ARTEL_USER_DRIVERS_DIR = makeTemp()
    writeDriver(join(project, '.artel', 'drivers'), 'custom', minimalDriver('custom'))
    const drivers = await discoverDrivers()
    const ids = drivers.map((d) => d.id)
    expect(ids).toContain('custom')
    expect(ids).toContain('claude')
    const custom = drivers.find((d) => d.id === 'custom')!
    expect(custom.source).toBe('project')
  })
})
