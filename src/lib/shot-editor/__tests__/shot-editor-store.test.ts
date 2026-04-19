import { describe, it, expect, beforeEach } from 'vitest'
import { useShotEditorStore } from '@/stores/shot-editor-store'

function reset() {
  useShotEditorStore.getState().closeEditor()
}

describe('ShotEditorStore', () => {
  beforeEach(reset)

  it('starts closed', () => {
    const s = useShotEditorStore.getState()
    expect(s.isOpen).toBe(false)
    expect(s.activeRowId).toBeNull()
  })

  it('opens with row id and default mode', () => {
    useShotEditorStore.getState().openEditor('row-1')
    const s = useShotEditorStore.getState()
    expect(s.isOpen).toBe(true)
    expect(s.activeRowId).toBe('row-1')
    expect(s.editMode).toBe('dialog')
  })

  it('opens with specific mode', () => {
    useShotEditorStore.getState().openEditor('row-2', 'inpaint')
    expect(useShotEditorStore.getState().editMode).toBe('inpaint')
  })

  it('switches mode', () => {
    useShotEditorStore.getState().openEditor('row-1')
    useShotEditorStore.getState().setEditMode('multi-angle')
    expect(useShotEditorStore.getState().editMode).toBe('multi-angle')
  })

  it('closes editor', () => {
    useShotEditorStore.getState().openEditor('row-1')
    useShotEditorStore.getState().closeEditor()
    expect(useShotEditorStore.getState().isOpen).toBe(false)
    expect(useShotEditorStore.getState().activeRowId).toBeNull()
  })

  it('navigates to different row preserving mode', () => {
    useShotEditorStore.getState().openEditor('row-1', 'association')
    useShotEditorStore.getState().openEditor('row-2', 'association')
    const s = useShotEditorStore.getState()
    expect(s.activeRowId).toBe('row-2')
    expect(s.editMode).toBe('association')
    expect(s.isOpen).toBe(true)
  })
})
