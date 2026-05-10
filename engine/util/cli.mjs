// CLI helpers shared by every `engine/cli/*.mjs` entrypoint.
//
// PROJECT_DIR — resolved from `ARTEL_PROJECT_DIR` env or `process.cwd()`.
// Consumed as a module-level constant; CLIs are short-lived processes,
// so reading the env once at import time is fine.
//
// Color helpers — ANSI escapes when stdout is a TTY, plain text
// otherwise. Six wrappers cover the colours every CLI uses today
// (`dim` / `bold` / `cyan` / `green` / `yellow` / `red`); `c(code, s)`
// is exposed for one-off codes (e.g. `c('35', s)` for magenta).
//
// die — print to stderr and exit. Default code 1; callers pass 2 for
// argv parsing failures (matches the pre-extraction convention).

export const PROJECT_DIR = process.env.ARTEL_PROJECT_DIR || process.cwd()

const tty = process.stdout.isTTY

export const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
export const dim = (s) => c('2', s)
export const bold = (s) => c('1', s)
export const cyan = (s) => c('36', s)
export const green = (s) => c('32', s)
export const yellow = (s) => c('33', s)
export const red = (s) => c('31', s)

export const die = (msg, code = 1) => {
  console.error(msg)
  process.exit(code)
}
