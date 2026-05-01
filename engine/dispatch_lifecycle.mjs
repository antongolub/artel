import { constants as osConstants } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDispatchApi } from './dispatch_api.mjs'
import { detectParked } from './parked.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Platform dir holds the role+engine skeleton (agents/, engine/, AGENTS.md). It
// is reusable across projects and lives alongside the engine sources — derive
// it from `here` so the engine self-locates regardless of where the platform
// was checked out.
const DEFAULT_PLATFORM_DIR = join(here, '..')
// Project dir is per-project: each consuming repo holds its own `.collab/`
// runtime (.dispatches/, .sessions/, events.jsonl, dispatcher_state.json,
// state.md, JOURNAL/QUEUE). Resolve from cwd (or env override) — never from
// `here`, since a single platform serves many projects.
const projectDirOf = () => process.env.COLLAB_PROJECT_DIR || process.cwd()
const projectCollabDirOf = (projectDir = projectDirOf()) => join(projectDir, '.collab')
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const TERMINATION_GRACE_MS = 10 * 1000
const PROTECTED_RESET_ROLES = new Set(['architect', 'cold-reader', 'adversary', 'maintainer'])

const frontmatterOf = (text) => {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const out = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (kv) out[kv[1]] = kv[2].trim()
  }
  return out
}

const dispatchPathsOf = ({
  platformDir = DEFAULT_PLATFORM_DIR,
  projectDir = projectDirOf(),
  projectCollabDir = projectCollabDirOf(projectDir),
} = {}) => {
  const engineDir = join(platformDir, 'engine')
  return {
    platformDir,
    projectDir,
    projectCollabDir,
    agentsDir: join(platformDir, 'agents'),
    driversDir: join(engineDir, 'drivers'),
    runPath: join(engineDir, 'run.mjs'),
    dispatchesDir: join(projectCollabDir, '.dispatches'),
    sessionsDir: join(projectCollabDir, '.sessions'),
    eventsPath: join(projectCollabDir, 'events.jsonl'),
  }
}

const listEngines = (driversDir, readdirImpl) =>
  existsSync(driversDir)
    ? readdirImpl(driversDir)
        .filter((name) => name.endsWith('.mjs'))
        .map((name) => name.replace(/\.mjs$/, ''))
    : []

const readRoleMeta = (role, agentsDir) => {
  const rolePath = join(agentsDir, `${role}.md`)
  if (!existsSync(rolePath)) {
    throw new Error(`Role not found: ${rolePath}`)
  }
  return frontmatterOf(readFileSync(rolePath, 'utf8'))
}

const parseTimeoutMs = (raw, label) => {
  if (raw === undefined || raw === null || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got: ${raw}`)
  }
  return value
}

const normalizeTimeoutMs = (timeoutMs) =>
  parseTimeoutMs(timeoutMs ?? process.env.COLLAB_DISPATCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, 'dispatch timeout')

const signalExitCode = (signal) => {
  if (!signal) return null
  const signum = osConstants.signals?.[signal]
  return typeof signum === 'number' ? 128 + signum : 1
}

const gitOk = (result) => result.status === 0

const gitText = (gitImpl, args) => {
  const result = gitImpl(args)
  return {
    ...result,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

const ensureCleanTaskSlug = (task) => {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/i.test(task)) {
    throw new Error(`Invalid task slug: "${task}" — must match /^[a-z0-9][a-z0-9-]{0,80}$/i`)
  }
}

const preparePersistentSession = ({ role, engineId, persistent, sessionsDir }) => {
  let sessionFlag = null
  let sessionId = null
  let captureCodexSession = false
  const sessionIdPath = join(sessionsDir, `${role}.${engineId}.id`)

  if (!persistent) {
    return { sessionFlag, sessionId, sessionIdPath, captureCodexSession }
  }

  mkdirSync(sessionsDir, { recursive: true })
  const legacyPath = join(sessionsDir, `${role}.id`)
  if (engineId === 'claude' && !existsSync(sessionIdPath) && existsSync(legacyPath)) {
    renameSync(legacyPath, sessionIdPath)
  }
  if (existsSync(sessionIdPath)) {
    sessionId = readFileSync(sessionIdPath, 'utf8').trim()
    sessionFlag = '--resume'
  } else if (engineId === 'codex') {
    captureCodexSession = true
  } else {
    sessionId = randomUUID()
    writeFileSync(sessionIdPath, sessionId + '\n')
    sessionFlag = '--session-id'
  }

  return { sessionFlag, sessionId, sessionIdPath, captureCodexSession }
}

const prepareBranch = ({ role, task, persistent, gitImpl, log }) => {
  if (persistent) return null

  const branch = `${role}/${task}`
  const dirty = gitText(gitImpl, ['status', '--porcelain']).stdout
  if (dirty.trim().length > 0) {
    throw new Error(
      `spawn: refusing to dispatch — working tree is dirty.\n` +
        `Commit, stash, or discard changes before dispatching '${branch}':\n` +
        dirty,
    )
  }

  const branchRef = `refs/heads/${branch}`
  const headShaResult = gitText(gitImpl, ['rev-parse', 'HEAD'])
  if (!gitOk(headShaResult)) {
    throw new Error(`spawn: git rev-parse HEAD failed:\n${headShaResult.stderr}`)
  }
  const headSha = headShaResult.stdout.trim()
  const branchShaResult = gitText(gitImpl, ['rev-parse', '--verify', '--quiet', branchRef])
  const branchExists = gitOk(branchShaResult)
  const branchSha = branchExists ? branchShaResult.stdout.trim() : null

  if (branchExists && PROTECTED_RESET_ROLES.has(role)) {
    const reachable = gitImpl(['merge-base', '--is-ancestor', branchRef, 'HEAD'])
    if (reachable.status !== 0) {
      throw new Error(
        `branch ${branch} exists at ${branchSha}, head is ${headSha}, refusing to overwrite — manually resolve or pick a different task slug`,
      )
    }
  }

  const checkout = gitText(gitImpl, ['checkout', '-B', branch])
  if (!gitOk(checkout)) {
    throw new Error(`spawn: git checkout ${branch} failed:\n${checkout.stderr}`)
  }

  log(`spawn: branch=${branch} (${branchExists ? 'reset' : 'created'})`)
  return branch
}

export const defaultDispatchTimeoutMs = DEFAULT_TIMEOUT_MS
export const dispatchTerminationGraceMs = TERMINATION_GRACE_MS

export async function dispatchLifecycle(
  {
    role,
    task,
    engine = null,
    prompt,
    taskAttrs = null,
    codexEffort = null,
    timeoutMs = null,
    terminationGraceMs = TERMINATION_GRACE_MS,
    platformDir = DEFAULT_PLATFORM_DIR,
    projectDir = projectDirOf(),
    projectCollabDir = projectCollabDirOf(projectDir),
  } = {},
  {
    spawnProcess = spawn,
    spawnGit = null,
    log = (line) => console.error(line),
  } = {},
) {
  if (!role) throw new Error('dispatchLifecycle requires role')
  if (!task) throw new Error('dispatchLifecycle requires task')
  if (prompt === null || prompt === undefined) throw new Error('dispatchLifecycle requires prompt')

  ensureCleanTaskSlug(task)

  const paths = dispatchPathsOf({ platformDir, projectDir, projectCollabDir })
  const repoDir = projectDir
  const gitImpl = spawnGit || ((args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' }))
  const roleMeta = readRoleMeta(role, paths.agentsDir)
  const engineId = engine || roleMeta.engine || 'claude'
  const engines = listEngines(paths.driversDir, readdirSync)
  if (!engines.includes(engineId)) {
    throw new Error(`Unknown engine: ${engineId}\nAvailable engines: ${engines.join(', ')}`)
  }

  const persistent = roleMeta.persistent === 'true'
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs)
  const effectiveGraceMs = parseTimeoutMs(terminationGraceMs, 'dispatch termination grace')
  const branch = prepareBranch({ role, task, persistent, gitImpl, log })
  const { sessionFlag, sessionId: initialSessionId, sessionIdPath, captureCodexSession } = preparePersistentSession({
    role,
    engineId,
    persistent,
    sessionsDir: paths.sessionsDir,
  })
  let sessionId = initialSessionId

  if (persistent) {
    const mode = sessionFlag === '--resume' ? 'resumed' : captureCodexSession ? 'codex-new (post-exit capture)' : 'new'
    log(`spawn: persistent role=${role} engine=${engineId} session=${sessionId || '<pending>'} (${mode})`)
  }

  mkdirSync(paths.dispatchesDir, { recursive: true })

  const promptPath = join(paths.dispatchesDir, `${task}.prompt`)
  const outPath = join(paths.dispatchesDir, `${task}.out`)
  const metaPath = join(paths.dispatchesDir, `${task}.meta`)
  const dispatchApi = createDispatchApi({
    metaPath,
    eventsPath: paths.eventsPath,
    task,
    role,
    engine: engineId,
    taskAttrs,
    promptPath,
    outPath,
  })

  dispatchApi.writePrompt(prompt)
  dispatchApi.markPrepared({ branch, sessionId, timeoutMs: effectiveTimeoutMs })

  const runArgs = []
  if (engine) runArgs.push('--engine', engine)
  if (sessionFlag && sessionId) runArgs.push(sessionFlag, sessionId)
  if (codexEffort) runArgs.push('--codex-effort', codexEffort)
  runArgs.push('--task', task)
  if (taskAttrs) runArgs.push('--task-attrs', JSON.stringify(taskAttrs))
  runArgs.push(role, prompt)

  const outFd = openSync(outPath, 'w')
  let child
  try {
    child = spawnProcess('node', [paths.runPath, ...runArgs], {
      stdio: ['ignore', outFd, outFd],
      env: {
        ...process.env,
        COLLAB_TASK: task,
        COLLAB_ROLE: role,
        ...(taskAttrs ? { COLLAB_TASK_ATTRS: JSON.stringify(taskAttrs) } : {}),
      },
    })
  } finally {
    closeSync(outFd)
  }

  dispatchApi.markRunning({ pid: child.pid, branch, sessionId })
  log(`spawn: task=${task} role=${role} engine=${engineId} pid=${child.pid}`)
  log(`out: ${outPath}`)

  return await new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let timeoutAt = null
    let graceAt = null
    let finalTimeoutSignal = null
    let timeoutHandle = null
    let graceHandle = null

    const cleanupTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (graceHandle) clearTimeout(graceHandle)
    }

    const maybeCaptureCodexSession = () => {
      if (!captureCodexSession || existsSync(sessionIdPath)) return
      try {
        const out = readFileSync(outPath, 'utf8')
        const match = out.match(/^session id:\s*([0-9a-fA-F-]{36})/m)
        if (match) {
          sessionId = match[1]
          writeFileSync(sessionIdPath, sessionId + '\n')
          log(`spawn: codex session captured: ${sessionId}`)
        }
      } catch {}
    }

    const settle = ({ code = null, signal = null, error = null } = {}) => {
      if (settled) return
      settled = true
      cleanupTimers()

      const exitCode = code ?? signalExitCode(signal) ?? 1
      if (exitCode === 0) maybeCaptureCodexSession()

      let disposition = 'error'
      let parked = null
      let timeout = null
      if (timedOut) {
        disposition = 'timeout'
        timeout = {
          timeoutMs: effectiveTimeoutMs,
          graceMs: effectiveGraceMs,
          timedOutAt: timeoutAt,
          ...(graceAt ? { forceKillAt: graceAt } : {}),
          signal: finalTimeoutSignal || signal || 'SIGTERM',
        }
      } else if (exitCode === 0) {
        disposition = 'success'
      } else {
        parked = detectParked(outPath)
        disposition = parked ? 'parked' : 'error'
      }

      dispatchApi.markReleased({
        exitCode,
        exitSignal: signal,
        branch,
        sessionId,
        disposition,
        parked,
        timeout,
        error: error?.message || null,
        notes:
          disposition === 'timeout'
            ? `timeout after ${effectiveTimeoutMs}ms${graceAt ? '; SIGKILL after grace' : '; SIGTERM delivered'}`
            : error?.message || null,
      })
      resolve({ exitCode, exitSignal: signal, disposition, branch, sessionId, timedOut })
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true
      timeoutAt = new Date().toISOString()
      finalTimeoutSignal = 'SIGTERM'
      log(`spawn: timeout ${effectiveTimeoutMs}ms reached for ${task}; sending SIGTERM to ${child.pid}`)
      try {
        child.kill('SIGTERM')
      } catch {}
      graceHandle = setTimeout(() => {
        if (settled) return
        graceAt = new Date().toISOString()
        finalTimeoutSignal = 'SIGKILL'
        log(`spawn: timeout grace ${effectiveGraceMs}ms elapsed for ${task}; sending SIGKILL to ${child.pid}`)
        try {
          child.kill('SIGKILL')
        } catch {}
      }, effectiveGraceMs)
    }, effectiveTimeoutMs)

    child.on('exit', (code, signal) => settle({ code, signal }))
    child.on('error', (error) => {
      log(`spawn run.mjs failed: ${error.message}`)
      settle({ code: 1, error })
    })
  })
}
