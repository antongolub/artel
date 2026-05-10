// Centralised config for the artel platform.
//
// Two surfaces, deliberately separated:
//
//   1. config — operator-tunable knobs + on-disk layout. Built once
//      by createConfig({ env, cwd, home }); every value is resolved
//      eagerly to a string (or null). CLI entrypoints import the
//      module-level `config`; libraries called many times per process
//      with shifting env (drivers loader, dispatch lifecycle, trust
//      crypto) call `createConfig()` at the top of each invocation —
//      sub-millisecond cost, no caching surprises.
//
//   2. dispatchEnv() — per-call read of the parent → child envelope
//      (ARTEL_TASK / ARTEL_ROLE / ARTEL_DISPATCH_ID / ARTEL_TRACE_ID /
//      ARTEL_TASK_ATTRS / ARTEL_PIPELINE_FORCE_WORKTREE). Always read
//      fresh from process.env: these are set by the parent for each
//      child process and have no platform-level defaults to compute.

import { homedir } from 'node:os'
import { join } from 'node:path'

const trim = (s) => (typeof s === 'string' && s.length ? s : null)

// Project-relative path layout. Pulled out so per-projectDir helpers
// (pipelinesDir(root), pipelineCancelsDir(root), etc.) share the same
// `.artel/<subdir>` literals as `createConfig()` without duplication.
export const pathsFor = (projectDir) => {
  const artelDir = join(projectDir, '.artel')
  return {
    projectDir,
    artelDir,
    trustDir:            join(artelDir, 'trust'),
    pipelinesDir:        join(artelDir, 'pipelines'),
    pipelineCancelsDir:  join(artelDir, '.pipeline-cancels'),
    worktreesDir:        join(artelDir, '.worktrees'),
    dispatchesDir:       join(artelDir, '.dispatches'),
    sessionsDir:         join(artelDir, '.sessions'),
    skillsDir:           join(artelDir, 'skills'),
    driversDir:          join(artelDir, 'drivers'),
    eventsPath:          join(artelDir, 'events.jsonl'),
    clusterPath:         join(artelDir, 'cluster.json'),
    dispatcherStatePath: join(artelDir, 'dispatcher_state.json'),
    queuePath:           join(artelDir, 'QUEUE.md'),
    statePath:           join(artelDir, 'state.md'),
  }
}

export const createConfig = ({
  env = process.env,
  cwd = process.cwd(),
  home = homedir(),
} = {}) => {
  const projectDir = trim(env.ARTEL_PROJECT_DIR) || cwd
  return {
    ...pathsFor(projectDir),

    // Engine-session caches outside the project tree.
    userDriversDir:     trim(env.ARTEL_USER_DRIVERS_DIR)    || join(home, '.artel', 'drivers'),
    claudeProjectsDir:  trim(env.ARTEL_CLAUDE_PROJECTS_DIR) || join(home, '.claude/projects'),
    codexSessionsDir:   trim(env.ARTEL_CODEX_SESSIONS_DIR)  || join(home, '.codex/sessions'),
    copilotSessionDir:  trim(env.ARTEL_COPILOT_SESSION_DIR) || join(home, '.copilot/session-state'),

    // Optional knobs — null ⇒ caller falls back to its own default.
    dispatchTimeoutMs:   trim(env.ARTEL_DISPATCH_TIMEOUT_MS),
    heartbeatIntervalMs: trim(env.ARTEL_HEARTBEAT_INTERVAL_MS),

    // Master-key sources.
    masterKeyFile:       trim(env.ARTEL_MASTER_KEY_FILE),
    masterKeyInline:     trim(env.ARTEL_MASTER_KEY),
  }
}

// Module-level snapshot for CLI entrypoints (one-shot processes).
export const config = createConfig()

// Per-call read of the parent → child envelope.
export const dispatchEnv = (env = process.env) => ({
  task:                  env.ARTEL_TASK         || null,
  role:                  env.ARTEL_ROLE         || null,
  dispatchId:            env.ARTEL_DISPATCH_ID  || null,
  traceId:               env.ARTEL_TRACE_ID     || null,
  taskAttrs:             env.ARTEL_TASK_ATTRS   || null,
  pipelineForceWorktree: env.ARTEL_PIPELINE_FORCE_WORKTREE === '1',
})
