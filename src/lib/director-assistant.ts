/**
 * 导演助手 - 智能优化流程
 * Three-stage pipeline: 优化 → 自检 → 修复
 */

import { runCapability } from '@/lib/capabilities/client'
import { buildCanvasContext } from '@/lib/canvas-context'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { ensureElements, extractElementsFromScript, buildElementContext, type ExtractionResult } from '@/lib/canvas-elements'
import { fillPrompt } from '@/lib/prompts'

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

function createInitialState(): PipelineState {
  return {
    stages: [
      {
        id: 'optimize', label: '01 优化', description: '结构化拆解与镜头设计生成',
        steps: [
          { id: 'script-analysis', label: '剧本结构化分析', status: 'pending' },
          { id: 'char-extraction', label: '角色提取与丰富', status: 'pending' },
          { id: 'scene-extraction', label: '场景提取与丰富', status: 'pending' },
          { id: 'element-generation', label: '素材生成', status: 'pending' },
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

async function aiCall(prompt: string): Promise<string> {
  const r = await runCapability({
    capability: 'element-extraction',
    inputs: [{ kind: 'text', text: prompt }],
  })
  return r.outputs[0]?.text ?? ''
}

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
  const artDir = db.artDirection
  const artStyle = artDir.customStyle || artDir.stylePreset
  const canvasCtx = buildCanvasContext()
  const storyboardRows = useStoryboardStore.getState().rows
  const existingStoryboard = storyboardRows.length > 0
    ? `\n现有分镜表（${storyboardRows.length}行）：\n${storyboardRows.map((r) => `${r.shot_number}: ${r.visual_description}`).join('\n')}`
    : ''

  // Step 1: 剧本结构化分析
  setStep(state, 0, 0, 'running'); onUpdate(state)
  const scriptAnalysis = await aiCall(fillPrompt('scriptAnalysis', {
    scriptText, canvasContext: canvasCtx, existingStoryboard,
  }))
  setStep(state, 0, 0, 'done', scriptAnalysis); onUpdate(state)

  // Step 2: 角色提取与丰富
  setStep(state, 0, 1, 'running'); onUpdate(state)
  const extraction = await extractElementsFromScript(scriptAnalysis, artStyle)
  const characterDesigns = JSON.stringify(extraction.characters, null, 2)
  setStep(state, 0, 1, 'done', `提取 ${extraction.characters.length} 个角色`); onUpdate(state)

  // Step 3: 场景提取与丰富
  setStep(state, 0, 2, 'running'); onUpdate(state)
  const sceneDesigns = JSON.stringify(extraction.scenes, null, 2)
  const propDesigns = JSON.stringify(extraction.props, null, 2)
  setStep(state, 0, 2, 'done', `提取 ${extraction.scenes.length} 场景, ${extraction.props.length} 道具`); onUpdate(state)

  // Step 4: 素材生成 (角色/场景图片)
  setStep(state, 0, 3, 'running'); onUpdate(state)
  const inv = await ensureElements(
    (msg) => { /* silent — progress shown via pipeline UI */ },
    { scriptText, stylePreset: artDir.stylePreset, customStyle: artDir.customStyle, extraction },
  )
  const elementCtx = buildElementContext(inv)
  setStep(state, 0, 3, 'done', `${inv.characters.length} 角色, ${inv.scenes.length} 场景`); onUpdate(state)

  // Step 5: 视觉锚定提取
  setStep(state, 0, 4, 'running'); onUpdate(state)
  const visualAnchor = await aiCall(fillPrompt('visualAnchor', {
    scriptAnalysis, characterDesigns, sceneDesigns, elementContext: elementCtx,
  }))
  setStep(state, 0, 4, 'done', visualAnchor); onUpdate(state)

  // Step 6: 全局视觉策略
  setStep(state, 0, 5, 'running'); onUpdate(state)
  const visualStrategy = await aiCall(fillPrompt('visualStrategy', {
    artStyle, stylePreset: artDir.stylePreset,
    scriptAnalysis: scriptAnalysis.slice(0, 500),
    visualAnchor: visualAnchor.slice(0, 500),
  }))
  setStep(state, 0, 5, 'done', visualStrategy); onUpdate(state)

  // Step 7: 镜头分配计划
  setStep(state, 0, 6, 'running'); onUpdate(state)
  const shotAllocation = await aiCall(fillPrompt('shotAllocation', {
    scriptAnalysis: scriptAnalysis.slice(0, 500),
    visualStrategy: visualStrategy.slice(0, 500),
  }))
  setStep(state, 0, 6, 'done', shotAllocation); onUpdate(state)

  // Step 8: 镜头构图设计
  setStep(state, 0, 7, 'running'); onUpdate(state)
  const shotComposition = await aiCall(fillPrompt('shotComposition', {
    shotAllocation: shotAllocation.slice(0, 800),
    visualAnchor: visualAnchor.slice(0, 500),
  }))
  setStep(state, 0, 7, 'done', shotComposition); onUpdate(state)

  // Step 9: 生成分镜表 JSON
  setStep(state, 0, 8, 'running'); onUpdate(state)
  const storyboardJson = await aiCall(fillPrompt('storyboardGeneration', {
    artStyle,
    characterDesigns: characterDesigns.slice(0, 800),
    sceneDesigns: sceneDesigns.slice(0, 800),
    propDesigns: propDesigns.slice(0, 400),
    shotAllocation: shotAllocation.slice(0, 600),
    shotComposition: shotComposition.slice(0, 600),
    visualStrategy: visualStrategy.slice(0, 400),
    elementContext: elementCtx,
  }))
  setStep(state, 0, 8, 'done', storyboardJson); onUpdate(state)

  return storyboardJson
}

// ─── Stage 2: 自检 ──────────────────────────────────────────────────

async function runSelfCheck(state: PipelineState, storyboardJson: string, onUpdate: OnUpdate): Promise<string[]> {
  setStep(state, 1, 0, 'running'); onUpdate(state)
  const timelineCheck = await aiCall(fillPrompt('timelineCheck', { storyboardJson: storyboardJson.slice(0, 3000) }))
  setStep(state, 1, 0, 'done', timelineCheck); onUpdate(state)

  setStep(state, 1, 1, 'running'); onUpdate(state)
  const visualCheck = await aiCall(fillPrompt('visualBalanceCheck', { storyboardJson: storyboardJson.slice(0, 3000) }))
  setStep(state, 1, 1, 'done', visualCheck); onUpdate(state)

  const issues: string[] = []
  for (const checkResult of [timelineCheck, visualCheck]) {
    try {
      const m = checkResult.match(/\[[\s\S]*\]/)
      if (m) {
        const arr = JSON.parse(m[0]) as { shot: string; issue: string; fix: string }[]
        for (const a of arr) issues.push(`${a.shot}: ${a.issue} → ${a.fix}`)
      }
    } catch { /* no valid JSON */ }
  }
  state.issues = issues
  onUpdate(state)
  return issues
}

// ─── Stage 3: 修复 ──────────────────────────────────────────────────

async function runFix(state: PipelineState, storyboardJson: string, issues: string[], onUpdate: OnUpdate): Promise<string> {
  if (issues.length === 0) {
    setStep(state, 2, 0, 'done', '无需修复')
    setStep(state, 2, 1, 'done', '使用优化结果作为最终结果')
    onUpdate(state)
    return storyboardJson
  }

  setStep(state, 2, 0, 'running'); onUpdate(state)
  const fixResult = await aiCall(fillPrompt('applyFixes', {
    issuesList: issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n'),
    storyboardJson: storyboardJson.slice(0, 3000),
  }))
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
  const state = createInitialState()
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
  const state = createInitialState()
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
