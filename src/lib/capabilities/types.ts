export type CapabilityCategory = 'agent' | 'image' | 'video' | 'audio'

export type InputKind = 'text' | 'image' | 'video' | 'audio'
export type OutputKind = 'text' | 'image' | 'video' | 'audio'

export interface CapabilityParam {
  key: string
  label: string
  type: 'string' | 'number' | 'select'
  options?: { value: string; label: string }[]
  default?: string | number
  required?: boolean
}

export interface CapabilitySpec {
  id: string
  category: CapabilityCategory
  label: string
  description: string
  inputKinds: InputKind[]
  outputKind: OutputKind
  params?: CapabilityParam[]
  nodeTypes: ('image' | 'text' | 'video' | 'audio')[]
}

export interface CapabilityInput {
  kind: InputKind
  url?: string
  text?: string
}

export interface CapabilityRequest {
  capability: string
  inputs: CapabilityInput[]
  params?: Record<string, unknown>
}

export interface CapabilityOutput {
  kind: OutputKind
  url?: string
  text?: string
}

export interface CapabilityResponse {
  outputs: CapabilityOutput[]
}
