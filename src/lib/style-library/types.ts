export type StyleCategory = '2d' | '3d' | 'live_action'

export interface StyleGuide {
  goal: string
  consistency_rules: string[]
  [key: string]: string | string[] | Record<string, string> | undefined
}

export interface StylePresetDefinition {
  style_id: string
  label: string
  category: StyleCategory
  source: string
  global_style_guide: StyleGuide
}

export interface StyleLibraryFile {
  version: string
  default_style_id: string
  selection_contract: {
    user_selects: string
    fallback_style_id: string
    pipeline_rule: string
  }
  style_categories: StyleCategory[]
  styles: StylePresetDefinition[]
}
