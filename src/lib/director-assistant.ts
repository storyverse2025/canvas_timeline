/**
 * 导演助手 - 智能优化流程
 * Three-stage pipeline: 优化 → 自检 → 修复
 * Transforms script/canvas content into refined shot designs.
 */

import { runCapability } from '@/lib/capabilities/client'
import { buildCanvasContext } from '@/lib/canvas-context'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { ensureElements, buildElementContext } from '@/lib/canvas-elements'

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
    currentStage: 0,
    currentStep: 0,
    totalTokens: 0,
    progress: 0,
    issues: [],
    fixes: [],
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
  const canvasCtx = buildCanvasContext()
  const items = useCanvasItemStore.getState().items
  const canvasText = Object.values(items)
    .filter((it) => it.kind === 'text' && it.content)
    .map((it) => `[${it.name}]: ${it.content}`)
    .join('\n\n')

  // Use ProjectDB script if available (set by Director UI), else fall back to canvas text
  const { useProjectDB } = await import('@/stores/project-db')
  const db = useProjectDB.getState()
  const scriptText = db.script.text || canvasText
  const artDir = db.artDirection
  const artDirectionNote = `\n美术风格：${artDir.stylePreset}${artDir.customStyle ? ` (${artDir.customStyle})` : ''}，画面比例：${artDir.defaultAspectRatio}`

  const storyboardRows = useStoryboardStore.getState().rows
  const existingStoryboard = storyboardRows.length > 0
    ? `\n\n现有分镜表（${storyboardRows.length}行）：\n${storyboardRows.map((r) => `${r.shot_number}: ${r.visual_description}`).join('\n')}`
    : ''

  // Step 1: 剧本结构化分析
  setStep(state, 0, 0, 'running'); onUpdate(state)
  const scriptAnalysis = await aiCall(
    `你是专业编剧分析师。分析以下剧本/画布内容的叙事结构：
- 识别幕结构（三幕/五幕）
- 标记关键转折点、高潮、冲突
- 提取主题线和情感弧线
- 标注每段的时间比重

画布内容：
${canvasCtx}

${scriptText ? `剧本文本：\n${scriptText}` : ''}
${existingStoryboard}

输出结构化分析结果。`,
  )
  setStep(state, 0, 0, 'done', scriptAnalysis); onUpdate(state)

  // Step 2: 视觉锚定提取
  setStep(state, 0, 1, 'running'); onUpdate(state)
  const inv = await ensureElements(() => {}, {
    scriptText,
    stylePreset: artDir.stylePreset,
    customStyle: artDir.customStyle,
  })
  const elementCtx = buildElementContext(inv)
  const visualAnchor = await aiCall(
    `基于剧本分析和已有画布元素，提取视觉锚点：
- 每个场景的核心视觉标识（色调、构图母题、标志性道具）
- 角色的视觉一致性锚点（服装颜色、特征配饰、体型比例）
- 跨镜头的视觉连接线索

剧本分析：
${scriptAnalysis}

画布元素：
${elementCtx}

输出每个场景/角色的视觉锚点列表。`,
  )
  setStep(state, 0, 1, 'done', visualAnchor); onUpdate(state)

  // Step 3: 全局视觉策略
  setStep(state, 0, 2, 'running'); onUpdate(state)
  const visualStrategy = await aiCall(
    `作为视觉总监，制定全局视觉策略。用户指定的美术方向：${artDirectionNote}

请基于此美术方向制定：
- 整体色彩方案（每幕的色调变化，须符合 ${artDir.stylePreset} 风格）
- 镜头语言风格（手持/稳定/斯坦尼康）
- 光影基调（自然光/人工光/混合）
- 构图规则（三分法/中心/对称）
- 转场策略（硬切/溶解/匹配剪辑）

剧本分析：${scriptAnalysis.slice(0, 500)}
视觉锚点：${visualAnchor.slice(0, 500)}

输出视觉策略文档。`,
  )
  setStep(state, 0, 2, 'done', visualStrategy); onUpdate(state)

  // Step 4: 镜头分配计划
  setStep(state, 0, 3, 'running'); onUpdate(state)
  const shotPlan = await aiCall(
    `作为分镜导演，制定镜头分配计划：
- 每个叙事段落分配多少个镜头
- 每个镜头的景别分配（保证景别多样性）
- 节奏控制（快切 vs 长镜头的分布）
- 总时长分配

剧本分析：${scriptAnalysis.slice(0, 500)}
视觉策略：${visualStrategy.slice(0, 500)}

输出镜头分配表（场景→镜头数→景别→时长）。`,
  )
  setStep(state, 0, 3, 'done', shotPlan); onUpdate(state)

  // Step 5: 镜头构图设计
  setStep(state, 0, 4, 'running'); onUpdate(state)
  const shotDesign = await aiCall(
    `作为构图设计师，为每个镜头设计具体构图：
- 画面主体位置和大小
- 前景/中景/背景层次
- 引导线和视觉重心
- 角色站位和走位
- 光源方向和阴影

镜头分配：${shotPlan.slice(0, 800)}
视觉锚点：${visualAnchor.slice(0, 500)}

输出每个镜头的构图设计说明。`,
  )
  setStep(state, 0, 4, 'done', shotDesign); onUpdate(state)

  // Step 6: 优化结果 → 生成 JSON 分镜表
  setStep(state, 0, 5, 'running'); onUpdate(state)
  const storyboardJson = await aiCall(
    `将以上所有分析整合，输出最终的分镜表 JSON 数组。每行包含：
{
  "shot_number": "S1",
  "duration": 3.5,
  "visual_description": "完整画面描述",
  "visual_anchor": "该镜头的视觉锚点",
  "shot_size": "景别",
  "character_actions": "角色动作",
  "emotion_mood": "情绪",
  "lighting_atmosphere": "光影氛围",
  "dialogue": "对白",
  "storyboard_prompts": "english keyframe generation prompt",
  "motion_prompts": "english video motion prompt",
  "character1": { "image": "", "description": "角色1描述" },
  "character2": { "image": "", "description": "角色2描述" },
  "scene": { "image": "", "description": "场景描述" }
}

镜头分配：${shotPlan.slice(0, 600)}
构图设计：${shotDesign.slice(0, 600)}
视觉策略：${visualStrategy.slice(0, 400)}
视觉锚点：${visualAnchor.slice(0, 400)}
画布元素：${elementCtx}

只输出 \`\`\`json ... \`\`\` 代码块，不要其他文字。`,
  )
  setStep(state, 0, 5, 'done', storyboardJson); onUpdate(state)

  return storyboardJson
}

// ─── Stage 2: 自检 ──────────────────────────────────────────────────

async function runSelfCheck(state: PipelineState, storyboardJson: string, onUpdate: OnUpdate): Promise<string[]> {
  // Step 1: 时间轴与空间逻辑
  setStep(state, 1, 0, 'running'); onUpdate(state)
  const timelineCheck = await aiCall(
    `你是连续性审查员。检查以下分镜表的时间轴和空间逻辑：
- 时间是否连贯（白天→夜晚是否合理？）
- 空间是否一致（角色不能瞬移）
- 因果关系是否成立
- 道具连续性（前一镜出现的物品后续是否还在）

分镜表：
${storyboardJson.slice(0, 3000)}

如果发现问题，输出 JSON 数组：[{ "shot": "S3", "issue": "描述", "fix": "建议" }]
如果没有问题，输出：[]`,
  )
  setStep(state, 1, 0, 'done', timelineCheck); onUpdate(state)

  // Step 2: 视觉平衡扫描
  setStep(state, 1, 1, 'running'); onUpdate(state)
  const visualCheck = await aiCall(
    `你是视觉平衡审查员。扫描分镜表的视觉平衡：
- 景别分布是否合理（不能连续5个特写）
- 色调变化是否有节奏
- 镜头时长是否合理（不能太短<1s或太长>15s连续出现）
- 构图多样性（是否过于单调）
- 角色出镜均衡性

分镜表：
${storyboardJson.slice(0, 3000)}

如果发现问题，输出 JSON 数组：[{ "shot": "S5", "issue": "描述", "fix": "建议" }]
如果没有问题，输出：[]`,
  )
  setStep(state, 1, 1, 'done', visualCheck); onUpdate(state)

  // Parse issues
  const issues: string[] = []
  for (const checkResult of [timelineCheck, visualCheck]) {
    try {
      const m = checkResult.match(/\[[\s\S]*\]/)
      if (m) {
        const arr = JSON.parse(m[0]) as { shot: string; issue: string; fix: string }[]
        for (const a of arr) {
          issues.push(`${a.shot}: ${a.issue} → ${a.fix}`)
        }
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

  // Step 1: 执行修复
  setStep(state, 2, 0, 'running'); onUpdate(state)
  const fixResult = await aiCall(
    `你是分镜修复专家。根据自检发现的问题修复分镜表。

问题列表：
${issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

原始分镜表：
${storyboardJson.slice(0, 3000)}

修复规则：
- 只修改有问题的镜头，不要改动正确的部分
- 保持总时长大致不变
- 确保修复后的景别分布合理
- 保持角色和场景的连续性

输出修复后的完整分镜表 JSON 数组（\`\`\`json ... \`\`\`），不要其他文字。`,
  )
  state.fixes = issues.map((i) => `已修复: ${i}`)
  setStep(state, 2, 0, 'done', `已修复 ${issues.length} 个问题`); onUpdate(state)

  // Step 2: 最终结果
  setStep(state, 2, 1, 'done', fixResult); onUpdate(state)
  return fixResult
}

// ─── Public API ─────────────────────────────────────────────────────

export type StageId = 'optimize' | 'selfcheck' | 'fix'

/**
 * Run the full Director Assistant pipeline.
 * onUpdate is called after each step completes for live progress display.
 */
export async function runDirectorPipeline(
  onUpdate: OnUpdate,
): Promise<{ state: PipelineState; storyboardJson: string }> {
  const state = createInitialState()
  onUpdate(state)

  // Stage 1: 优化
  const storyboardJson = await runOptimize(state, onUpdate)

  // Stage 2: 自检
  const issues = await runSelfCheck(state, storyboardJson, onUpdate)

  // Stage 3: 修复
  const finalJson = await runFix(state, storyboardJson, issues, onUpdate)

  return { state, storyboardJson: finalJson }
}

/**
 * Run a single stage (for incremental use).
 */
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
      const issues = state.issues.length > 0
        ? state.issues
        : ['请先运行自检']
      return runFix(state, json, issues, update)
    }
  }
}
