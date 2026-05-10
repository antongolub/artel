// Minimal chalk-shaped TTY colorizer + a thin die() exit helper.
// One cohesive surface — consumers reach for `chalk.dim(s)`,
// `chalk.cyan(s)`, etc. `chalk.c(code, s)` is the primitive for
// arbitrary SGR codes. `die` lives next to it because both are tiny
// CLI presentation primitives.

const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)

export const chalk = {
  c,
  dim:     (s) => c('2', s),
  bold:    (s) => c('1', s),
  cyan:    (s) => c('36', s),
  green:   (s) => c('32', s),
  yellow:  (s) => c('33', s),
  red:     (s) => c('31', s),
  magenta: (s) => c('35', s),
}

export const die = (msg, code = 1) => { console.error(msg); process.exit(code) }
