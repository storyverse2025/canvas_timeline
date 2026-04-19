import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useProjectStore } from '@/stores/project-store'
import { useChatStore } from '@/stores/chat-store'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { skills } from './skill-executor'
import { runDirectorPipeline, runDirectorStage, type PipelineState } from './director-assistant'
import { parseAndValidateStoryboard } from './storyboard-parser'

export interface Intent {
  skill: string
  label: string
  params?: Record<string, unknown>
}

/**
 * Patterns that should be handled by Claude (storyboard generation via LLM).
 * These are checked first and cause detectIntent to return null so the message
 * goes to the Claude API with the full system prompt + canvas context.
 */
const PASSTHROUGH_TO_LLM: RegExp[] = [
  /分镜|表格|storyboard|shot.?list/i,
]

const INTENT_PATTERNS: { pattern: RegExp; skill: string; label: string }[] = [
  { pattern: /导演助手|优化流程|智能优化|director.?assist/i, skill: 'directorFull', label: '导演助手 - 完整流程' },
  { pattern: /优化分镜|优化镜头|镜头优化|optimize.?shot/i, skill: 'directorOptimize', label: '导演助手 - 优化' },
  { pattern: /自检|self.?check|逻辑检查|一致性/i, skill: 'directorSelfcheck', label: '导演助手 - 自检' },
  { pattern: /修复分镜|修复镜头|fix.?shot/i, skill: 'directorFix', label: '导演助手 - 修复' },
  { pattern: /生成剧本|generate script|写剧本|create script/i, skill: 'generateScript', label: 'Generate Script' },
  { pattern: /生成角色|generate character|创建角色|create character/i, skill: 'generateCharacters', label: 'Generate Characters' },
  { pattern: /生成场景|generate scene|创建场景/i, skill: 'generateScenes', label: 'Generate Scenes' },
  { pattern: /生成道具|generate prop|创建道具/i, skill: 'generateProps', label: 'Generate Props' },
  { pattern: /生成关键帧|generate keyframe/i, skill: 'generateKeyframes', label: 'Generate Keyframes' },
  { pattern: /生成视频|generate video|制作视频/i, skill: 'generateVideoShots', label: 'Generate Video Shots' },
  { pattern: /自动关联|auto.?map|自动映射|link timeline/i, skill: 'autoMapTimeline', label: 'Auto-Map Timeline' },
  { pattern: /全流程|full pipeline|一键生成|run all|run full/i, skill: 'runFullPipeline', label: 'Run Full Pipeline' },
  { pattern: /剪辑|edit pipeline|合成视频|compose/i, skill: 'runEditPipeline', label: 'Run Edit Pipeline' },
  { pattern: /检查质量|analyze|质量检测|QA|quality/i, skill: 'analyzeQuality', label: 'Analyze Quality' },
  { pattern: /添加到画布|add to canvas|放到画布/i, skill: 'addToCanvas', label: 'Add to Canvas' },
  { pattern: /连接时间线|connect.*timeline|关联时间线/i, skill: 'connectTimeline', label: 'Connect to Timeline' },
]

export function detectIntent(text: string): Intent | null {
  // If the message should go to Claude for storyboard/table generation, skip intent matching
  for (const p of PASSTHROUGH_TO_LLM) {
    if (p.test(text)) return null
  }
  for (const { pattern, skill, label } of INTENT_PATTERNS) {
    if (pattern.test(text)) {
      return { skill, label }
    }
  }
  return null
}

export async function executeIntent(intent: Intent, projectId: string): Promise<void> {
  const chatStore = useChatStore.getState()

  const directorUpdate = (state: PipelineState) => {
    const stage = state.stages[state.currentStage]
    const step = stage.steps[state.currentStep]
    const totalSteps = state.stages.reduce((s, st) => s + st.steps.length, 0)
    const doneSteps = state.stages.reduce((s, st) => s + st.steps.filter((x) => x.status === 'done').length, 0)
    chatStore.setSkillProgress({
      step: doneSteps,
      total: totalSteps,
      label: `${stage.label} · ${step.label} (${state.progress}%)`,
    })
  }

  const applyStoryboardResult = (json: string) => {
    const result = parseAndValidateStoryboard(json)
    if (result.ok && result.rows) {
      useStoryboardStore.getState().replaceAll(result.rows)
      chatStore.addMessage('system', `✓ 分镜表已更新：${result.rows.length} 行`)
    } else {
      chatStore.addMessage('system', `分镜 JSON 解析失败：${(result.errors ?? []).slice(0, 3).join('; ')}`)
    }
  }

  try {
    switch (intent.skill) {
      case 'directorFull': {
        chatStore.setActiveSkill('directorFull')
        chatStore.addMessage('system', '🎬 导演助手启动 — 优化 → 自检 → 修复')
        const { state, storyboardJson } = await runDirectorPipeline(directorUpdate)
        chatStore.setSkillProgress(null)
        if (state.issues.length > 0) {
          chatStore.addMessage('system', `自检发现 ${state.issues.length} 个问题，已自动修复：\n${state.fixes.join('\n')}`)
        } else {
          chatStore.addMessage('system', '自检通过，无需修复')
        }
        applyStoryboardResult(storyboardJson)
        break
      }

      case 'directorOptimize': {
        chatStore.setActiveSkill('directorOptimize')
        chatStore.addMessage('system', '🎬 导演助手 · 01 优化')
        const json = await runDirectorStage('optimize', undefined, directorUpdate)
        chatStore.setSkillProgress(null)
        applyStoryboardResult(json)
        break
      }

      case 'directorSelfcheck': {
        chatStore.setActiveSkill('directorSelfcheck')
        chatStore.addMessage('system', '🎬 导演助手 · 02 自检')
        const rows = useStoryboardStore.getState().rows
        if (rows.length === 0) {
          chatStore.addMessage('system', '请先生成分镜表')
          break
        }
        const existingJson = JSON.stringify(rows.map((r) => ({
          shot_number: r.shot_number, duration: r.duration,
          visual_description: r.visual_description, shot_size: r.shot_size,
          character_actions: r.character_actions, emotion_mood: r.emotion_mood,
          lighting_atmosphere: r.lighting_atmosphere, dialogue: r.dialogue,
        })))
        await runDirectorStage('selfcheck', existingJson, directorUpdate)
        chatStore.setSkillProgress(null)
        break
      }

      case 'directorFix': {
        chatStore.setActiveSkill('directorFix')
        chatStore.addMessage('system', '🎬 导演助手 · 03 修复')
        const fixRows = useStoryboardStore.getState().rows
        if (fixRows.length === 0) {
          chatStore.addMessage('system', '请先生成分镜表')
          break
        }
        const fixJson = JSON.stringify(fixRows.map((r) => ({
          shot_number: r.shot_number, duration: r.duration,
          visual_description: r.visual_description, shot_size: r.shot_size,
          character_actions: r.character_actions, emotion_mood: r.emotion_mood,
        })))
        const fixed = await runDirectorStage('fix', fixJson, directorUpdate)
        chatStore.setSkillProgress(null)
        applyStoryboardResult(fixed)
        break
      }

      case 'generateScript':
        chatStore.setActiveSkill('generateScript')
        await skills.generateScript(projectId, { inspiration: 'Generate a creative story' })
        break

      case 'generateCharacters':
        chatStore.setActiveSkill('generateCharacters')
        const { episodes } = useProjectStore.getState()
        await skills.generateCharacters(projectId, episodes)
        break

      case 'generateScenes':
        chatStore.setActiveSkill('generateScenes')
        await skills.generateScenes(projectId)
        break

      case 'generateProps':
        chatStore.setActiveSkill('generateProps')
        await skills.generateProps(projectId)
        break

      case 'generateKeyframes':
        chatStore.setActiveSkill('generateKeyframes')
        await skills.generateKeyframes(projectId, '1')
        break

      case 'generateVideoShots':
        chatStore.setActiveSkill('generateVideoShots')
        await skills.generateVideoShots(projectId, 1)
        break

      case 'autoMapTimeline':
        chatStore.setActiveSkill('autoMapTimeline')
        await skills.autoMapTimeline()
        break

      case 'runFullPipeline':
        chatStore.setActiveSkill('runFullPipeline')
        await skills.runFullPipeline(projectId, {}, (step, total, label) => {
          chatStore.setSkillProgress({ step, total, label })
        })
        chatStore.setSkillProgress(null)
        break

      case 'runEditPipeline':
        chatStore.setActiveSkill('runEditPipeline')
        await skills.runEditPipeline(projectId, '1')
        break

      case 'analyzeQuality':
        chatStore.setActiveSkill('analyzeQuality')
        const selectedNodes = useCanvasStore.getState().selectedNodeIds
        if (selectedNodes.length > 0) {
          await skills.analyzeQuality(projectId, 'node', selectedNodes[0])
        } else {
          chatStore.addMessage('assistant', 'Select a node on the canvas first to analyze it.')
        }
        break

      default:
        chatStore.addMessage('assistant', `Unknown skill: ${intent.skill}`)
    }
  } finally {
    chatStore.setActiveSkill(null)
  }
}
