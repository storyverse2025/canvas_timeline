import type { StoryboardRowInput } from '@/types/storyboard'
import type { GenreCase } from './genre-cases'

/**
 * 结果性结构门槛 —— 只检查"结果对不对"，不检查"怎么分的"。
 *
 * 行数、每行秒数、分镜方式都是 director agent 的自由度；这里只把
 * 物理约束（Seedance 单行时长）、契约约束（总时长、衔接、槽位预期）
 * 和"三段弧线不同质"固化为可断言的门槛。门槛不过 → 改进 agent，
 * 而不是把期望的分镜答案写死进测试。
 */

/** Seedance 单次生成的物理时长边界（见 cinematographer-agent MIN/MAX_DURATION）。 */
export const ROW_DURATION_MIN = 5
export const ROW_DURATION_MAX = 15
/** 总时长允许的偏差。 */
export const TOTAL_DURATION_TOLERANCE = 3

export interface StructureGateResult {
  ok: boolean
  issues: string[]
}

function distinctCharacterNames(rows: StoryboardRowInput[]): Set<string> {
  const names = new Set<string>()
  for (const row of rows) {
    for (const slot of [row.character1, row.character2]) {
      const desc = slot?.description?.trim()
      if (desc) names.add(desc)
    }
  }
  return names
}

export function validateGenreStructure(
  rows: StoryboardRowInput[],
  genreCase: GenreCase,
): StructureGateResult {
  const issues: string[] = []

  if (rows.length === 0) {
    return { ok: false, issues: ['分镜表为空'] }
  }

  // 每行时长在 Seedance 物理边界内 —— 行数不设预期。
  rows.forEach((row, i) => {
    if (row.duration < ROW_DURATION_MIN || row.duration > ROW_DURATION_MAX) {
      issues.push(
        `第 ${i + 1} 行（${row.shot_number}）时长 ${row.duration}s 超出 Seedance 单行边界 [${ROW_DURATION_MIN}, ${ROW_DURATION_MAX}]`,
      )
    }
  })

  // 总时长贴合 fixture 约定。
  const total = rows.reduce((sum, row) => sum + row.duration, 0)
  const target = genreCase.totalDurationSeconds
  if (Math.abs(total - target) > TOTAL_DURATION_TOLERANCE) {
    issues.push(`总时长 ${total}s 偏离目标 ${target}s 超过 ±${TOTAL_DURATION_TOLERANCE}s`)
  }

  // 前后衔接：每行都要有衔接设计（首行为开场设计，后续行为承接描述）。
  rows.forEach((row, i) => {
    if (!row.transition_note?.trim()) {
      issues.push(`第 ${i + 1} 行（${row.shot_number}）transition_note 为空，缺少前后衔接设计`)
    }
  })

  // 起-承-合不同质：各行画面描述必须互不相同（平铺同一画面 = 没有叙事推进）。
  const seenVisuals = new Map<string, number>()
  rows.forEach((row, i) => {
    const key = row.visual_description.trim()
    if (!key) {
      issues.push(`第 ${i + 1} 行（${row.shot_number}）visual_description 为空`)
      return
    }
    const prev = seenVisuals.get(key)
    if (prev !== undefined) {
      issues.push(`第 ${prev + 1} 行与第 ${i + 1} 行 visual_description 完全相同，叙事同质化`)
    } else {
      seenVisuals.set(key, i)
    }
  })

  // 角色槽位符合用例预期（fight/romance=2、kpop=1 个群体锚点、mech=0）。
  const characters = distinctCharacterNames(rows)
  if (characters.size !== genreCase.expect.characterSlots) {
    issues.push(
      `具名角色数 ${characters.size}（${[...characters].join('、') || '无'}）不等于用例预期 ${genreCase.expect.characterSlots}`,
    )
  }

  // 道具主导的用例至少要有一行用到道具槽位。
  if (genreCase.expect.propFocus && genreCase.expect.propFocus.length > 0) {
    const hasProp = rows.some(
      (row) => row.prop1?.description?.trim() || row.prop2?.description?.trim(),
    )
    if (!hasProp) {
      issues.push(`用例以道具为核心（${genreCase.expect.propFocus.join('、')}），但没有任何行填充 prop 槽位`)
    }
  }

  return { ok: issues.length === 0, issues }
}
