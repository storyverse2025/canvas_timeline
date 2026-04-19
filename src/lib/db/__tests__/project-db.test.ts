import { describe, it, expect, beforeEach } from 'vitest'
import { useProjectDB } from '@/stores/project-db'

function resetDB() {
  useProjectDB.getState().clearAll()
}

describe('ProjectDB — Elements', () => {
  beforeEach(resetDB)

  it('adds and retrieves an element', () => {
    const id = useProjectDB.getState().addElement({
      kind: 'image', role: 'character', name: '角色1',
      content: 'https://example.com/char.png', description: '主角',
      source: 'manual',
    })
    const el = useProjectDB.getState().getElement(id)
    expect(el).toBeDefined()
    expect(el!.name).toBe('角色1')
    expect(el!.role).toBe('character')
    expect(el!.createdAt).toBeGreaterThan(0)
  })

  it('updates an element', () => {
    const id = useProjectDB.getState().addElement({
      kind: 'image', role: 'scene', name: '场景A',
      content: '', description: '', source: 'manual',
    })
    useProjectDB.getState().updateElement(id, { content: 'https://new-url.png' })
    expect(useProjectDB.getState().getElement(id)!.content).toBe('https://new-url.png')
    expect(useProjectDB.getState().getElement(id)!.updatedAt).toBeGreaterThan(0)
  })

  it('filters elements by role', () => {
    const db = useProjectDB.getState()
    db.addElement({ kind: 'image', role: 'character', name: 'C1', content: '', description: '', source: 'manual' })
    db.addElement({ kind: 'image', role: 'character', name: 'C2', content: '', description: '', source: 'manual' })
    db.addElement({ kind: 'image', role: 'scene', name: 'S1', content: '', description: '', source: 'manual' })
    expect(useProjectDB.getState().getElementsByRole('character')).toHaveLength(2)
    expect(useProjectDB.getState().getElementsByRole('scene')).toHaveLength(1)
    expect(useProjectDB.getState().getElementsByRole('prop')).toHaveLength(0)
  })

  it('filters elements by source', () => {
    const db = useProjectDB.getState()
    db.addElement({ kind: 'image', role: 'character', name: 'C1', content: '', description: '', source: 'manual' })
    db.addElement({ kind: 'image', role: 'scene', name: 'S1', content: '', description: '', source: 'generated' })
    expect(useProjectDB.getState().getElementsBySource('manual')).toHaveLength(1)
    expect(useProjectDB.getState().getElementsBySource('generated')).toHaveLength(1)
  })

  it('filters elements by kind', () => {
    const db = useProjectDB.getState()
    db.addElement({ kind: 'image', role: 'character', name: 'C1', content: '', description: '', source: 'manual' })
    db.addElement({ kind: 'text', role: 'script', name: 'Script', content: 'hello', description: '', source: 'manual' })
    expect(useProjectDB.getState().getElementsByKind('image')).toHaveLength(1)
    expect(useProjectDB.getState().getElementsByKind('text')).toHaveLength(1)
  })
})

describe('ProjectDB — Referential Integrity', () => {
  beforeEach(resetDB)

  it('deleting element nullifies storyboard FK references', () => {
    const db = useProjectDB.getState()
    const elId = db.addElement({ kind: 'image', role: 'character', name: 'C1', content: 'url', description: '', source: 'manual' })
    const rowId = db.addStoryboardRow({
      shotNumber: 'S1', sortOrder: 0, duration: 3,
      visualDescription: '', visualAnchor: '', shotSize: '',
      characterActions: '', emotionMood: '', lightingAtmosphere: '',
      dialogue: '', storyboardPrompts: '', motionPrompts: '',
      bgm: '', soundEffects: '',
      character1ElementId: elId,
    })
    expect(useProjectDB.getState().getStoryboardRow(rowId)!.character1ElementId).toBe(elId)

    db.deleteElement(elId)
    expect(useProjectDB.getState().getElement(elId)).toBeUndefined()
    expect(useProjectDB.getState().getStoryboardRow(rowId)!.character1ElementId).toBeUndefined()
  })

  it('deleting element removes its canvas nodes and edges', () => {
    const db = useProjectDB.getState()
    const elId = db.addElement({ kind: 'image', role: 'scene', name: 'S', content: '', description: '', source: 'manual' })
    const nodeId = db.addCanvasNode({ elementId: elId, x: 0, y: 0, width: 200, height: 100, type: 'image' })
    const el2 = db.addElement({ kind: 'image', role: 'prop', name: 'P', content: '', description: '', source: 'manual' })
    const node2 = db.addCanvasNode({ elementId: el2, x: 300, y: 0, width: 100, height: 100, type: 'image' })
    db.addCanvasEdge(nodeId, node2)

    expect(useProjectDB.getState().getAllCanvasNodes()).toHaveLength(2)
    expect(useProjectDB.getState().getAllCanvasEdges()).toHaveLength(1)

    db.deleteElement(elId)
    expect(useProjectDB.getState().getAllCanvasNodes()).toHaveLength(1)
    expect(useProjectDB.getState().getAllCanvasEdges()).toHaveLength(0) // edge removed because nodeId was deleted
  })

  it('deleting element nullifies generation history resultElementId', () => {
    const db = useProjectDB.getState()
    const elId = db.addElement({ kind: 'image', role: 'keyframe', name: 'KF', content: '', description: '', source: 'generated' })
    const hId = db.addHistoryEntry({
      capability: 'text-to-image', prompt: 'test', inputs: [], params: {},
      resultElementId: elId, resultUrl: 'url', resultKind: 'image',
      status: 'done',
    })
    db.deleteElement(elId)
    const h = Object.values(useProjectDB.getState().generationHistory).find((x) => x.id === hId)
    expect(h!.resultElementId).toBeUndefined()
  })

  it('deleting canvas node removes its edges but not the element', () => {
    const db = useProjectDB.getState()
    const elId = db.addElement({ kind: 'image', role: 'scene', name: 'S', content: '', description: '', source: 'manual' })
    const n1 = db.addCanvasNode({ elementId: elId, x: 0, y: 0, width: 200, height: 100, type: 'image' })
    const el2 = db.addElement({ kind: 'text', role: 'script', name: 'T', content: '', description: '', source: 'manual' })
    const n2 = db.addCanvasNode({ elementId: el2, x: 300, y: 0, width: 200, height: 100, type: 'text' })
    db.addCanvasEdge(n1, n2)

    db.deleteCanvasNode(n1)
    expect(useProjectDB.getState().getCanvasNode(n1)).toBeUndefined()
    expect(useProjectDB.getState().getElement(elId)).toBeDefined() // element preserved
    expect(useProjectDB.getState().getAllCanvasEdges()).toHaveLength(0)
  })
})

describe('ProjectDB — Canvas Nodes & Edges', () => {
  beforeEach(resetDB)

  it('adds node and retrieves by element id', () => {
    const db = useProjectDB.getState()
    const elId = db.addElement({ kind: 'image', role: 'character', name: 'C', content: '', description: '', source: 'manual' })
    const nodeId = db.addCanvasNode({ elementId: elId, x: 100, y: 200, width: 280, height: 180, type: 'image' })
    const node = useProjectDB.getState().getCanvasNodeByElementId(elId)
    expect(node).toBeDefined()
    expect(node!.id).toBe(nodeId)
    expect(node!.x).toBe(100)
  })

  it('deduplicates edges', () => {
    const db = useProjectDB.getState()
    const el1 = db.addElement({ kind: 'image', role: 'character', name: 'C', content: '', description: '', source: 'manual' })
    const el2 = db.addElement({ kind: 'image', role: 'scene', name: 'S', content: '', description: '', source: 'manual' })
    const n1 = db.addCanvasNode({ elementId: el1, x: 0, y: 0, width: 100, height: 100, type: 'image' })
    const n2 = db.addCanvasNode({ elementId: el2, x: 200, y: 0, width: 100, height: 100, type: 'image' })
    const e1 = db.addCanvasEdge(n1, n2)
    const e2 = db.addCanvasEdge(n1, n2) // duplicate
    expect(e1).toBe(e2)
    expect(useProjectDB.getState().getAllCanvasEdges()).toHaveLength(1)
  })
})

describe('ProjectDB — Storyboard Rows', () => {
  beforeEach(resetDB)

  it('adds rows and returns sorted', () => {
    const db = useProjectDB.getState()
    db.addStoryboardRow({ shotNumber: 'S2', sortOrder: 1, duration: 3, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })
    db.addStoryboardRow({ shotNumber: 'S1', sortOrder: 0, duration: 5, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })
    const sorted = useProjectDB.getState().getStoryboardRowsSorted()
    expect(sorted).toHaveLength(2)
    expect(sorted[0].shotNumber).toBe('S1')
    expect(sorted[1].shotNumber).toBe('S2')
  })

  it('inserts row after and shifts sort orders', () => {
    const db = useProjectDB.getState()
    const r1 = db.addStoryboardRow({ shotNumber: 'S1', sortOrder: 0, duration: 3, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })
    db.addStoryboardRow({ shotNumber: 'S2', sortOrder: 1, duration: 3, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })
    db.insertStoryboardRowAfter(r1, { shotNumber: 'S1.5', sortOrder: 0, duration: 2, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })

    const sorted = useProjectDB.getState().getStoryboardRowsSorted()
    expect(sorted).toHaveLength(3)
    expect(sorted[0].shotNumber).toBe('S1')
    expect(sorted[1].shotNumber).toBe('S1.5')
    expect(sorted[2].shotNumber).toBe('S2')
  })

  it('replaceAll clears and repopulates', () => {
    const db = useProjectDB.getState()
    db.addStoryboardRow({ shotNumber: 'OLD', sortOrder: 0, duration: 1, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })
    db.replaceAllStoryboardRows([
      { shotNumber: 'NEW1', sortOrder: 0, duration: 2, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' },
      { shotNumber: 'NEW2', sortOrder: 1, duration: 3, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' },
    ])
    const rows = useProjectDB.getState().getStoryboardRowsSorted()
    expect(rows).toHaveLength(2)
    expect(rows[0].shotNumber).toBe('NEW1')
  })
})

describe('ProjectDB — Generation History', () => {
  beforeEach(resetDB)

  it('adds and queries history by capability', () => {
    const db = useProjectDB.getState()
    db.addHistoryEntry({ capability: 'text-to-image', prompt: 'cat', inputs: [], params: {}, resultUrl: 'url1', resultKind: 'image', status: 'done' })
    db.addHistoryEntry({ capability: 'text-to-video', prompt: 'dog', inputs: [], params: {}, resultUrl: 'url2', resultKind: 'video', status: 'done' })
    db.addHistoryEntry({ capability: 'text-to-image', prompt: 'bird', inputs: [], params: {}, resultUrl: 'url3', resultKind: 'image', status: 'done' })

    expect(useProjectDB.getState().getHistoryByCapability('text-to-image')).toHaveLength(2)
    expect(useProjectDB.getState().getHistoryByCapability('text-to-video')).toHaveLength(1)
  })

  it('returns all history sorted by newest first', () => {
    const db = useProjectDB.getState()
    db.addHistoryEntry({ capability: 'a', prompt: '', inputs: [], params: {}, resultKind: 'image', status: 'done' })
    db.addHistoryEntry({ capability: 'b', prompt: '', inputs: [], params: {}, resultKind: 'image', status: 'done' })
    const all = useProjectDB.getState().getAllHistory()
    expect(all).toHaveLength(2)
    expect(all[0].createdAt).toBeGreaterThanOrEqual(all[1].createdAt)
  })
})

describe('ProjectDB — Art Direction & Script', () => {
  beforeEach(resetDB)

  it('has defaults', () => {
    const art = useProjectDB.getState().artDirection
    expect(art.stylePreset).toBe('cinematic')
    expect(art.defaultAspectRatio).toBe('16:9')
  })

  it('updates art direction', () => {
    useProjectDB.getState().updateArtDirection({ stylePreset: 'anime', customStyle: '赛博朋克' })
    const art = useProjectDB.getState().artDirection
    expect(art.stylePreset).toBe('anime')
    expect(art.customStyle).toBe('赛博朋克')
    expect(art.updatedAt).toBeGreaterThan(0)
  })

  it('updates script', () => {
    useProjectDB.getState().updateScript({ text: '第一幕：黎明' })
    expect(useProjectDB.getState().script.text).toBe('第一幕：黎明')
    expect(useProjectDB.getState().script.updatedAt).toBeGreaterThan(0)
  })
})

describe('ProjectDB — clearAll', () => {
  it('resets everything to defaults', () => {
    const db = useProjectDB.getState()
    db.addElement({ kind: 'image', role: 'character', name: 'C', content: '', description: '', source: 'manual' })
    db.addStoryboardRow({ shotNumber: 'S1', sortOrder: 0, duration: 3, visualDescription: '', visualAnchor: '', shotSize: '', characterActions: '', emotionMood: '', lightingAtmosphere: '', dialogue: '', storyboardPrompts: '', motionPrompts: '', bgm: '', soundEffects: '' })
    db.updateScript({ text: 'script' })

    db.clearAll()
    expect(Object.keys(useProjectDB.getState().elements)).toHaveLength(0)
    expect(Object.keys(useProjectDB.getState().storyboardRows)).toHaveLength(0)
    expect(useProjectDB.getState().script.text).toBe('')
    expect(useProjectDB.getState().artDirection.stylePreset).toBe('cinematic')
  })
})
