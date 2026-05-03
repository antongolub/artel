import { describe, expect, it } from 'vitest'
import { contract } from '../_helpers.js'

const { validateRoleFrontmatter, validateSkillFrontmatter } = contract

const validSkill = {
  schema: 'skill-v1',
  version: '1',
  updated_at: '2026-05-03T00:00:00.000Z',
  description: 'Test skill',
  tools: 'Bash(echo *)',
}
const validRole = {
  schema: 'role-v1',
  version: '1',
  updated_at: '2026-05-03T00:00:00.000Z',
  name: 'tester',
  description: 'Test role',
}

describe('validateSkillFrontmatter', () => {
  it('accepts valid frontmatter', () => {
    expect(() => validateSkillFrontmatter(validSkill, 'inline')).not.toThrow()
  })

  it('rejects missing schema', () => {
    const { schema, ...rest } = validSkill
    expect(() => validateSkillFrontmatter(rest, 'inline')).toThrow(/schema/)
  })

  it('rejects wrong schema tag', () => {
    expect(() => validateSkillFrontmatter({ ...validSkill, schema: 'skill-v2' }, 'inline')).toThrow(/skill-v1/)
  })

  it('rejects malformed updated_at', () => {
    expect(() => validateSkillFrontmatter({ ...validSkill, updated_at: '2026-05-03' }, 'inline')).toThrow(/ISO-8601/)
  })

  it('rejects missing tools', () => {
    const { tools, ...rest } = validSkill
    expect(() => validateSkillFrontmatter(rest, 'inline')).toThrow(/tools/)
  })
})

describe('validateRoleFrontmatter', () => {
  it('accepts valid frontmatter', () => {
    expect(() => validateRoleFrontmatter(validRole, 'inline')).not.toThrow()
  })

  it('rejects missing name', () => {
    const { name, ...rest } = validRole
    expect(() => validateRoleFrontmatter(rest, 'inline')).toThrow(/name/)
  })

  it('rejects zero version', () => {
    expect(() => validateRoleFrontmatter({ ...validRole, version: '0' }, 'inline')).toThrow(/positive integer/)
  })
})
