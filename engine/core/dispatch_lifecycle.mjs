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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDispatchApi } from './dispatch_api.mjs'
import { ensureClusterIdentity, instanceId as getInstanceId } from './cluster.mjs'
import { detectParked } from './parked.mjs'
import { uuidv7 } from '../util/ids.mjs'
import { gitContext, gitDelta } from '../util/git.mjs'
import { listDrivers } from '../util/drivers.mjs'
import { identityEnv, resolveIdentity } from '../util/trust.mjs'

const here = dirname(fileURLToPath(import.meta.url))
// Platform dir holds the role+engine skeleton (agents/, engine/, AGENTS.md).
// `here` is engine/core/, so platform root is two levels up.
const DEFAULT_PLATFORM_DIR = join(here, '..', '..')
// Project dir is per-project: each consuming repo holds its own `.artel/`
// runtime (.dispatches/, .sessions/, events.jsonl, dispatcher_state.json,
// state.md, JOURNAL/QUEUE). Resolve from cwd (or env override) — never from
// `here`, since a single platform serves many projects.
const projectDirOf = () => process.env.ARTEL_PROJECT_DIR || process.cwd()
const projectArtelDirOf = (projectDir = projectDirOf()) => join(projectDir, '.artel')
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const TERMINATION_GRACE_MS = 10 * 1000
const DEFAULT_BACKOFF_THRESHOLD = 3
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000

// Find the dispatch.start event (or legacy 'claim') with matching dispatch_id
// in events.jsonl. Used by retry-counter to compare engine+model against the
// previous dispatch in this chain.
const findDispatchStart = (eventsPath, dispatchId) => {
  if (!dispatchId || !existsSync(eventsPath)) return null
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let event
    try { event = JSON.parse(lines[i]) } catch { continue }
    if (event.dispatch_id === dispatchId && (event.type === 'dispatch.start' || event.type === 'claim')) {
      return event
    }
  }
  return null
}

// Find the dispatch.end event matching dispatchId — used to derive retry_reason
// (= previous dispatch's disposition).
const findDispatchEnd = (eventsPath, dispatchId) => {
  if (!dispatchId || !existsSync(eventsPath)) return null
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    let event
    try { event = JSON.parse(lines[i]) } catch { continue }
    if (event.dispatch_id === dispatchId && (event.type === 'dispatch.end' || event.type === 'release')) {
      return event
    }
  }
  return null
}

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
  projectArtelDir = projectArtelDirOf(projectDir),
} = {}) => {
  const engineDir = join(platformDir, 'engine')
  return {
    platformDir,
    projectDir,
    projectArtelDir,
    agentsDir: join(platformDir, 'agents'),
    driversDir: join(engineDir, 'drivers'),
    runPath: join(engineDir, 'cli', 'run.mjs'),
    dispatchesDir: join(projectArtelDir, '.dispatches'),
    sessionsDir: join(projectArtelDir, '.sessions'),
    eventsPath: join(projectArtelDir, 'events.jsonl'),
  }
}

// Visible engines = platform defaults plus overlays (project / user). Project
// .artel/drivers/<id>.mjs > user ~/.artel/drivers/<id>.mjs > platform default.
// Replaces the prior platform-only `readdir(drivers/)` listing (V6).
const listEngines = () => listDrivers()

const readRoleMeta = (role, agentsDir) => {
  const rolePath = join(agentsDir, `${role}.md`)
  if (!existsSync(rolePath)) {
    throw new Error(`Role not found: ${rolePath}`)
  }
  return frontmatterOf(readFileSync(rolePath, 'utf8'))
}

// Parse dispatch policy from a role's frontmatter:
//   dispatchable: all | none | <comma-list>     (allowlist; default 'all')
//   non-dispatchable: <comma-list>               (denylist; applied on top)
//
// Returns { allow: 'all' | string[], deny: string[] }.
const parseDispatchPolicy = (meta) => {
  const dispatchable = (meta.dispatchable || 'all').trim()
  const nonDispatchable = (meta['non-dispatchable'] || '').trim()
  const allow = dispatchable === 'all'
    ? 'all'
    : dispatchable === 'none' || dispatchable === ''
      ? []
      : dispatchable.split(',').map((s) => s.trim()).filter(Boolean)
  const deny = nonDispatchable.split(',').map((s) => s.trim()).filter(Boolean)
  return { allow, deny }
}

// Guard nested dispatch against parent role's declared policy. Throws if
// the parent's frontmatter forbids dispatching the requested role. Top-
// level dispatches (no parent in env) skip the check entirely.
const checkDispatchPolicy = (parentRoleName, requestedRole, agentsDir) => {
  if (!parentRoleName) return
  const parentPath = join(agentsDir, `${parentRoleName}.md`)
  if (!existsSync(parentPath)) return // unknown parent — fail open
  const parentMeta = frontmatterOf(readFileSync(parentPath, 'utf8'))
  const policy = parseDispatchPolicy(parentMeta)
  if (policy.allow !== 'all' && !policy.allow.includes(requestedRole)) {
    throw new Error(
      `role policy: '${parentRoleName}' cannot dispatch '${requestedRole}' ` +
      `(dispatchable: ${parentMeta.dispatchable || '<unset>'})`,
    )
  }
  if (policy.deny.includes(requestedRole)) {
    throw new Error(
      `role policy: '${parentRoleName}' cannot dispatch '${requestedRole}' ` +
      `(non-dispatchable: ${parentMeta['non-dispatchable']})`,
    )
  }
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
  parseTimeoutMs(timeoutMs ?? process.env.ARTEL_DISPATCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, 'dispatch timeout')

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

const prepareBranch = ({ role, task, persistent, protectedBranch, gitImpl, log }) => {
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

  // protected_branch: refuse to overwrite a divergent branch unless its tip is
  // an ancestor of HEAD. Declared per-role in frontmatter — the platform does
  // not name protected roles itself.
  if (branchExists && protectedBranch) {
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

const truthyFlag = (raw) =>
  raw === true || raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'

export const defaultDispatchTimeoutMs = DEFAULT_TIMEOUT_MS
export const dispatchTerminationGraceMs = TERMINATION_GRACE_MS

export async function dispatchLifecycle(
  {
    role,
    task,
    engine = null,
    prompt,
    taskAttrs = null,
    model = null,
    effort = null,
    sandbox = null,
    tools = null,
    permissionMode = null,
    // Deprecated alias for `effort`. Kept for one back-compat cycle; emits
    // warning when used. Drop once parent project is migrated.
    codexEffort = null,
    retryOf = null,
    backoffThreshold = DEFAULT_BACKOFF_THRESHOLD,
    timeoutMs = null,
    terminationGraceMs = TERMINATION_GRACE_MS,
    identity = null,
    platformDir = DEFAULT_PLATFORM_DIR,
    projectDir = projectDirOf(),
    projectArtelDir = projectArtelDirOf(projectDir),
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

  const paths = dispatchPathsOf({ platformDir, projectDir, projectArtelDir })
  const repoDir = projectDir
  const gitImpl = spawnGit || ((args) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' }))

  // Role policy guard — DESIGN.md §8. Throws BEFORE any side-effects (no
  // branch creation, no file writes) so denied dispatches leave no trace.
  checkDispatchPolicy(process.env.ARTEL_ROLE || null, role, paths.agentsDir)

  const roleMeta = readRoleMeta(role, paths.agentsDir)
  const engineId = engine || roleMeta.engine || 'claude'
  const engines = listEngines()
  if (!engines.includes(engineId)) {
    throw new Error(`Unknown engine: ${engineId}\nAvailable engines: ${engines.join(', ')}`)
  }

  const persistent = truthyFlag(roleMeta.persistent)
  const protectedBranch = truthyFlag(roleMeta.protected_branch)
  const effectiveTimeoutMs = normalizeTimeoutMs(timeoutMs)
  const effectiveGraceMs = parseTimeoutMs(terminationGraceMs, 'dispatch termination grace')
  const branch = prepareBranch({ role, task, persistent, protectedBranch, gitImpl, log })
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

  // Cluster identity bootstrap — idempotent. Auto-creates `.artel/cluster.json`
  // on first dispatch in a fresh consumer project. instance_id is per-process.
  const clusterIdentity = ensureClusterIdentity(paths.projectArtelDir)
  const instanceIdValue = getInstanceId()

  // Tracing — DESIGN.md §6. Dispatch graph is reconstructible from
  // (dispatch_id, parent_dispatch_id, trace_id) tuples. Top-level dispatch
  // (no parent in env) defines the trace root. Nested dispatches inherit
  // trace_id from env and record the parent.
  const parentDispatchId = process.env.ARTEL_DISPATCH_ID || null
  const parentRole = process.env.ARTEL_ROLE || null
  const dispatchId = uuidv7()
  const traceId = process.env.ARTEL_TRACE_ID || dispatchId

  const promptPath = join(paths.dispatchesDir, `${task}.prompt`)
  const outPath = join(paths.dispatchesDir, `${task}.out`)
  const metaPath = join(paths.dispatchesDir, `${task}.meta`)
  const dispatchApi = createDispatchApi({
    metaPath,
    eventsPath: paths.eventsPath,
    task,
    role,
    engine: engineId,
    clusterId: clusterIdentity.cluster_id,
    instanceId: instanceIdValue,
    dispatchId,
    traceId,
    parentDispatchId,
    parentRole,
    taskAttrs,
    promptPath,
    outPath,
  })

  dispatchApi.writePrompt(prompt)
  dispatchApi.markPrepared({ branch, sessionId, timeoutMs: effectiveTimeoutMs })

  if (codexEffort && !effort) {
    log('warning: dispatchLifecycle({codexEffort}) is deprecated; use {effort}')
    effort = codexEffort
  }

  // Effective model (CLI override > role frontmatter). Used for retry-counter
  // comparison in C6 — same engine + same effective model = retry chain.
  const effectiveModel = model || roleMeta.model || null

  // Retry chain — C6. Look up prev dispatch.start with matching dispatch_id.
  // If same engine+model → increment retry_count. Different → reset (new chain
  // from the engine's perspective; orchestrator deliberately switched).
  let retryCount = 0
  let retryReason = null
  if (retryOf) {
    const prevStart = findDispatchStart(paths.eventsPath, retryOf)
    if (prevStart) {
      const sameConfig =
        prevStart.engine === engineId &&
        (prevStart.model || null) === effectiveModel
      retryCount = sameConfig ? (prevStart.retry_count || 0) + 1 : 0
    }
    const prevEnd = findDispatchEnd(paths.eventsPath, retryOf)
    retryReason = prevEnd?.disposition || (prevStart ? 'manual' : null)
  }

  const runArgs = []
  if (engine) runArgs.push('--engine', engine)
  if (sessionFlag && sessionId) runArgs.push(sessionFlag, sessionId)
  if (model) runArgs.push('--model', model)
  if (effort) runArgs.push('--effort', effort)
  if (sandbox) runArgs.push('--sandbox', sandbox)
  if (tools) runArgs.push('--tools', tools)
  if (permissionMode) runArgs.push('--permission-mode', permissionMode)
  runArgs.push('--task', task)
  if (taskAttrs) runArgs.push('--task-attrs', JSON.stringify(taskAttrs))
  runArgs.push(role, prompt)

  // V11 — agent identity injection. Per-dispatch CLI override beats
  // role frontmatter; absent both, no identity is set and the child
  // inherits the operator's git config.
  const identityName = identity || roleMeta.identity || null
  const identityRecord = resolveIdentity(paths.projectDir, identityName)
  const identityEnvVars = identityEnv(identityRecord)

  const outFd = openSync(outPath, 'w')
  let child
  try {
    child = spawnProcess('node', [paths.runPath, ...runArgs], {
      stdio: ['ignore', outFd, outFd],
      env: {
        ...process.env,
        ...identityEnvVars,
        ARTEL_TASK: task,
        ARTEL_ROLE: role,
        ARTEL_DISPATCH_ID: dispatchId,
        ARTEL_TRACE_ID: traceId,
        ...(identityName ? { ARTEL_IDENTITY: identityName } : {}),
        ...(taskAttrs ? { ARTEL_TASK_ATTRS: JSON.stringify(taskAttrs) } : {}),
      },
    })
  } finally {
    closeSync(outFd)
  }

  // V10: capture git context at dispatch start. `gitContext` returns null if
  // the project isn't a git repo or git is unavailable — skip the field then.
  const git = gitContext(paths.projectDir)
  dispatchApi.markRunning({
    pid: child.pid,
    branch,
    sessionId,
    model: effectiveModel,
    retryOf: retryOf || null,
    retryCount,
    retryReason,
    git,
  })
  log(`spawn: task=${task} role=${role} engine=${engineId} pid=${child.pid}`)
  log(`out: ${outPath}`)

  // Backoff signal — emit when retry_count crosses threshold. Signals are
  // derived operational cues consumed by dispatcher / orchestrator (DESIGN.md
  // §4.6). Threshold is configurable via `backoffThreshold` param (default 3).
  if (retryCount >= backoffThreshold) {
    dispatchApi.appendEvent(
      'signal.backoff_required',
      {
        engine: engineId,
        model: effectiveModel,
        retry_count: retryCount,
        retry_reason: retryReason,
        retry_of: retryOf,
        threshold: backoffThreshold,
      },
      { kind: 'signal' },
    )
    log(`spawn: signal.backoff_required emitted (retry_count=${retryCount} >= ${backoffThreshold})`)
  }

  return await new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let timeoutAt = null
    let graceAt = null
    let finalTimeoutSignal = null
    let timeoutHandle = null
    let graceHandle = null
    let heartbeatHandle = null

    const cleanupTimers = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (graceHandle) clearTimeout(graceHandle)
      if (heartbeatHandle) clearInterval(heartbeatHandle)
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

    // Driver usage capture (DESIGN.md §C5). Called post-exit, after
    // session id (if any) has been resolved. Drivers without parseUsage
    // export, or that throw, contribute null.
    const captureUsage = async () => {
      const driverPath = join(paths.driversDir, `${engineId}.mjs`)
      if (!existsSync(driverPath)) return null
      try {
        const driver = await import(pathToFileURL(driverPath).href)
        if (typeof driver.parseUsage !== 'function') return null
        return driver.parseUsage(outPath, sessionId) || null
      } catch (err) {
        log(`spawn: parseUsage error: ${err.message}`)
        return null
      }
    }

    const settle = async ({ code = null, signal = null, error = null } = {}) => {
      if (settled) return
      settled = true
      cleanupTimers()

      const exitCode = code ?? signalExitCode(signal) ?? 1
      if (exitCode === 0) maybeCaptureCodexSession()

      const usage = await captureUsage()

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

      // V10: compute working-tree delta against the dispatch-start commit.
      // gitDelta tolerates missing git / unreachable sha → null.
      const delta = git ? gitDelta(paths.projectDir, git.commit_sha) : null
      dispatchApi.markReleased({
        exitCode,
        exitSignal: signal,
        branch,
        sessionId,
        disposition,
        parked,
        timeout,
        usage,
        delta,
        error: error?.message || null,
        notes:
          disposition === 'timeout'
            ? `timeout after ${effectiveTimeoutMs}ms${graceAt ? '; SIGKILL after grace' : '; SIGTERM delivered'}`
            : error?.message || null,
      })
      resolve({ exitCode, exitSignal: signal, disposition, branch, sessionId, timedOut })
    }

    // V9 — mid-run heartbeats. Emits a `heartbeat` event every
    // `ARTEL_HEARTBEAT_INTERVAL_MS` (default 60s) and updates `.meta`'s
    // `lastHeartbeatAt`/`pidAlive` so `artel status` can show "alive Ns ago"
    // without scanning events.jsonl. Cleared on settle / timeout / error.
    const heartbeatIntervalMs = Number(process.env.ARTEL_HEARTBEAT_INTERVAL_MS) || DEFAULT_HEARTBEAT_INTERVAL_MS
    if (heartbeatIntervalMs > 0) {
      heartbeatHandle = setInterval(() => {
        if (settled || child.killed) return
        try {
          const at = new Date().toISOString()
          dispatchApi.appendEvent('heartbeat', { pid_alive: true })
          dispatchApi.writeMeta({ lastHeartbeatAt: at, pidAlive: true }, 'heartbeat')
        } catch (err) {
          log(`heartbeat emit failed: ${err.message}`)
        }
      }, heartbeatIntervalMs)
      // unref so a stuck heartbeat interval doesn't keep node alive past
      // settle (defence in depth — cleanupTimers should always clear it).
      if (heartbeatHandle.unref) heartbeatHandle.unref()
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
