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
  /**
   * This capability runs a multi-step pipeline and chooses its own models per
   * step, rather than being one call to one model. The dialog then hides the
   * model picker (the choice would be ignored) and leaves `duration` alone —
   * for a pipeline that value is the length of the finished piece, not the
   * length of a single clip, so the model's clip-duration list must not
   * overwrite it.
   */
  pipeline?: boolean
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
  /**
   * What this output is within a multi-step capability, when it is part of a
   * structure rather than one of several equal results. 'shot' outputs are the
   * pieces, 'final' is what they were assembled into, and the client wires each
   * shot into the final instead of hanging everything off the source node.
   * Absent for ordinary capabilities, which keep the flat fan-out.
   */
  role?: 'storyboard' | 'shot' | 'final'
  /** Shown on the node instead of the capability label, e.g. "S003 真唱". */
  label?: string
}

export interface CapabilityResponse {
  outputs: CapabilityOutput[]
}
