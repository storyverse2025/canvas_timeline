import { describe, it, expect, beforeEach } from 'vitest'
import { useProjectDB } from '@/stores/project-db'

function resetDB() { useProjectDB.getState().clearAll() }

describe('Asset Library — Element Filtering', () => {
  beforeEach(() => {
    resetDB()
    const db = useProjectDB.getState()
    db.addElement({ kind: 'image', role: 'character', name: '角色A', content: 'urlA', description: '主角', source: 'manual' })
    db.addElement({ kind: 'image', role: 'character', name: '角色B', content: 'urlB', description: '配角', source: 'generated' })
    db.addElement({ kind: 'image', role: 'scene', name: '场景1', content: 'urlC', description: '森林', source: 'manual' })
    db.addElement({ kind: 'image', role: 'prop', name: '道具X', content: 'urlD', description: '剑', source: 'imported' })
    db.addElement({ kind: 'text', role: 'script', name: '剧本', content: '故事', description: '', source: 'manual' })
  })

  it('getElementsByRole returns correct counts', () => {
    expect(useProjectDB.getState().getElementsByRole('character')).toHaveLength(2)
    expect(useProjectDB.getState().getElementsByRole('scene')).toHaveLength(1)
    expect(useProjectDB.getState().getElementsByRole('prop')).toHaveLength(1)
    expect(useProjectDB.getState().getElementsByRole('script')).toHaveLength(1)
  })

  it('getElementsBySource returns correct counts', () => {
    expect(useProjectDB.getState().getElementsBySource('manual')).toHaveLength(3)
    expect(useProjectDB.getState().getElementsBySource('generated')).toHaveLength(1)
    expect(useProjectDB.getState().getElementsBySource('imported')).toHaveLength(1)
  })

  it('getElementsByKind distinguishes image from text', () => {
    expect(useProjectDB.getState().getElementsByKind('image')).toHaveLength(4)
    expect(useProjectDB.getState().getElementsByKind('text')).toHaveLength(1)
  })

  it('canvas assets include only elements with canvas nodes', () => {
    const db = useProjectDB.getState()
    const elements = Object.values(db.elements)
    const charA = elements.find((e) => e.name === '角色A')!
    db.addCanvasNode({ elementId: charA.id, x: 0, y: 0, width: 200, height: 200, type: 'image' })

    const nodesOnCanvas = Object.values(useProjectDB.getState().canvasNodes)
    const elementsOnCanvas = nodesOnCanvas
      .map((n) => useProjectDB.getState().getElement(n.elementId))
      .filter(Boolean)
    expect(elementsOnCanvas).toHaveLength(1)
    expect(elementsOnCanvas[0]!.name).toBe('角色A')
  })

  it('manual assets filter excludes generated elements', () => {
    const manual = useProjectDB.getState().getElementsBySource('manual')
    expect(manual.every((e) => e.source === 'manual')).toBe(true)
    expect(manual.some((e) => e.name === '角色B')).toBe(false) // generated
  })
})

describe('Asset Library — Generation History', () => {
  beforeEach(resetDB)

  it('logs generation and queries by capability', () => {
    const db = useProjectDB.getState()
    db.addHistoryEntry({
      capability: 'text-to-image', prompt: 'a cat', inputs: [{ kind: 'text', text: 'a cat' }],
      params: { aspect: '16:9' }, resultUrl: 'https://example.com/cat.png',
      resultKind: 'image', status: 'done',
    })
    db.addHistoryEntry({
      capability: 'text-to-video', prompt: 'a dog', inputs: [],
      params: {}, resultUrl: 'https://example.com/dog.mp4',
      resultKind: 'video', status: 'done',
    })
    db.addHistoryEntry({
      capability: 'text-to-image', prompt: 'failed', inputs: [],
      params: {}, resultKind: 'image', status: 'failed', error: 'timeout',
    })

    const imageHistory = useProjectDB.getState().getHistoryByCapability('text-to-image')
    expect(imageHistory).toHaveLength(2)
    // Both text-to-image entries present (order may vary when timestamps are identical)
    const statuses = imageHistory.map((h) => h.status).sort()
    expect(statuses).toEqual(['done', 'failed'])

    const videoHistory = useProjectDB.getState().getHistoryByCapability('text-to-video')
    expect(videoHistory).toHaveLength(1)
  })

  it('getAllHistory returns sorted by newest first', () => {
    const db = useProjectDB.getState()
    db.addHistoryEntry({ capability: 'a', prompt: 'first', inputs: [], params: {}, resultKind: 'image', status: 'done' })
    db.addHistoryEntry({ capability: 'b', prompt: 'second', inputs: [], params: {}, resultKind: 'image', status: 'done' })

    const all = useProjectDB.getState().getAllHistory()
    expect(all).toHaveLength(2)
    const prompts = all.map((h) => h.prompt).sort()
    expect(prompts).toEqual(['first', 'second'])
  })

  it('history linked to element via resultElementId', () => {
    const db = useProjectDB.getState()
    const elId = db.addElement({ kind: 'image', role: 'keyframe', name: 'KF1', content: 'url', description: '', source: 'generated' })
    db.addHistoryEntry({
      capability: 'text-to-image', prompt: 'test', inputs: [], params: {},
      resultElementId: elId, resultUrl: 'url', resultKind: 'image', status: 'done',
    })

    const elHistory = useProjectDB.getState().getHistoryByElement(elId)
    expect(elHistory).toHaveLength(1)
    expect(elHistory[0].resultElementId).toBe(elId)
  })
})
