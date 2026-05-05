import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectIntent, executeIntent } from '../chat-intent'
import { api } from '../api-client'
import { useChatStore } from '@/stores/chat-store'
import { useProjectStore } from '@/stores/project-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB } from '@/stores/project-db'

const USER_SCRIPT_PROMPT = `Generate script: 像素进化风 ——【角色觉醒】（主打成长感与社区共鸣）
0-3秒：画面是一个极其简陋的像素小人，正面对着一扇关着的门，门缝里塞进来一张极具质感的【入学邀请卡】。
3-8秒：像素小人捡起卡片，瞬间“升级”！从像素风 -> 2D扁平风 -> 3D高精度人物（类似游戏角色选界面）。他推开门，门后是无数个同样风格各异的3D高精角色，正在互相交流、碰撞灵感。
8-12秒：镜头聚焦到主角手中那张发光的邀请卡，卡面上的文字像代码一样滚动，最终定格为“AIGC”。
12-15秒：主角与周围的人相视一笑，一起看向镜头。字幕+配音：“告别初始设定，开启无限进化。AIGC社区欢迎你！”`

const SINGLE_LINE_USER_SCRIPT_PROMPT = 'Generate script: 像素进化风 ——【角色觉醒】（主打成长感与社区共鸣） 0-3秒：画面是一个极其简陋的像素小人，正面对着一扇关着的门，门缝里塞进来一张极具质感的【入学邀请卡】。 3-8秒：像素小人捡起卡片，瞬间“升级”！从像素风 -> 2D扁平风 -> 3D高精度人物（类似游戏角色选界面）。他推开门，门后是无数个同样风格各异的3D高精角色，正在互相交流、碰撞灵感。 8-12秒：镜头聚焦到主角手中那张发光的邀请卡，卡面上的文字像代码一样滚动，最终定格为“AIGC”。 12-15秒：主角与周围的人相视一笑，一起看向镜头。字幕+配音：“告别初始设定，开启无限进化。AIGC社区欢迎你！”'

function resetStores() {
  useChatStore.setState({
    messages: [],
    isLoading: false,
    activeSkill: null,
    skillProgress: null,
  })
  useProjectStore.setState({
    episodeIndex: 0,
    episodes: [],
    characters: [],
    scenes: [],
    props: [],
    keyframes: [],
    shots: [],
  })
  useTimelineStore.setState({
    shots: [],
    tracks: [],
    playheadTime: 0,
    duration: 120,
    zoom: 1,
    isPlaying: false,
    snapEnabled: true,
    snapInterval: 1,
  })
  useCanvasStore.getState().clearAll()
  useProjectDB.getState().clearAll()
}

describe('Generate Script intent', () => {
  beforeEach(() => {
    resetStores()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes the user script prompt to the script generator instead of a hardcoded generic prompt', async () => {
    const generateSpy = vi.spyOn(api.scripts, 'generate').mockResolvedValue({
      episodes: [
        {
          episode_number: 1,
          title: '角色觉醒',
          content: '像素小人收到入学邀请卡并完成视觉进化。',
          beats: [
            {
              number: 1,
              duration_seconds: 3,
              narration: '像素小人面对门缝里的入学邀请卡。',
              action: '门缝递入邀请卡。',
              dialogues: [],
            },
          ],
        },
      ],
    })

    const intent = detectIntent(USER_SCRIPT_PROMPT)
    expect(intent?.skill).toBe('generateScript')

    await executeIntent(intent!, 'test-project', USER_SCRIPT_PROMPT)

    expect(generateSpy).toHaveBeenCalledWith(
      'test-project',
      expect.objectContaining({ inspiration: USER_SCRIPT_PROMPT })
    )
  })

  it('creates a visible local draft from the user prompt when the backend script API is unavailable', async () => {
    vi.spyOn(api.scripts, 'generate').mockRejectedValue(new Error('backend offline'))

    const intent = detectIntent(USER_SCRIPT_PROMPT)
    await executeIntent(intent!, 'test-project', USER_SCRIPT_PROMPT)

    const episodes = useProjectStore.getState().episodes
    expect(useProjectStore.getState().episodeIndex).toBe(0)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].title).toContain('角色觉醒')
    expect(episodes[0].content).toContain('像素进化风')
    expect(episodes[0].beats).toHaveLength(4)
    expect(episodes[0].beats[0].narration).toContain('入学邀请卡')
    expect(episodes[0].beats[1].action).toContain('像素风')
    expect(episodes[0].beats[2].narration).toContain('AIGC')

    const keyframeTrack = useTimelineStore.getState().tracks.find((track) => track.type === 'keyframe')
    expect(keyframeTrack?.items.map((item) => item.label)).toEqual([
      '0-3秒 入学邀请卡',
      '3-8秒 角色升级开门',
      '8-12秒 AIGC邀请卡特写',
      '12-15秒 社区欢迎钩子',
    ])

    const canvasNodes = useCanvasStore.getState().nodes
    expect(canvasNodes).toHaveLength(4)
    expect(canvasNodes.map((node) => node.type)).toEqual(['text', 'text', 'text', 'text'])
    expect(canvasNodes.map((node) => node.data.itemId)).toEqual(keyframeTrack?.items.map((item) => item.id))

    const projectScript = useProjectDB.getState().script
    expect(projectScript.text).toContain(USER_SCRIPT_PROMPT)
    expect(projectScript.optimizedText).toContain('角色觉醒')
    expect(projectScript.updatedAt).toBeGreaterThan(0)

    const actionMessage = useChatStore.getState().messages.find((message) => message.action?.type === 'generate_script')
    expect(actionMessage?.content).toContain('基于用户输入')
    expect(actionMessage?.content).not.toContain('demo mode')
    expect(actionMessage?.action?.status).toBe('success')
  })

  it('splits a single-line timed script prompt into separate editable beats', async () => {
    vi.spyOn(api.scripts, 'generate').mockRejectedValue(new Error('backend offline'))

    const intent = detectIntent(SINGLE_LINE_USER_SCRIPT_PROMPT)
    expect(intent?.skill).toBe('generateScript')

    await executeIntent(intent!, 'test-project', SINGLE_LINE_USER_SCRIPT_PROMPT)

    const episodes = useProjectStore.getState().episodes
    expect(episodes).toHaveLength(1)
    expect(episodes[0].beats).toHaveLength(4)

    const keyframeTrack = useTimelineStore.getState().tracks.find((track) => track.type === 'keyframe')
    expect(keyframeTrack?.items).toHaveLength(4)
    expect(keyframeTrack?.items.map((item) => item.label)).toEqual([
      '0-3秒 入学邀请卡',
      '3-8秒 角色升级开门',
      '8-12秒 AIGC邀请卡特写',
      '12-15秒 社区欢迎钩子',
    ])

    const canvasNodes = useCanvasStore.getState().nodes
    expect(canvasNodes).toHaveLength(4)

    const actionMessage = useChatStore.getState().messages.find((message) => message.action?.type === 'generate_script')
    expect(actionMessage?.content).toContain('4 个可编辑时间线节拍')
  })
})
