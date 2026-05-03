// Frontmatter contracts for role and skill files.
//
// Schema declarations on disk (`schema: role-v1` / `schema: skill-v1`) are
// enforced here — files missing mandatory fields, declaring the wrong
// schema, or with malformed values are rejected with a clear error.
//
// Add a new schema version: bump the constant + the validator + bump the
// `schema:` declaration in shipped files. Old versions can keep working
// via additional validators (validateRoleV1, validateRoleV2, …).

const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const isPositiveInt = (v) => /^\d+$/.test(String(v)) && Number(v) >= 1
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0

const require_ = (meta, field, source, predicate, hint) => {
  const v = meta[field]
  if (v === undefined || v === null || v === '') {
    throw new Error(`${source}: missing required frontmatter field '${field}'${hint ? ` (${hint})` : ''}`)
  }
  if (predicate && !predicate(v)) {
    throw new Error(`${source}: frontmatter '${field}' failed validation${hint ? ` (${hint})` : ''} — got ${JSON.stringify(v)}`)
  }
}

// Common metadata trio shared by role-v1 and skill-v1 (DESIGN.md §8).
const requireMetadataTrio = (meta, source, schemaTag) => {
  require_(meta, 'schema', source, (v) => v === schemaTag, `must equal '${schemaTag}'`)
  require_(meta, 'version', source, isPositiveInt, 'positive integer')
  require_(meta, 'updated_at', source, (v) => ISO_8601_UTC.test(v), 'ISO-8601 UTC, e.g. 2026-05-03T00:00:00.000Z')
}

export const SKILL_SCHEMA = 'skill-v1'
export const ROLE_SCHEMA = 'role-v1'

export function validateSkillFrontmatter (meta, source = '<skill>') {
  requireMetadataTrio(meta, source, SKILL_SCHEMA)
  require_(meta, 'description', source, isNonEmptyString, 'one-line summary')
  require_(meta, 'tools', source, isNonEmptyString, 'comma-separated tool patterns')
  return meta
}

export function validateRoleFrontmatter (meta, source = '<role>') {
  requireMetadataTrio(meta, source, ROLE_SCHEMA)
  require_(meta, 'name', source, isNonEmptyString)
  require_(meta, 'description', source, isNonEmptyString, 'one-line summary')
  return meta
}
