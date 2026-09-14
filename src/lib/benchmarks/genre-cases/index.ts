import fight from './fight.json'
import kpopDance from './kpop-dance.json'
import mech from './mech.json'
import romance from './romance.json'

/**
 * 30 秒题材基准用例（S+ 漫剧能力面回归）。
 *
 * Fixture 只固定"输入"：剧本、风格、总时长、结果性预期。
 * 分几行、每行几秒、怎么分镜完全交给 director agent —— 这些用例存在的目的
 * 是反向驱动 agent/工具链开发，agent 排不好就改 agent，不把答案写死进测试。
 */
export interface GenreCaseCharacter {
  name: string
  brief: string
}

export interface GenreCaseArc {
  /** 起：谁、在哪、什么处境 */
  opening: string
  /** 承：冲突或情绪顶点 */
  development: string
  /** 合：明确结束感 */
  resolution: string
}

export interface GenreCase {
  id: string
  title: string
  genre: string
  totalDurationSeconds: number
  stylePreset: string
  aspectRatio: string
  characters: GenreCaseCharacter[]
  script: string
  arc: GenreCaseArc
  boundary?: string
  expect: {
    characterSlots: number
    propFocus?: string[]
    checklist?: string
    note?: string
    knownRisk?: string
    visualGrammar?: string
    dialogueDriven?: boolean
  }
}

export const GENRE_CASES: GenreCase[] = [fight, kpopDance, mech, romance]

export function getGenreCase(id: string): GenreCase | undefined {
  return GENRE_CASES.find((c) => c.id === id)
}

/**
 * 拼出喂给 director pipeline 的剧本文本：正文 + 角色设定 + 叙事弧线要求。
 * 角色 brief 和起承合作为剧本的一部分交给 script-agent/director-agent 消化，
 * 而不是绕过它们直接操纵分镜结构。
 */
export function buildGenreCaseScript(c: GenreCase): string {
  const parts: string[] = [c.script]
  if (c.characters.length > 0) {
    parts.push(
      '【角色设定】\n' + c.characters.map((ch) => `${ch.name}：${ch.brief}`).join('\n'),
    )
  }
  parts.push(
    '【叙事弧线要求】完整 30 秒必须覆盖起-承-合三段，具体行数与每行时长由导演决定：\n' +
      `起：${c.arc.opening}\n承：${c.arc.development}\n合：${c.arc.resolution}`,
  )
  if (c.boundary) parts.push(`【边界】${c.boundary}`)
  return parts.join('\n\n')
}
