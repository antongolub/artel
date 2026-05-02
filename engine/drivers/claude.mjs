// Engine driver: Claude Code CLI (`claude -p`).
//
// Universal-term mapping (DESIGN.md §5):
//   model           → --model
//   tools           → --allowedTools
//   permission-mode → --permission-mode (claude-native)
//   sandbox         → derived --permission-mode (read-only=plan,
//                     workspace-write=acceptEdits, full-access=
//                     bypassPermissions). Best-effort: claude has no true
//                     sandbox primitive, only permission gating. Explicit
//                     `permission-mode` in role meta wins over derived.
//   effort          → silent ignore (claude has no analog).
//
// Native support for system-prompt injection (--append-system-prompt).
//
// parseUsage: returns null in MVP. Default `claude -p` mode emits plain
// text; usage data only appears with `--output-format json` which would
// change the .out semantics. Wiring that flag through is deferred to v2;
// when wired, this function will read the JSON envelope at end of .out.

export const id = 'claude'
export const command = 'claude'
export const api_version = 1

const SANDBOX_TO_PERMISSION_MODE = {
  'read-only': 'plan',
  'workspace-write': 'acceptEdits',
  'full-access': 'bypassPermissions',
}

export function args (meta, promptParts, session = {}) {
  const out = ['-p']
  if (session.resumeId) out.push('--resume', session.resumeId)
  else if (session.sessionId) out.push('--session-id', session.sessionId)
  if (meta.body && meta.body.trim()) out.push('--append-system-prompt', meta.body.trim())
  if (meta.tools) out.push('--allowedTools', meta.tools)

  const permissionMode = meta['permission-mode'] || (meta.sandbox ? SANDBOX_TO_PERMISSION_MODE[meta.sandbox] : null)
  if (permissionMode) out.push('--permission-mode', permissionMode)

  if (meta.model) out.push('--model', meta.model)
  if (promptParts.length) out.push(promptParts.join(' '))
  return out
}

// eslint-disable-next-line no-unused-vars
export function parseUsage (_outPath, _sessionId) {
  // TODO v2: parse `--output-format json` envelope when wired through.
  return null
}
