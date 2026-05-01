// Engine driver: Claude Code CLI (`claude -p`).
// Native support for system-prompt injection, tool allowlists, permission modes.

export const id = 'claude'
export const command = 'claude'

export function args (meta, promptParts, session = {}) {
  const out = ['-p']
  if (session.resumeId) out.push('--resume', session.resumeId)
  else if (session.sessionId) out.push('--session-id', session.sessionId)
  if (meta.body && meta.body.trim()) out.push('--append-system-prompt', meta.body.trim())
  if (meta.tools) out.push('--allowedTools', meta.tools)
  if (meta['permission-mode']) out.push('--permission-mode', meta['permission-mode'])
  if (meta.model) out.push('--model', meta.model)
  if (promptParts.length) out.push(promptParts.join(' '))
  return out
}
