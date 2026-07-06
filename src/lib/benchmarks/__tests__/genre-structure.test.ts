import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useProjectDB } from '@/stores/project-db'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { runCapability } from '@/lib/capabilities/client'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { mergeSameSceneRows } from '@/lib/storyboard-merge'
import { StoryboardRowSchema, type StoryboardRowInput } from '@/types/storyboard'
import { GENRE_CASES, getGenreCase, buildGenreCaseScript, type GenreCase } from '../genre-cases'
import { validateGenreStructure } from '../structure-gates'

vi.mock('@/lib/capabilities/client', () => ({
  runCapability: vi.fn(),
}))

const mockedRunCapability = vi.mocked(runCapability)

function resetDB() {
  useProjectDB.getState().clearAll()
  useCanvasStore.getState().clearAll()
  useCanvasItemStore.setState({ items: {} })
}

function row(partial: Partial<StoryboardRowInput> & { shot_number: string; duration: number }): StoryboardRowInput {
  return StoryboardRowSchema.parse(partial)
}

/**
 * 每个题材一份"agent 产出得像样时"的分镜表桩。这不是期望答案 ——
 * 行数/秒数只要过结果性门槛即可；桩的作用是让管线接线 + 门槛校验
 * 在无网络环境下可回归。
 */
const MOCK_STORYBOARDS: Record<string, StoryboardRowInput[]> = {
  fight: [
    row({
      shot_number: 'S1', duration: 10,
      visual_description: '暴雪断桥全景建立，沈玦拦住墨渊，剑指对峙',
      transition_note: '开场：大远景建立地理关系，风雪声先入',
      character1: { image: '', description: '沈玦', nodeId: '' },
      character2: { image: '', description: '墨渊', nodeId: '' },
      prop1: { image: '', description: '心灯', nodeId: '' },
      scene: { image: '', description: '暴雪悬空断桥', nodeId: '' },
    }),
    row({
      shot_number: 'S2', duration: 11,
      visual_description: '锁链缠剑压制沈玦至桥沿，旧伤崩裂后以伤换势斩断锁链逆转',
      transition_note: '同场景承接：沿上一行剑指的轴线切入近身交锋',
      character1: { image: '', description: '沈玦', nodeId: '' },
      character2: { image: '', description: '墨渊', nodeId: '' },
      scene: { image: '', description: '暴雪悬空断桥', nodeId: '' },
    }),
    row({
      shot_number: 'S3', duration: 9,
      visual_description: '剑尖停在咽喉，风雪骤停，沈玦接住心灯离去，断桥崩塌',
      transition_note: '同场景承接：高潮打击定格后接收束，结尾留白 1s',
      character1: { image: '', description: '沈玦', nodeId: '' },
      character2: { image: '', description: '墨渊', nodeId: '' },
      prop1: { image: '', description: '心灯', nodeId: '' },
      scene: { image: '', description: '暴雪悬空断桥', nodeId: '' },
    }),
  ],
  'kpop-dance': [
    row({
      shot_number: 'S1', duration: 15,
      visual_description: '顶光下箭形剪影亮相，齐转身，贴身跟拍推进进入主歌队形流动',
      transition_note: '开场：黑场起顶光，剪影到亮相的节奏卡电子乐前奏',
      character1: { image: '', description: 'NEON5 女团（五人，银紫色演出服，C 位 Rin）', nodeId: '' },
      scene: { image: '', description: '全黑环形舞台', nodeId: '' },
    }),
    row({
      shot_number: 'S2', duration: 15,
      visual_description: 'drop 灯光爆亮爆发齐舞，环绕运镜扫过队形，收势定格回箭形剪影熄灯',
      transition_note: '同场景承接：中心交换动作末拍直接接 drop 爆亮',
      character1: { image: '', description: 'NEON5 女团（五人，银紫色演出服，C 位 Rin）', nodeId: '' },
      scene: { image: '', description: '全黑环形舞台', nodeId: '' },
    }),
  ],
  mech: [
    row({
      shot_number: 'S1', duration: 9,
      visual_description: '机库探照灯逐一亮起，勾勒玄武-07 十米机甲的静置轮廓',
      transition_note: '开场：黑暗中灯光节奏引导视线建立体量',
      prop1: { image: '', description: '玄武-07 人形机甲', nodeId: '' },
      scene: { image: '', description: '幽暗机库维护台架', nodeId: '' },
    }),
    row({
      shot_number: 'S2', duration: 12,
      visual_description: '爆炸图式解构：装甲板沿轴线弹开悬浮，骨架层层分离露出旋转的聚变核心',
      transition_note: '同场景承接：检修程序启动音效触发解构，镜头沿轴线推进',
      prop1: { image: '', description: '玄武-07 人形机甲', nodeId: '' },
      prop2: { image: '', description: '聚变动力核心', nodeId: '' },
      scene: { image: '', description: '幽暗机库维护台架', nodeId: '' },
    }),
    row({
      shot_number: 'S3', duration: 9,
      visual_description: '部件按原路径回位咬合，装甲闭合瞬间双目亮起蓝光，启动轰鸣',
      transition_note: '同场景承接：核心特写拉出接部件回位，结尾轰鸣收束',
      prop1: { image: '', description: '玄武-07 人形机甲', nodeId: '' },
      scene: { image: '', description: '幽暗机库维护台架', nodeId: '' },
    }),
  ],
  romance: [
    row({
      shot_number: 'S1', duration: 9,
      visual_description: '床头灯暖光，程亦看书，沈以晴抱枕背对而坐，沉默的距离感',
      transition_note: '开场：暖光低照度定调，环境声只有翻书声',
      character1: { image: '', description: '程亦', nodeId: '' },
      character2: { image: '', description: '沈以晴', nodeId: '' },
      scene: { image: '', description: '凌晨两点的卧室', nodeId: '' },
      dialogue: '沈以晴：如果我说……我想接那个上海的工作呢？',
    }),
    row({
      shot_number: 'S2', duration: 12,
      visual_description: '试探与沉默的张力，程亦合上书轻笑，把她连人带枕头揽过来',
      transition_note: '同场景承接：沿开口的视线切入双人正反打',
      character1: { image: '', description: '程亦', nodeId: '' },
      character2: { image: '', description: '沈以晴', nodeId: '' },
      scene: { image: '', description: '凌晨两点的卧室', nodeId: '' },
      dialogue: '程亦：那我把工作室也搬过去，反正图纸在哪儿都能画。',
    }),
    row({
      shot_number: 'S3', duration: 9,
      visual_description: '她愣住转头眼眶发热埋进肩窝，灯下依偎剪影，两手轻轻扣在一起',
      transition_note: '同场景承接：揽过来的动作末端接依偎，结尾定格剪影',
      character1: { image: '', description: '程亦', nodeId: '' },
      character2: { image: '', description: '沈以晴', nodeId: '' },
      scene: { image: '', description: '凌晨两点的卧室', nodeId: '' },
    }),
  ],
}

function mockPipeline(genreCase: GenreCase, storyboardRows: StoryboardRowInput[]) {
  const fullScript = buildGenreCaseScript(genreCase)
  const storyboardJson = JSON.stringify(storyboardRows)
  const storyboardPrompts: string[] = []

  mockedRunCapability.mockImplementation(async (request) => {
    const prompt = request.inputs[0]?.text ?? ''
    if (prompt.includes('script-agent / expand-script')) {
      return { outputs: [{ kind: 'text' as const, text: JSON.stringify({
        framework_calibration: { main_risk: '' },
        expanded_script_baseline: { script_text: fullScript, beat_summary: [] },
        doctor_roundtable_summary: { must_fix: [], keep: [] },
        post_doctor_revised_script: { script_text: fullScript },
        dialogue_diagnosis_summary: { rewrite_notes: [] },
        casting_cards: [],
        scene_cards: [],
        prop_cards: [],
        storyboard_directives: [],
      }) }] }
    }
    if (prompt.includes('director-agent / generate-storyboard-table')) {
      storyboardPrompts.push(prompt)
      return { outputs: [{ kind: 'text' as const, text: storyboardJson }] }
    }
    if (prompt.includes('art-director-agent / extract-characters')) return { outputs: [{ kind: 'text' as const, text: '[]' }] }
    if (prompt.includes('art-director-agent / extract-scenes')) return { outputs: [{ kind: 'text' as const, text: '[]' }] }
    if (prompt.includes('art-director-agent / extract-props')) return { outputs: [{ kind: 'text' as const, text: '[]' }] }
    return { outputs: [{ kind: 'text' as const, text: 'ok' }] }
  })

  return { storyboardPrompts }
}

describe('Genre benchmark fixtures', () => {
  it('exposes exactly the 4 approved cases with unified Weta 3D CG style', () => {
    expect(GENRE_CASES.map((c) => c.id)).toEqual(['fight', 'kpop-dance', 'mech', 'romance'])
    for (const c of GENRE_CASES) {
      expect(c.stylePreset).toBe('3d_weta_performance_capture_epic')
      expect(c.totalDurationSeconds).toBe(30)
      expect(c.arc.opening).toBeTruthy()
      expect(c.arc.development).toBeTruthy()
      expect(c.arc.resolution).toBeTruthy()
      expect(c.script.length).toBeGreaterThan(50)
    }
  })

  it('buildGenreCaseScript threads script, characters, and arc into pipeline input', () => {
    const fight = getGenreCase('fight')!
    const text = buildGenreCaseScript(fight)
    expect(text).toContain(fight.script)
    expect(text).toContain('【角色设定】')
    expect(text).toContain('沈玦')
    expect(text).toContain('【叙事弧线要求】')
    expect(text).toContain(fight.arc.resolution)
    // mech 没有具名角色 → 不注入空的角色设定段
    const mech = getGenreCase('mech')!
    expect(buildGenreCaseScript(mech)).not.toContain('【角色设定】')
    // romance 带边界约束
    const romance = getGenreCase('romance')!
    expect(buildGenreCaseScript(romance)).toContain('【边界】')
  })
})

describe('Structure gates', () => {
  const fight = () => getGenreCase('fight')!

  it('passes a well-formed storyboard', () => {
    const result = validateGenreStructure(MOCK_STORYBOARDS.fight, fight())
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects rows outside the Seedance duration envelope', () => {
    const rows = MOCK_STORYBOARDS.fight.map((r, i) => (i === 0 ? { ...r, duration: 1 } : r))
    const result = validateGenreStructure(rows, fight())
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toContain('Seedance 单行边界')
  })

  it('rejects total duration drifting past tolerance', () => {
    const rows = MOCK_STORYBOARDS.fight.map((r) => ({ ...r, duration: 15 }))
    const result = validateGenreStructure(rows, fight())
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toContain('偏离目标 30s')
  })

  it('rejects missing transition notes', () => {
    const rows = MOCK_STORYBOARDS.fight.map((r, i) => (i === 1 ? { ...r, transition_note: '' } : r))
    const result = validateGenreStructure(rows, fight())
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toContain('transition_note 为空')
  })

  it('rejects homogeneous rows (same visual repeated = no narrative progression)', () => {
    const dup = MOCK_STORYBOARDS.fight[0]
    const rows = MOCK_STORYBOARDS.fight.map((r) => ({ ...r, visual_description: dup.visual_description }))
    const result = validateGenreStructure(rows, fight())
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toContain('同质化')
  })

  it('rejects character-slot count that deviates from the case expectation', () => {
    const rows = MOCK_STORYBOARDS.fight.map((r) => ({
      ...r,
      character2: { image: '', description: '', nodeId: '' },
    }))
    const result = validateGenreStructure(rows, fight())
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toContain('不等于用例预期 2')
  })

  it('requires prop usage for prop-focused cases (mech)', () => {
    const mech = getGenreCase('mech')!
    const rows = MOCK_STORYBOARDS.mech.map((r) => ({
      ...r,
      prop1: { image: '', description: '', nodeId: '' },
      prop2: { image: '', description: '', nodeId: '' },
    }))
    const result = validateGenreStructure(rows, mech)
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toContain('prop 槽位')
  })
})

describe('Tier 1 — director pipeline regression per genre case', () => {
  beforeEach(() => {
    resetDB()
    mockedRunCapability.mockReset()
  })

  for (const genreCase of GENRE_CASES) {
    it(`${genreCase.id}（${genreCase.title}）: fixture → pipeline → rows pass structure gates`, async () => {
      const { runDirectorStage } = await import('@/lib/director-assistant')

      useProjectDB.getState().updateScript({
        text: buildGenreCaseScript(genreCase),
        totalDurationSeconds: genreCase.totalDurationSeconds,
      })
      useProjectDB.getState().updateArtDirection({ stylePreset: genreCase.stylePreset })

      const { storyboardPrompts } = mockPipeline(genreCase, MOCK_STORYBOARDS[genreCase.id])

      const storyboardJson = await runDirectorStage('optimize')

      // 输入线程化：fixture 剧本与弧线要求必须真实到达分镜生成提示词。
      expect(storyboardPrompts.length).toBeGreaterThan(0)
      expect(storyboardPrompts[0]).toContain(genreCase.script.slice(0, 20))
      expect(storyboardPrompts[0]).toContain('【叙事弧线要求】')

      // 输出经解析 + 同场景合并后必须过全部结果性门槛。
      const parsed = parseAndValidateStoryboard(storyboardJson)
      expect(parsed.ok, (parsed.errors ?? []).join('; ')).toBe(true)
      const merged = mergeSameSceneRows(parsed.rows!)
      const gate = validateGenreStructure(merged.rows, genreCase)
      expect(gate.issues).toEqual([])
      expect(gate.ok).toBe(true)
    })
  }
})
