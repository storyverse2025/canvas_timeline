import { z } from 'zod'

/**
 * Output shape of script-agent's default (expand-script) flow.
 *
 * Mirrors the JSON produced by `prompts/expand-script.md`. Downstream agents
 * (art-director, director, actor) parse this dossier — keep the field names
 * stable.
 */

export const FrameworkCalibrationSchema = z.object({
  logline: z.string().default(''),
  duration_or_episode_type: z.string().default(''),
  platform_bias: z.string().default(''),
  core_emotion: z.string().default(''),
  main_risk: z.string().default(''),
})

export const ExpandedScriptBaselineSchema = z.object({
  format: z.string().default(''),
  script_text: z.string().default(''),
  beat_summary: z.array(z.string()).default([]),
})

export const DoctorRoundtableSummarySchema = z.object({
  must_fix: z.array(z.string()).default([]),
  keep: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
})

export const DialogueDiagnosisSummarySchema = z.object({
  voice_print_risks: z.array(z.string()).default([]),
  subtext_risks: z.array(z.string()).default([]),
  rewrite_notes: z.array(z.string()).default([]),
})

export const CastingCardSchema = z.object({
  name: z.string(),
  dramatic_function: z.string().default(''),
  age_range: z.string().default(''),
  gender_presentation: z.string().default(''),
  appearance_for_image: z.string().default(''),
  personality_layers: z.string().default(''),
  voice_print: z.string().default(''),
  performance_anchors: z.string().default(''),
  casting_notes: z.string().default(''),
})

export const SceneCardSchema = z.object({
  name: z.string(),
  location: z.string().default(''),
  time_of_day: z.string().default(''),
  mood: z.string().default(''),
  visual_requirements: z.string().default(''),
})

export const PropCardSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  dramatic_significance: z.string().default(''),
})

export const ScriptDossierSchema = z.object({
  framework_calibration: FrameworkCalibrationSchema,
  expanded_script_baseline: ExpandedScriptBaselineSchema,
  doctor_roundtable_summary: DoctorRoundtableSummarySchema,
  dialogue_diagnosis_summary: DialogueDiagnosisSummarySchema,
  casting_cards: z.array(CastingCardSchema).default([]),
  scene_cards: z.array(SceneCardSchema).default([]),
  prop_cards: z.array(PropCardSchema).default([]),
  storyboard_directives: z.array(z.string()).default([]),
})

export type ScriptDossier = z.infer<typeof ScriptDossierSchema>
export type CastingCard = z.infer<typeof CastingCardSchema>
export type SceneCard = z.infer<typeof SceneCardSchema>
export type PropCard = z.infer<typeof PropCardSchema>

/**
 * Sub-agent the user (or parent) chose to delegate to.
 * 'default' means run script-agent's own expand-script flow.
 */
export const ScriptSubAgentSchema = z.enum([
  'default',
  'framework-qa',
  'writing-expansion',
  'doctor-roundtable',
  'dialogue-doctor',
])
export type ScriptSubAgent = z.infer<typeof ScriptSubAgentSchema>

export const ScriptInputShapeSchema = z.enum([
  'rough-idea',
  'partial-script',
  'complete-draft',
  'specific-scene',
])
export type ScriptInputShape = z.infer<typeof ScriptInputShapeSchema>

export interface ScriptRequest {
  /** The user's raw script text (idea, outline, beats, or full draft). */
  scriptText: string
  /** Optional canvas context summary (from buildCanvasContext or similar). */
  canvasContext?: string
  /** Optional existing storyboard block to preserve. */
  existingStoryboard?: string
}
