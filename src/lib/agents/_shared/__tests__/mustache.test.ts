import { describe, it, expect } from 'vitest'
import { fillTemplate, listTemplateVars } from '@/lib/agents/_shared/mustache/fill'
import { parseFrontmatter } from '@/lib/agents/_shared/mustache/frontmatter'

describe('fillTemplate', () => {
  it('replaces {{var}} with values', () => {
    expect(fillTemplate('hi {{name}}!', { name: 'Ada' })).toBe('hi Ada!')
  })

  it('replaces missing vars with empty string', () => {
    expect(fillTemplate('hi {{name}}{{tail}}', { name: 'Ada' })).toBe('hi Ada')
  })

  it('replaces repeated vars', () => {
    expect(fillTemplate('{{x}}-{{x}}', { x: 'q' })).toBe('q-q')
  })
})

describe('listTemplateVars', () => {
  it('returns unique vars in order of first appearance', () => {
    expect(listTemplateVars('a={{a}} b={{b}} a={{a}}')).toEqual(['a', 'b'])
  })

  it('returns empty array when none', () => {
    expect(listTemplateVars('plain text')).toEqual([])
  })
})

describe('parseFrontmatter', () => {
  it('handles a file with no frontmatter', () => {
    const r = parseFrontmatter('just body text\n')
    expect(r.data).toEqual({})
    expect(r.body).toBe('just body text\n')
  })

  it('parses scalar keys', () => {
    const r = parseFrontmatter('---\nname: foo\nmodel: claude-sonnet-4-5\n---\nbody\n')
    expect(r.data).toEqual({ name: 'foo', model: 'claude-sonnet-4-5' })
    expect(r.body).toBe('body\n')
  })

  it('coerces numbers and booleans', () => {
    const r = parseFrontmatter('---\nn: 42\nx: 3.14\nflag: true\noff: false\nnone: null\n---\n')
    expect(r.data).toEqual({ n: 42, x: 3.14, flag: true, off: false, none: null })
  })

  it('parses inline arrays', () => {
    const r = parseFrontmatter('---\nsubAgents: [a, b, c]\n---\n')
    expect(r.data.subAgents).toEqual(['a', 'b', 'c'])
  })

  it('parses block lists of scalars', () => {
    const r = parseFrontmatter('---\nsubAgents:\n  - framework-qa\n  - writing-expansion\n---\n')
    expect(r.data.subAgents).toEqual(['framework-qa', 'writing-expansion'])
  })

  it('parses block lists of inline maps (tools shape)', () => {
    const yaml = [
      '---',
      'tools:',
      '  - capability: text-to-image',
      '    provider: openai',
      '    model: gpt-image-2',
      '  - capability: storyboard-qc',
      '  - peer: actor-agent',
      '---',
      '',
    ].join('\n')
    const r = parseFrontmatter(yaml)
    expect(r.data.tools).toEqual([
      { capability: 'text-to-image', provider: 'openai', model: 'gpt-image-2' },
      { capability: 'storyboard-qc' },
      { peer: 'actor-agent' },
    ])
  })

  it('strips quoted scalars', () => {
    const r = parseFrontmatter('---\nname: "with spaces"\nother: \'single\'\n---\n')
    expect(r.data).toEqual({ name: 'with spaces', other: 'single' })
  })

  it('skips comment lines and blanks', () => {
    const yaml = '---\n# leading comment\nname: foo\n\n# trailing\n---\n'
    const r = parseFrontmatter(yaml)
    expect(r.data).toEqual({ name: 'foo' })
  })
})
