// Skill resolver. Roles declare abstract `skills:` (e.g.
// `git-write, file-edit, test-runner`); the resolver expands each name
// into concrete tool patterns from a skill catalog.
//
// Lookup order (first match wins):
//   1. <projectArtelDir>/skills/<name>.md   (project override)
//   2. <platformDir>/skills/<name>.md       (platform default)
//
// Skill files are markdown with frontmatter; `tools:` is a comma-list
// of patterns matching the engine driver's allowlist syntax (Claude's
// `--allowedTools`, etc.).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'
import { validateSkillFrontmatter } from './contract.mjs'

const SKILL_FILE = (name) => `${name}.md`

const splitList = (s) =>
  (s || '').split(',').map((x) => x.trim()).filter(Boolean)

export function findSkillFile (name, dirs) {
  for (const dir of dirs) {
    const path = join(dir, SKILL_FILE(name))
    if (existsSync(path)) return path
  }
  return null
}

export function loadSkill (name, dirs) {
  const path = findSkillFile(name, dirs)
  if (!path) {
    throw new Error(
      `Skill '${name}' not found. Looked in:\n  ` + dirs.join('\n  ') +
      `\nDeclare it in <project>/.artel/skills/${name}.md or the platform's skills/.`,
    )
  }
  const { meta } = parseFrontmatter(readFileSync(path, 'utf8'))
  validateSkillFrontmatter(meta, path)
  return { name, path, tools: splitList(meta.tools) }
}

// Expand a list of skill names into a deduplicated array of tool patterns.
export function expandSkills (skillNames, dirs) {
  const seen = new Set()
  const out = []
  for (const name of skillNames) {
    for (const tool of loadSkill(name, dirs).tools) {
      if (seen.has(tool)) continue
      seen.add(tool)
      out.push(tool)
    }
  }
  return out
}
