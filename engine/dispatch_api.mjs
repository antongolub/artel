import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const nowIso = () => new Date().toISOString()

const clone = (value) => JSON.parse(JSON.stringify(value))

const ensureParent = (path) => mkdirSync(dirname(path), { recursive: true })

const readJsonFile = (path) => {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const normalizeAttrs = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  return entries.length ? Object.fromEntries(entries) : null
}

export const parseJsonObject = (raw, label = 'JSON object') => {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  return parsed
}

const parseScalar = (raw) => {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

export const parseTaskAttrAssignment = (raw) => {
  const idx = raw.indexOf('=')
  if (idx <= 0) throw new Error(`Task attribute must match key=value, got: ${raw}`)
  const key = raw.slice(0, idx).trim()
  const valueRaw = raw.slice(idx + 1).trim()
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) {
    throw new Error(`Invalid task attribute key: ${key}`)
  }
  return { [key]: parseScalar(valueRaw) }
}

export const mergeTaskAttrs = (...parts) => {
  const merged = Object.assign({}, ...parts.filter(Boolean))
  return normalizeAttrs(merged)
}

export const buildTaskContextBlock = ({ task = null, taskAttrs = null } = {}) => {
  const attrs = normalizeAttrs(taskAttrs)
  if (!task && !attrs) return null
  const lines = ['[dispatch context]']
  if (task) lines.push(`task: ${task}`)
  if (attrs) lines.push(`task_attributes: ${JSON.stringify(attrs)}`)
  return lines.join('\n')
}

export const createDispatchApi = ({
  metaPath,
  eventsPath,
  task,
  role,
  engine,
  taskAttrs = null,
  promptPath = null,
  outPath = null,
  onMeta = null,
  onEvent = null,
} = {}) => {
  if (!metaPath) throw new Error('createDispatchApi requires metaPath')
  if (!task) throw new Error('createDispatchApi requires task')
  if (!role) throw new Error('createDispatchApi requires role')
  if (!engine) throw new Error('createDispatchApi requires engine')

  const attrs = normalizeAttrs(taskAttrs)
  let meta = readJsonFile(metaPath) || {}

  const notifyMeta = (movement) => {
    if (typeof onMeta === 'function') onMeta({ movement, meta: clone(meta) })
  }

  const notifyEvent = (event) => {
    if (typeof onEvent === 'function') onEvent(clone(event))
  }

  const writeMeta = (patch = {}, movement = 'update') => {
    meta = {
      ...meta,
      task,
      role,
      engine,
      ...(attrs ? { taskAttrs: attrs } : {}),
      ...patch,
      updatedAt: nowIso(),
      lastMovement: movement,
    }
    ensureParent(metaPath)
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
    notifyMeta(movement)
    return clone(meta)
  }

  const appendEvent = (type, fields = {}) => {
    if (!eventsPath) return null
    const event = {
      type,
      at: nowIso(),
      task,
      ...fields,
      ...(attrs ? { task_attrs: attrs } : {}),
    }
    ensureParent(eventsPath)
    appendFileSync(eventsPath, JSON.stringify(event) + '\n')
    notifyEvent(event)
    return clone(event)
  }

  const writePrompt = (prompt) => {
    if (!promptPath) return
    ensureParent(promptPath)
    writeFileSync(promptPath, prompt)
  }

  const markPrepared = ({ branch = null, sessionId = null, timeoutMs = null } = {}) =>
    writeMeta(
      {
        status: 'prepared',
        promptPath,
        outPath,
        dispatchedAt: meta.dispatchedAt || nowIso(),
        branch,
        sessionId,
        ...(timeoutMs ? { timeoutMs } : {}),
      },
      'prepared',
    )

  const markRunning = ({
    pid,
    branch = null,
    sessionId = null,
    queueBucket = 'unknown',
    promptRef = null,
    notes = null,
  } = {}) => {
    const current = writeMeta(
      {
        status: 'running',
        pid,
        branch,
        sessionId,
        dispatchedAt: meta.dispatchedAt || nowIso(),
      },
      'claim',
    )
    appendEvent('claim', {
      queue_bucket: queueBucket,
      owner_role: role,
      owner_provider: engine,
      branch,
      engine,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(promptRef ? { prompt_ref: promptRef } : {}),
      ...(notes ? { notes } : {}),
    })
    return current
  }

  const markReleased = ({
    exitCode,
    exitSignal = null,
    branch = null,
    sessionId = null,
    disposition = 'success',
    parked = null,
    timeout = null,
    error = null,
    nextSafeStep = null,
    notes = null,
    replacementTask = null,
    blockingClass = null,
  } = {}) => {
    const status =
      disposition === 'success'
        ? 'completed'
        : disposition === 'parked'
          ? 'parked'
          : disposition === 'timeout'
            ? 'timed-out'
            : 'failed'

    const current = writeMeta(
      {
        status,
        completedAt: nowIso(),
        exitCode,
        disposition,
        branch,
        sessionId,
        ...(exitSignal ? { exitSignal } : {}),
        ...(error ? { error } : {}),
        ...(parked ? { parked } : {}),
        ...(timeout ? { timeout } : {}),
      },
      'release',
    )

    if (parked) {
      appendEvent('parked', {
        reason: parked.reason,
        reset_at: parked.resetAt,
        raw: parked.raw,
        engine,
        ...(notes ? { notes } : {}),
      })
    }

    appendEvent('release', {
      owner_role: role,
      owner_provider: engine,
      disposition,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(nextSafeStep ? { next_safe_step: nextSafeStep } : {}),
      ...(notes ? { notes } : {}),
      ...(replacementTask ? { replacement_task: replacementTask } : {}),
      ...(blockingClass ? { blocking_class: blockingClass } : {}),
    })

    return current
  }

  return {
    writePrompt,
    writeMeta,
    appendEvent,
    readMeta: () => clone(meta),
    markPrepared,
    markRunning,
    markReleased,
  }
}
