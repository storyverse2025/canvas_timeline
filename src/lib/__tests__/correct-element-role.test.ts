import { describe, expect, it } from 'vitest'
import { correctElementRole, guessRoleFromName } from '@/lib/canvas-elements'

describe('correctElementRole', () => {
  it('downgrades a scene/prop mislabeled as character (the 场景：悬空断桥 bug)', () => {
    expect(correctElementRole('场景：悬空断桥', 'character')).toBe('scene')
    expect(correctElementRole('道具：心灯', 'character')).toBe('prop')
    expect(correctElementRole('霜鸣剑（武器）', 'character')).toBe('prop')
    expect(correctElementRole('森林深处', 'character')).toBe('scene')
  })

  it('leaves real character names as character', () => {
    expect(correctElementRole('沈玦', 'character')).toBe('character')
    expect(correctElementRole('墨渊', 'character')).toBe('character')
    expect(correctElementRole('白衣剑修 Erin', 'character')).toBe('character')
  })

  it('never touches non-character roles', () => {
    expect(correctElementRole('悬空断桥', 'scene')).toBe('scene')
    expect(correctElementRole('心灯', 'prop')).toBe('prop')
    // Even a name with a character keyword stays scene if that's the stored role.
    expect(correctElementRole('主角的房间', 'scene')).toBe('scene')
  })

  it('guessRoleFromName basics', () => {
    expect(guessRoleFromName('场景：断桥')).toBe('scene')
    expect(guessRoleFromName('道具：剑')).toBe('prop')
    expect(guessRoleFromName('沈玦')).toBe('unknown')
  })
})
