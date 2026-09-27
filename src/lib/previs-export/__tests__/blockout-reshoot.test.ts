import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn() }) }))
vi.mock('@/lib/capabilities/client', () => ({ runCapability: vi.fn() }))
vi.mock('@/hooks/useStoryboardGenerate', () => ({ resolveShootAvatarRefs: vi.fn(async () => ({ refs: [], byteplusMatched: [] })) }))

import { runCapability } from '@/lib/capabilities/client'
import { resolveShootAvatarRefs } from '@/hooks/useStoryboardGenerate'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useLibtvTasksStore } from '@/stores/libtv-tasks-store'
import { EMPTY_ELEMENT_SLOT, type StoryboardRow } from '@/types/storyboard'
import { buildBlockoutPrompt, filterShotDescription, colorName, playableBlockoutUrl, stripBlockoutBlock, type PrevisBeatClip } from '../blockout-reshoot-prompt'
import { blockoutClipOf, reshootInputsWithBlockout, reshootOneBeatFromClip } from '../blockout-reshoot'

const beat = (over: Partial<PrevisBeatClip> = {}): PrevisBeatClip => ({
  beat: 1,
  shotId: 'row-1',
  start: 0,
  duration: 12,
  clipUrl: 'http://studio.example/canvas-import/cb323d4f/blockout/beat01.mp4?v=1',
  localUrl: '/uploads/previs-cb323d4f-beat01.mp4',
  characters: [
    { key: 'base_character_zachary', name: 'Zachary', color: '#4f8cff' },
    { key: 'base_character_charlie', name: 'Charlie', color: '#ff6b6b' },
  ],
  segments: [
    { t0: 0, t1: 2.5, shotSize: 'wide', cameraMotion: 'static_shot', cameraPreset: 'over-shoulder', subject: 'base_character_zachary' },
    { t0: 2.5, t1: 5, shotSize: 'medium', cameraMotion: 'dolly_in', cameraPreset: null, subject: 'base_character_charlie' },
  ],
  ...over,
})

describe('buildBlockoutPrompt', () => {
  // 「替换」口吻，不是「参考」口吻：实测说「参考 @白模1 的运镜…」模型会自己设计镜头，
  // 说「把蓝色假人替换成 @图片N 的人物」它才把机位/构图/切点/朝向整套保住。
  it('用替换口吻，并把假人颜色映射到对应角色图', () => {
    const p = buildBlockoutPrompt({ basePrompt: 'Charlie walks in.', beat: beat(), imageIndexOf: { base_character_zachary: 2 }, styleImageIndex: 3 })
    expect(p).toContain('把 @白模1 里的蓝色假人替换成 @图片2 的人物（Zachary）。')
    // 白模的职责要划死，否则它的灰模布景会漏进成片和真实场景混在一起。
    expect(p).toContain('@白模1 只用来定两件事')
    expect(p).toContain('里的布景、地面、天空、材质和颜色一概不作数')
    // 两条锁分别治实测出来的两种漂移：单人镜头冒出另一个人、白模半身被拍成全身。
    expect(p).toContain('不要把另一个人加回画面')
    expect(p).toContain('白模里是半身就不要拍成全身')
    expect(p).toContain('@图片3 只作画面风格参考')
    expect(p).toContain('不能出现假人')
    // 镜头切分表不再写进 prompt：那是 @白模1 自己就能传达的信息，重复说只会打架。
    expect(p).not.toContain('[0-2.5s]')
    expect(p.endsWith('【镜头描述】\nCharlie walks in.')).toBe(true)
  })

  it('replaces an earlier block instead of stacking a second one', () => {
    const once = buildBlockoutPrompt({ basePrompt: 'Charlie walks in.', beat: beat() })
    const twice = buildBlockoutPrompt({ basePrompt: once, beat: beat({ duration: 11 }) })
    expect(twice.match(/【白模参考 @白模1】/g)).toHaveLength(1)
    expect(twice).toContain('时长 11 秒')
    expect(stripBlockoutBlock(twice)).toBe('Charlie walks in.')
    expect(stripBlockoutBlock('plain prompt')).toBe('plain prompt')
    // 旧块用的是 @视频1，认不出来就会在重拍时叠加两个块。
    expect(stripBlockoutBlock('【白模参考 @视频1】\n旧的\n【镜头描述】\nCharlie walks in.')).toBe('Charlie walks in.')
  })

  it('maps a blockout clip URL to the canvas-local copy for playback', () => {
    expect(playableBlockoutUrl('http://studio.x/canvas-import/cb323d4f/blockout/beat03.mp4?v=9'))
      .toBe('/uploads/previs-cb323d4f-beat03.mp4')
    expect(playableBlockoutUrl('https://other/clip.mp4')).toBe('https://other/clip.mp4')
  })

  it('names palette colours exactly and buckets arbitrary ones by hue', () => {
    expect(colorName('#06D6A0')).toBe('绿色')
    expect(colorName('#ff0000')).toBe('红色')
    expect(colorName('#2040ff')).toBe('蓝色')
    expect(colorName('#808080')).toBe('灰色')
  })
})

function row(over: Partial<StoryboardRow>): StoryboardRow {
  return { id: 'row-1', shot_number: 'S1', duration: 12, ...over } as StoryboardRow
}

describe('reshootInputsWithBlockout', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAll()
    useCanvasItemStore.setState({ items: {} })
    useStoryboardStore.setState({ rows: [] })
    useLibtvTasksStore.setState({ tasks: {} })
    vi.mocked(runCapability).mockReset()
    vi.stubGlobal('window', { confirm: vi.fn(() => true) })
  })

  it('fans out previs → blockout clip node → new video node, leaving the source video untouched', async () => {
    const items = useCanvasItemStore.getState()
    const canvas = useCanvasStore.getState()
    const zach = items.addItem({ kind: 'image', role: 'character', name: 'Zachary', content: '/uploads/zach.png' })
    const charlie = items.addItem({ kind: 'image', role: 'character', name: 'Charlie', content: '/uploads/charlie.png' })
    const zachNode = canvas.addItemNode(zach, 'image', { x: 0, y: 0 })
    const charlieNode = canvas.addItemNode(charlie, 'image', { x: 0, y: 0 })
    const video = items.addItem({
      kind: 'video', role: 'beat-video', name: 'BV-S1', content: 'https://old/v1.mp4',
      prompt: '【白模参考 @视频1】\nstale\n【镜头描述】\nCharlie walks in.',
      refImages: ['/uploads/grid.png', '/uploads/zach-sheet.png', '/uploads/scene.png'], refAudios: ['/voices/charlie.mp3'],
    })
    const videoNode = canvas.addItemNode(video, 'video', { x: 0, y: 0 })
    const stray = items.addItem({ kind: 'video', role: 'beat-video', name: 'BV-X', content: 'https://old/x.mp4' })
    const strayNode = canvas.addItemNode(stray, 'video', { x: 0, y: 0 })
    const previs = items.addItem({ kind: 'video', role: 'beat-video-alternate', name: '3D预演', content: '/uploads/previs-cb323d4f.mp4', provider: 'storyai-director-studio' })
    const previsNode = canvas.addItemNode(previs, 'video', { x: 0, y: 0 })
    canvas.addEdge(videoNode, previsNode)
    canvas.addEdge(strayNode, previsNode)
    canvas.addEdge(zachNode, previsNode)
    useStoryboardStore.setState({
      rows: [row({
        beatVideoNodeId: videoNode,
        keyframeUrl: '/uploads/grid.png',
        keyframeCleanUrl: '/uploads/kf-clean.png',
        identitySheetUrls: ['/uploads/zach-sheet.png', ''],
        characters: [
          { ...EMPTY_ELEMENT_SLOT, description: 'Zachary', nodeId: zachNode, image: '/uploads/zach.png' },
          { ...EMPTY_ELEMENT_SLOT, description: 'Charlie', nodeId: charlieNode, image: '/uploads/charlie.png' },
        ],
      })],
    })

    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ shortId: 'cb323d4f', beats: [beat()] }) }))
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(runCapability).mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://new/v1.mp4' }] } as never)

    await reshootInputsWithBlockout(previsNode)

    expect(fetchMock).toHaveBeenCalledWith('/previs/beats?shortId=cb323d4f', expect.anything())
    expect(runCapability).toHaveBeenCalledTimes(1)
    const req = vi.mocked(runCapability).mock.calls[0][0]
    expect(req.capability).toBe('text-to-video')
    expect(req.params).toMatchObject({ duration: '12', model: 'dreamina-seedance-2-0-260128' })
    // 只带本镜出场人物的 角色图 + 关键帧。场景图/道具图/原节点其它参考图一律不带：
    // 实测参考图越多，白模的运镜和走位越压不住（6 张时整个镜头被重造）。
    expect(req.inputs.filter((i) => i.kind === 'image').map((i) => (i as { url: string }).url))
      .toEqual(['/uploads/zach.png', '/uploads/charlie.png'])
    expect(req.inputs.filter((i) => i.kind === 'video')).toEqual([{ kind: 'video', url: beat().clipUrl }])
    expect(req.inputs.filter((i) => i.kind === 'audio')).toHaveLength(1)
    const prompt = (req.inputs.find((i) => i.kind === 'text') as { text: string }).text
    expect(prompt).toContain('蓝色假人替换成 @图片1 的人物（Zachary）')
    expect(prompt).toContain('红色假人替换成 @图片2 的人物（Charlie）')
    // 分镜正文接回来，但要先按数据过滤掉白模没拍到的内容（见 filterShotDescription）。
    // 这里两个人物都没有动作时间窗，过滤器不删任何内容，正文原样保留。
    expect(prompt).toContain('Charlie walks in.')
    // The grid competes with the blockout for camera authority — it must be gone.
    expect(prompt).not.toContain('黑白手绘分镜图')
    expect(prompt).not.toContain('stale')

    // Source videos are untouched; the results are new nodes.
    expect(useCanvasItemStore.getState().items[video].content).toBe('https://old/v1.mp4')
    expect(useCanvasItemStore.getState().items[video].versions).toBeUndefined()
    expect(useCanvasItemStore.getState().items[stray].content).toBe('https://old/x.mp4')

    const all = Object.values(useCanvasItemStore.getState().items)
    const blockout = all.find((i) => i.content === beat().localUrl)!
    const result = all.find((i) => i.content === 'https://new/v1.mp4')!
    expect(blockout.name).toBe('白模 · S1')
    // Canvas plays the local copy; Seedance gets the public studio URL.
    expect(blockout.refVideos).toEqual([beat().clipUrl])
    expect(result.name).toBe('S1 白模重拍')
    expect(result.refVideos).toEqual([beat().clipUrl])
    // Settings carry into 编辑面板 → 用 Prompt 重新生成.
    expect(result.genParams).toMatchObject({ duration: '12', resolution: '720p', aspect: '16:9' })
    expect(result.role).toBe('beat-video-alternate')

    const nodeOf = (itemId: string) => useCanvasStore.getState().nodes.find((n) => n.data.itemId === itemId)!.id
    const edges = useCanvasStore.getState().edges.map((e) => `${e.source}->${e.target}`)
    expect(edges).toContain(`${previsNode}->${nodeOf(blockout.id)}`)
    expect(edges).toContain(`${nodeOf(blockout.id)}->${nodeOf(result.id)}`)
    expect(edges).toContain(`${videoNode}->${nodeOf(result.id)}`)
    // The storyboard row still points at the original video.
    expect(useStoryboardStore.getState().rows[0].beatVideoNodeId).toBe(videoNode)
    expect(Object.keys(useLibtvTasksStore.getState().tasks)).toHaveLength(0)
  })

  it('privacy block + 开白 cast: retries once with asset:// faces instead of 角色图 / keyframe', async () => {
    const items = useCanvasItemStore.getState()
    const canvas = useCanvasStore.getState()
    const zach = items.addItem({ kind: 'image', role: 'character', name: 'Zachary', content: '/uploads/zach.png' })
    const zachNode = canvas.addItemNode(zach, 'image', { x: 0, y: 0 })
    const video = items.addItem({
      kind: 'video', role: 'beat-video', name: 'BV-S1', content: 'https://old/v1.mp4', prompt: 'Zachary waits.',
      refImages: ['/uploads/zach.png', '/uploads/scene.png'],
    })
    const videoNode = canvas.addItemNode(video, 'video', { x: 0, y: 0 })
    const previs = items.addItem({ kind: 'video', name: '3D预演', content: '/uploads/previs-cb323d4f.mp4', provider: 'storyai-director-studio' })
    const previsNode = canvas.addItemNode(previs, 'video', { x: 0, y: 0 })
    canvas.addEdge(videoNode, previsNode)
    useStoryboardStore.setState({
      rows: [row({ beatVideoNodeId: videoNode, keyframeCleanUrl: '/uploads/kf-clean.png', characters: [{ ...EMPTY_ELEMENT_SLOT, description: 'Zachary', nodeId: zachNode, image: '/uploads/zach.png' }] })],
    })
    const zachRef = { assetUri: 'asset://asset-zach', characterName: 'Zachary', slotLabel: '角色1' }
    vi.mocked(resolveShootAvatarRefs).mockResolvedValueOnce({ refs: [zachRef], byteplusMatched: [zachRef] })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ beats: [beat({ characters: [beat().characters[0]] })] }) })))
    vi.mocked(runCapability)
      .mockRejectedValueOnce(new Error('BytePlus create 400: InputImageSensitiveContentDetected.PrivacyInformation'))
      .mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://new/v1.mp4' }] } as never)

    await reshootInputsWithBlockout(previsNode)

    expect(runCapability).toHaveBeenCalledTimes(2)
    const first = vi.mocked(runCapability).mock.calls[0][0]
    expect(first.inputs.filter((i) => i.kind === 'image').map((i) => (i as { url: string }).url)).toEqual(['/uploads/zach.png'])
    expect(first.params?.avatarAssetUris).toBeUndefined()
    const retry = vi.mocked(runCapability).mock.calls[1][0]
    expect(retry.inputs.filter((i) => i.kind === 'image').map((i) => (i as { url: string }).url)).toEqual([])
    expect(retry.params).toMatchObject({ avatarAssetUris: ['asset://asset-zach'], resolution: '720p' })
    const prompt = (retry.inputs.find((i) => i.kind === 'text') as { text: string }).text
    expect(prompt).toContain('蓝色假人替换成 @图片1 的人物（Zachary）')
    expect(useCanvasItemStore.getState().items[video].content).toBe('https://old/v1.mp4')
    expect(Object.values(useCanvasItemStore.getState().items).some((i) => i.content === 'https://new/v1.mp4')).toBe(true)
  })

  it('re-running reuses the beat\'s blockout node and adds another result node', async () => {
    const items = useCanvasItemStore.getState()
    const canvas = useCanvasStore.getState()
    const video = items.addItem({ kind: 'video', role: 'beat-video', name: 'BV-S1', content: 'https://old/v1.mp4', prompt: 'Charlie walks in.' })
    const videoNode = canvas.addItemNode(video, 'video', { x: 0, y: 0 })
    const previs = items.addItem({ kind: 'video', name: '3D预演', content: '/uploads/previs-cb323d4f.mp4', provider: 'storyai-director-studio' })
    const previsNode = canvas.addItemNode(previs, 'video', { x: 0, y: 0 })
    canvas.addEdge(videoNode, previsNode)
    useStoryboardStore.setState({ rows: [row({ beatVideoNodeId: videoNode })] })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ beats: [beat()] }) })))
    vi.mocked(runCapability)
      .mockResolvedValueOnce({ outputs: [{ kind: 'video', url: 'https://new/v1.mp4' }] } as never)
      .mockResolvedValueOnce({ outputs: [{ kind: 'video', url: 'https://new/v2.mp4' }] } as never)

    await reshootInputsWithBlockout(previsNode)
    await reshootInputsWithBlockout(previsNode)

    const all = Object.values(useCanvasItemStore.getState().items)
    expect(all.filter((i) => i.content === beat().localUrl)).toHaveLength(1)
    expect(all.filter((i) => i.name === 'S1 白模重拍')).toHaveLength(2)
    expect(all.map((i) => i.content)).toEqual(expect.arrayContaining(['https://new/v1.mp4', 'https://new/v2.mp4']))
  })

  it('re-shoots a single beat from its blockout clip node', async () => {
    const items = useCanvasItemStore.getState()
    const canvas = useCanvasStore.getState()
    const video = items.addItem({ kind: 'video', role: 'beat-video', name: 'BV-S1', content: 'https://old/v1.mp4', prompt: 'Charlie walks in.' })
    const videoNode = canvas.addItemNode(video, 'video', { x: 0, y: 0 })
    const previs = items.addItem({ kind: 'video', name: '3D预演', content: '/uploads/previs-cb323d4f.mp4', provider: 'storyai-director-studio' })
    const previsNode = canvas.addItemNode(previs, 'video', { x: 0, y: 0 })
    const clip = items.addItem({
      kind: 'video', role: 'beat-video-alternate', name: '白模 · S1', content: beat().localUrl!,
      refVideos: [beat().clipUrl], provider: 'storyai-director-studio', model: 'previs-blockout',
    })
    const clipNode = canvas.addItemNode(clip, 'video', { x: 400, y: 0 })
    canvas.addEdge(videoNode, previsNode)
    canvas.addEdge(previsNode, clipNode)
    useStoryboardStore.setState({ rows: [row({ beatVideoNodeId: videoNode })] })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ beats: [beat()] }) })))
    vi.mocked(runCapability).mockResolvedValue({ outputs: [{ kind: 'video', url: 'https://new/single.mp4' }] } as never)

    expect(blockoutClipOf(useCanvasItemStore.getState().items[clip])).toEqual({ shortId: 'cb323d4f', beat: 1 })
    await reshootOneBeatFromClip(clipNode)

    expect(runCapability).toHaveBeenCalledTimes(1)
    const all = Object.values(useCanvasItemStore.getState().items)
    // No second blockout node, one new result wired under the existing clip.
    expect(all.filter((i) => i.model === 'previs-blockout')).toHaveLength(1)
    const result = all.find((i) => i.content === 'https://new/single.mp4')!
    const resultNode = useCanvasStore.getState().nodes.find((n) => n.data.itemId === result.id)!.id
    expect(useCanvasStore.getState().edges.map((e) => `${e.source}->${e.target}`)).toContain(`${clipNode}->${resultNode}`)
    expect(useCanvasItemStore.getState().items[video].content).toBe('https://old/v1.mp4')
  })

  it('does nothing when the user cancels the confirmation', async () => {
    const items = useCanvasItemStore.getState()
    const canvas = useCanvasStore.getState()
    const video = items.addItem({ kind: 'video', role: 'beat-video', name: 'BV-S1', content: 'https://old/v1.mp4', prompt: 'p' })
    const videoNode = canvas.addItemNode(video, 'video', { x: 0, y: 0 })
    const previs = items.addItem({ kind: 'video', name: '3D预演', content: '/uploads/previs-cb323d4f.mp4', provider: 'storyai-director-studio' })
    const previsNode = canvas.addItemNode(previs, 'video', { x: 0, y: 0 })
    canvas.addEdge(videoNode, previsNode)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ beats: [beat({ shotId: video })] }) })))
    vi.stubGlobal('window', { confirm: vi.fn(() => false) })

    const nodesBefore = useCanvasStore.getState().nodes.length
    await reshootInputsWithBlockout(previsNode)
    expect(runCapability).not.toHaveBeenCalled()
    expect(useCanvasItemStore.getState().items[video].content).toBe('https://old/v1.mp4')
    expect(useCanvasStore.getState().nodes).toHaveLength(nodesBefore)
  })
})

describe('白模动作必须进 prompt（S8 实测回归）', () => {
  // 2026-09-19 实测事故：白模里鬼面客「踉跄后退」，出片却是所有人向镜头走近。
  // 原因是 prompt 只写了机位不写动作 —— Seedance 的 video-ref 只稳时间轴，画面
  // 内容只是倾向，灰模假人几乎每个像素都要重绘时模型会自己重新解读动作。
  it('把白模里的动作和 beat 目标写成文字（仅在显式开启时）', () => {
    const p = buildBlockoutPrompt({
      basePrompt: '',
      includeActionText: true,
      beat: {
        beat: 8, shotId: 'x', start: 0, duration: 10, clipUrl: 'http://s/beat08.mp4',
        goal: '水墨领域碎裂，竹屑如雪飘落；沈渊单膝跪地拄剑喘息，鬼面客踉跄后退',
        characters: [
          { key: 'a', name: '沈渊', color: '#4f8cff' },
          { key: 'b', name: '鬼面客', color: '#ff6b6b', motion: '失败者', motionWindow: [2, 6], actions: [] },
        ],
        segments: [{ t0: 0, t1: 10, shotSize: 'medium', cameraMotion: null, cameraPreset: null, subject: 'b' }],
      },
    })
    expect(p).toContain('踉跄后退')
    expect(p).toContain('红色假人（鬼面客）2-6s：失败者')
  })
})

describe('filterShotDescription', () => {
  const CHARS = [
    { name: '沈渊', motionWindow: null },
    { name: '鬼面客', motionWindow: [6, 9.2] as [number, number] },
  ]
  // 白模里鬼面客只在 0–4.5s 出镜，而他的动作发生在 6–9.2s —— 白模没拍到。
  const SCREEN = new Map<string, [number, number][]>([
    ['沈渊', [[0, 10]]],
    ['鬼面客', [[0, 4.5]]],
  ])

  it('删掉白模没拍到的那个人的动作描述', () => {
    const out = filterShotDescription(
      '水墨领域碎裂，竹屑如雪飘落；沈渊单膝跪地拄剑喘息；鬼面客踉跄后退、双钩护胸，转身走开。',
      CHARS, SCREEN,
    )
    expect(out).toContain('沈渊单膝跪地')
    expect(out).toContain('竹屑如雪飘落')   // 环境句不点名任何人，保留
    expect(out).not.toContain('鬼面客')
  })

  it('人物出镜时间和动作窗有重叠时，一个字都不删', () => {
    const screen = new Map<string, [number, number][]>([['鬼面客', [[5, 10]]]])
    const text = '鬼面客踉跄后退，转身走开。'
    expect(filterShotDescription(text, CHARS, screen)).toBe(text)
  })

  it('没有动作窗的人物不参与过滤 —— 缺数据时宁可不删', () => {
    const text = '沈渊单膝跪地拄剑喘息。'
    expect(filterShotDescription(text, CHARS, SCREEN)).toBe(text)
  })

  it('同一句里既有在场人物又有缺席人物时保留，不误删在场者的动作', () => {
    const out = filterShotDescription('沈渊跪地，鬼面客走开。', CHARS, SCREEN)
    expect(out).toContain('沈渊跪地')
  })
})
