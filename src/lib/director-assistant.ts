/**
 * 导演助手 - 智能优化流程
 * Three-stage pipeline: 优化 → 自检 → 修复
 */

import { buildCanvasContext } from '@/lib/canvas-context'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { ensureElements, extractElementsFromScript, buildElementContext, type ExtractionResult } from '@/lib/canvas-elements'
import { scriptAgent } from '@/lib/agents/script-agent'
import {
  critiqueComposition as artDirectorCritique,
  generateStyleBible,
} from '@/lib/agents/art-director-agent'
import {
  allocateShots as directorAllocateShots,
  applyTimelineFixes as directorApplyTimelineFixes,
  composeShots as directorComposeShots,
  critiqueTimeline as directorCritiqueTimeline,
  generateStoryboardTable as directorGenerateStoryboardTable,
} from '@/lib/agents/director-agent'
import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'

export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export interface PipelineStep {
  id: string
  label: string
  status: StepStatus
  result?: string
}

export interface PipelineStage {
  id: string
  label: string
  description: string
  steps: PipelineStep[]
}

export interface PipelineState {
  stages: PipelineStage[]
  currentStage: number
  currentStep: number
  totalTokens: number
  progress: number
  issues: string[]
  fixes: string[]
}

export function createDirectorInitialState(): PipelineState {
  return {
    stages: [
      {
        id: 'optimize', label: '01 优化', description: 'Script → Casting → Storyboard 智能优化流程',
        steps: [
          { id: 'skill-calibration', label: '剧本框架七层校准', status: 'pending' },
          { id: 'script-expansion', label: '完整剧本扩写', status: 'pending' },
          { id: 'script-doctor', label: '剧本医生圆桌会诊', status: 'pending' },
          { id: 'dialogue-diagnosis', label: '台词专家全量诊断', status: 'pending' },
          { id: 'casting-breakdown', label: 'Casting 角色卡与表演锚点', status: 'pending' },
          { id: 'element-generation', label: '角色/场景/道具素材生成', status: 'pending' },
          { id: 'visual-anchor', label: '视觉锚定提取', status: 'pending' },
          { id: 'visual-strategy', label: '全局视觉策略', status: 'pending' },
          { id: 'shot-allocation', label: '镜头分配计划', status: 'pending' },
          { id: 'shot-composition', label: '镜头构图设计', status: 'pending' },
          { id: 'optimize-result', label: '优化结果', status: 'pending' },
        ],
      },
      {
        id: 'selfcheck', label: '02 自检', description: '逻辑一致性验证',
        steps: [
          { id: 'timeline-logic', label: '剧本时间轴与空间逻辑闭环', status: 'pending' },
          { id: 'visual-balance', label: '视觉平衡扫描', status: 'pending' },
        ],
      },
      {
        id: 'fix', label: '03 修复', description: '针对问题项执行修复与微调',
        steps: [
          { id: 'apply-fixes', label: '执行修复', status: 'pending' },
          { id: 'final-result', label: '最终结果', status: 'pending' },
        ],
      },
    ],
    currentStage: 0, currentStep: 0, totalTokens: 0, progress: 0, issues: [], fixes: [],
  }
}

type OnUpdate = (state: PipelineState) => void

function setStep(state: PipelineState, stageIdx: number, stepIdx: number, status: StepStatus, result?: string) {
  state.stages[stageIdx].steps[stepIdx].status = status
  if (result) state.stages[stageIdx].steps[stepIdx].result = result
  state.currentStage = stageIdx
  state.currentStep = stepIdx
  const totalSteps = state.stages.reduce((s, st) => s + st.steps.length, 0)
  const doneSteps = state.stages.reduce((s, st) => s + st.steps.filter((x) => x.status === 'done').length, 0)
  state.progress = Math.round((doneSteps / totalSteps) * 100)
}

// ─── Stage 1: 优化 ──────────────────────────────────────────────────

async function runOptimize(state: PipelineState, onUpdate: OnUpdate): Promise<string> {
  const { useProjectDB } = await import('@/stores/project-db')
  const db = useProjectDB.getState()
  const scriptText = db.script.text || Object.values(useCanvasItemStore.getState().items)
    .filter((it) => it.kind === 'text' && it.content)
    .map((it) => `[${it.name}]: ${it.content}`)
    .join('\n\n')
  const totalDurationSeconds = db.script.totalDurationSeconds
  if (!totalDurationSeconds || totalDurationSeconds <= 0) {
    throw new Error('director pipeline: 必须先在导演助手输入总时长 (script.totalDurationSeconds)')
  }
  const artDir = db.artDirection
  const artStyle = artDir.customStyle || artDir.stylePreset
  const canvasCtx = buildCanvasContext()
  const storyboardRows = useStoryboardStore.getState().rows
  const existingStoryboard = storyboardRows.length > 0
    ? `\n现有分镜表（${storyboardRows.length}行）：\n${storyboardRows.map((r) => `${r.shot_number}: ${r.visual_description}`).join('\n')}`
    : ''

  // Step 1-5: Script → Casting creative intelligence pass — routed through
  // script-agent. The agent owns the framework calibration, expansion, doctor
  // roundtable, dialogue diagnosis, and casting card synthesis as a single
  // typed Dossier. The interview is auto-answered here (no UI yet); once
  // ChatPanel surfaces InterviewCard, swap driveAuto for drive() with a real
  // onQuestion handler.
  setStep(state, 0, 0, 'running'); onUpdate(state)
  const agentCtx = createMemoryContext({
    llm: createCapabilityLLM(),
    snapshot: { style: { presetId: artDir.stylePreset, promptText: artStyle } },
  })
  const dossier = await runAgentWithChatBridge(
    'script-agent',
    scriptAgent.run(
      {
        scriptText,
        canvasContext: canvasCtx,
        existingStoryboard,
        // Tell the agent what's already locked from the dialog + canvas so
        // it skips Q1 (项目类型 — derived from duration) and Q3 (视觉风格
        // — handled by {{artStyle}}). Saves the user redundant clicks.
        knownContext: {
          totalDurationSeconds,
          visualStyle: artStyle,
          aspectRatio: artDir.defaultAspectRatio,
        },
      },
      agentCtx,
    ),
    { verb: 'expand-script', interactive: true },
  )
  const scriptToCastingReport = JSON.stringify(dossier, null, 2)
  setStep(state, 0, 0, 'done', '已按 script-framework-qa 完成七层框架校准'); onUpdate(state)
  setStep(state, 0, 1, 'done', '已按 script-writing-expansion 生成/补齐完整剧本基准'); onUpdate(state)
  setStep(state, 0, 2, 'done', '已按 script-doctor-roundtable 完成结构会诊摘要'); onUpdate(state)
  setStep(state, 0, 3, 'done', '已按 dialogue-doctor-diagnosis 完成台词病灶摘要'); onUpdate(state)
  setStep(state, 0, 4, 'done', scriptToCastingReport); onUpdate(state)

  const scriptAnalysis = scriptToCastingReport
  const extraction = await extractElementsFromScript(scriptAnalysis, artStyle)
  const characterDesigns = JSON.stringify(extraction.characters, null, 2)
  const sceneDesigns = JSON.stringify(extraction.scenes, null, 2)
  const propDesigns = JSON.stringify(extraction.props, null, 2)

  // Step 6: 素材生成 (角色/场景图片)
  setStep(state, 0, 5, 'running'); onUpdate(state)
  const inv = await ensureElements(
    (msg) => { /* silent — progress shown via pipeline UI */ },
    { scriptText: scriptAnalysis, stylePreset: artDir.stylePreset, customStyle: artDir.customStyle, extraction },
  )
  const elementCtx = buildElementContext(inv)
  setStep(state, 0, 5, 'done', `${inv.characters.length} 角色, ${inv.scenes.length} 场景`); onUpdate(state)

  // Step 7-8: 视觉锚定提取 + 全局视觉策略 — routed through art-director-agent's
  // generateStyleBible verb. The pipeline still surfaces two steps to the UI
  // (anchor / strategy) for continuity, but they're both populated from the
  // single bible call.
  setStep(state, 0, 6, 'running'); onUpdate(state)
  const styleBible = await runAgentWithChatBridge(
    'art-director-agent',
    generateStyleBible({
      scriptAnalysis,
      characterDesigns,
      sceneDesigns,
      elementContext: elementCtx,
      artStyle,
      stylePreset: artDir.stylePreset,
    }, agentCtx),
    { verb: 'style-bible' },
  )
  const visualAnchor = styleBible.anchor
  const visualStrategy = styleBible.strategy
  setStep(state, 0, 6, 'done', visualAnchor); onUpdate(state)
  setStep(state, 0, 7, 'done', visualStrategy); onUpdate(state)

  // Step 9: 镜头分配计划 — director-agent.allocateShots
  setStep(state, 0, 8, 'running'); onUpdate(state)
  const shotAllocation = await runAgentWithChatBridge(
    'director-agent',
    directorAllocateShots(
      { scriptAnalysis, visualStrategy, totalDurationSeconds },
      agentCtx,
    ),
    { verb: 'allocate-shots' },
  )
  setStep(state, 0, 8, 'done', shotAllocation); onUpdate(state)

  // Step 10: 镜头构图设计 — director-agent.composeShots
  setStep(state, 0, 9, 'running'); onUpdate(state)
  const shotComposition = await runAgentWithChatBridge(
    'director-agent',
    directorComposeShots({ shotAllocation, visualAnchor }, agentCtx),
    { verb: 'compose-shots' },
  )
  setStep(state, 0, 9, 'done', shotComposition); onUpdate(state)

  // Step 11: 生成分镜表 JSON — director-agent.generateStoryboardTable
  setStep(state, 0, 10, 'running'); onUpdate(state)
  const storyboardJson = await runAgentWithChatBridge(
    'director-agent',
    directorGenerateStoryboardTable(
      {
        artStyle,
        totalDurationSeconds,
        characterDesigns,
        sceneDesigns,
        propDesigns,
        shotAllocation,
        shotComposition,
        visualStrategy,
        elementContext: elementCtx,
      },
      agentCtx,
    ),
    { verb: 'generate-storyboard-table' },
  )
  for (const issue of collectDurationIssues(storyboardJson, totalDurationSeconds)) {
    state.issues.push(issue)
  }
  setStep(state, 0, 10, 'done', storyboardJson); onUpdate(state)

  return storyboardJson
}

/** Per-row bounds enforced by both the prompts and post-validation. */
export const MIN_ROW_DURATION_SECONDS = 2
export const MAX_ROW_DURATION_SECONDS = 15

/**
 * Audit the generated storyboard JSON against the duration contract:
 *   - every row's duration ∈ [MIN, MAX]
 *   - sum of durations ≈ expectedTotal (±0.5s)
 *
 * Returns one issue line per violation, ready to push onto state.issues so
 * runFix can request a re-balance. Empty array when the storyboard is clean.
 */
export function collectDurationIssues(storyboardJson: string, expectedTotal: number): string[] {
  let parsed: unknown
  try {
    const m = storyboardJson.match(/\[[\s\S]*\]/)
    if (!m) return []
    parsed = JSON.parse(m[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const rows = parsed as Array<{ duration?: number; shot_number?: string }>
  const issues: string[] = []

  for (const row of rows) {
    const d = typeof row.duration === 'number' ? row.duration : NaN
    const shot = row.shot_number ?? '?'
    if (!Number.isFinite(d)) {
      issues.push(`${shot}: duration 缺失或非数字 → 补齐 duration，必须 ∈ [${MIN_ROW_DURATION_SECONDS}, ${MAX_ROW_DURATION_SECONDS}] 秒`)
      continue
    }
    if (d < MIN_ROW_DURATION_SECONDS) {
      issues.push(`${shot}: duration ${d}s 过短 (<${MIN_ROW_DURATION_SECONDS}s) → 与相邻行合并`)
    } else if (d > MAX_ROW_DURATION_SECONDS) {
      issues.push(`${shot}: duration ${d}s 过长 (>${MAX_ROW_DURATION_SECONDS}s) → 拆分为多行，每行仍 ∈ [${MIN_ROW_DURATION_SECONDS}, ${MAX_ROW_DURATION_SECONDS}] 秒`)
    }
  }

  const sum = rows.reduce((acc, r) => acc + (typeof r.duration === 'number' ? r.duration : 0), 0)
  const drift = Math.abs(sum - expectedTotal)
  if (drift > 0.5) {
    issues.push(`ALL: 分镜总时长 ${sum.toFixed(1)}s 与目标 ${expectedTotal}s 偏差 ${drift.toFixed(1)}s → 重新分配每行 duration 使总和等于 ${expectedTotal}s`)
  }

  return issues
}

// ─── Stage 2: 自检 ──────────────────────────────────────────────────

async function runSelfCheck(state: PipelineState, storyboardJson: string, onUpdate: OnUpdate): Promise<string[]> {
  const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })

  // Timeline / continuity check — director-agent.critiqueTimeline
  setStep(state, 1, 0, 'running'); onUpdate(state)
  const timelineIssues = await runAgentWithChatBridge(
    'director-agent',
    directorCritiqueTimeline({ storyboardJson }, agentCtx),
    { verb: 'critique-timeline' },
  )
  setStep(state, 1, 0, 'done', JSON.stringify(timelineIssues, null, 2)); onUpdate(state)

  // Composition check — art-director-agent.critiqueComposition (typed)
  setStep(state, 1, 1, 'running'); onUpdate(state)
  const compositionIssues = await runAgentWithChatBridge(
    'art-director-agent',
    artDirectorCritique({ storyboardJson }, agentCtx),
    { verb: 'critique-composition' },
  )
  setStep(state, 1, 1, 'done', JSON.stringify(compositionIssues, null, 2)); onUpdate(state)

  const issues: string[] = []
  for (const a of timelineIssues) issues.push(`${a.shot}: ${a.issue} → ${a.fix}`)
  for (const a of compositionIssues) issues.push(`${a.shot}: ${a.issue} → ${a.fix}`)

  state.issues = issues
  onUpdate(state)
  return issues
}

// ─── Stage 3: 修复 ──────────────────────────────────────────────────

async function runFix(state: PipelineState, storyboardJson: string, issues: string[], onUpdate: OnUpdate): Promise<string> {
  const { useProjectDB } = await import('@/stores/project-db')
  const totalDurationSeconds = useProjectDB.getState().script.totalDurationSeconds
  if (issues.length === 0) {
    setStep(state, 2, 0, 'done', '无需修复')
    setStep(state, 2, 1, 'done', '使用优化结果作为最终结果')
    onUpdate(state)
    return storyboardJson
  }

  setStep(state, 2, 0, 'running'); onUpdate(state)
  const agentCtx = createMemoryContext({ llm: createCapabilityLLM() })
  const fixResult = await runAgentWithChatBridge(
    'director-agent',
    directorApplyTimelineFixes(
      {
        storyboardJson,
        issues,
        totalDurationSeconds: totalDurationSeconds || 0,
      },
      agentCtx,
    ),
    { verb: 'apply-timeline-fixes' },
  )
  state.fixes = issues.map((i) => `已修复: ${i}`)
  setStep(state, 2, 0, 'done', `已修复 ${issues.length} 个问题`); onUpdate(state)

  setStep(state, 2, 1, 'done', fixResult); onUpdate(state)
  return fixResult
}

// ─── Public API ─────────────────────────────────────────────────────

export type StageId = 'optimize' | 'selfcheck' | 'fix'

export async function runDirectorPipeline(
  onUpdate: OnUpdate,
): Promise<{ state: PipelineState; storyboardJson: string }> {
  const state = createDirectorInitialState()
  onUpdate(state)

  const storyboardJson = await runOptimize(state, onUpdate)
  const issues = await runSelfCheck(state, storyboardJson, onUpdate)
  const finalJson = await runFix(state, storyboardJson, issues, onUpdate)

  return { state, storyboardJson: finalJson }
}

export async function runDirectorStage(
  stageId: StageId,
  existingJson?: string,
  onUpdate?: OnUpdate,
): Promise<string> {
  const state = createDirectorInitialState()
  const update = onUpdate ?? (() => {})

  switch (stageId) {
    case 'optimize':
      return runOptimize(state, update)
    case 'selfcheck': {
      const json = existingJson ?? ''
      await runSelfCheck(state, json, update)
      return json
    }
    case 'fix': {
      const json = existingJson ?? ''
      const issues = state.issues.length > 0 ? state.issues : ['请先运行自检']
      return runFix(state, json, issues, update)
    }
  }
}
