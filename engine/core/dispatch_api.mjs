import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_VERSION, validateEventType } from './schema.mjs'
import { uuidv7 } from '../util/ids.mjs'

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
  clusterId,
  instanceId,
  dispatchId,
  traceId,
  parentDispatchId = null,
  parentRole = null,
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
  if (!clusterId) throw new Error('createDispatchApi requires clusterId')
  if (!instanceId) throw new Error('createDispatchApi requires instanceId')
  if (!dispatchId) throw new Error('createDispatchApi requires dispatchId')
  if (!traceId) throw new Error('createDispatchApi requires traceId')

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
      schema: SCHEMA_VERSION,
      task,
      role,
      engine,
      clusterId,
      instanceId,
      dispatchId,
      traceId,
      ...(parentDispatchId ? { parentDispatchId } : {}),
      ...(parentRole ? { parentRole } : {}),
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

  // appendEvent: writes one structured event line. Mandatory fields per
  // DESIGN.md §4.2 (schema, kind, type, id, at, cluster_id, instance_id) are
  // injected automatically. `kind` defaults to 'workload' (the common case);
  // infra/signal/control callers pass it explicitly.
  //
  // `fence_token` defaults to 0 in v1 — schema is reserved for federation
  // claim/lease enforcement (DESIGN.md §12.3). Backends record but no
  // enforcement until the v2 claim layer ships.
  const appendEvent = (type, fields = {}, { kind = 'workload', fenceToken = 0 } = {}) => {
    if (!eventsPath) return null
    validateEventType(kind, type)
    const event = {
      schema: SCHEMA_VERSION,
      kind,
      type,
      id: uuidv7(),
      at: nowIso(),
      cluster_id: clusterId,
      instance_id: instanceId,
      task,
      dispatch_id: dispatchId,
      trace_id: traceId,
      ...(parentDispatchId ? { parent_dispatch_id: parentDispatchId } : {}),
      ...(parentRole ? { parent_role: parentRole } : {}),
      ...(kind === 'workload' ? { fence_token: fenceToken } : {}),
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
    model = null,
    retryOf = null,
    retryCount = 0,
    retryReason = null,
    git = null,
  } = {}) => {
    const current = writeMeta(
      {
        status: 'running',
        pid,
        branch,
        sessionId,
        dispatchedAt: meta.dispatchedAt || nowIso(),
        ...(model ? { model } : {}),
        ...(retryOf ? { retryOf } : {}),
        ...(retryCount ? { retryCount } : {}),
        ...(retryReason ? { retryReason } : {}),
        ...(git ? { git } : {}),
      },
      'dispatch.start',
    )
    appendEvent('dispatch.start', {
      queue_bucket: queueBucket,
      owner_role: role,
      owner_provider: engine,
      branch,
      engine,
      ...(model ? { model } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(promptRef ? { prompt_ref: promptRef } : {}),
      ...(retryOf ? { retry_of: retryOf } : {}),
      ...(retryCount ? { retry_count: retryCount } : {}),
      ...(retryReason ? { retry_reason: retryReason } : {}),
      ...(notes ? { notes } : {}),
      ...(git ? { git } : {}),
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
    usage = null,
    error = null,
    nextSafeStep = null,
    notes = null,
    replacementTask = null,
    blockingClass = null,
    delta = null,
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
        ...(usage ? { usage } : {}),
        ...(delta ? { delta } : {}),
      },
      'dispatch.end',
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

    appendEvent('dispatch.end', {
      owner_role: role,
      owner_provider: engine,
      disposition,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(usage ? { usage } : {}),
      ...(nextSafeStep ? { next_safe_step: nextSafeStep } : {}),
      ...(notes ? { notes } : {}),
      ...(replacementTask ? { replacement_task: replacementTask } : {}),
      ...(blockingClass ? { blocking_class: blockingClass } : {}),
      ...(delta ? { delta } : {}),
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
