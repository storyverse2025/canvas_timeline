import type { ProviderSpec } from './types'

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'libtv', label: 'LibTV', envVar: 'LIBTV_ACCESS_KEY',
    models: [
      { id: 'libtv-auto', label: 'LibTV (自动路由)', kind: 'image', supportsRef: true },
      { id: 'libtv-video', label: 'LibTV 视频', kind: 'video', supportsRef: true, supportsVideo: true },
    ],
  },
  {
    id: 'fal', label: 'FAL.ai', envVar: 'FAL_KEY',
    models: [
      // Image models
      { id: 'fal-ai/flux-pro/v1.1', label: 'FLUX Pro v1.1', kind: 'image' },
      { id: 'fal-ai/flux-pro/v1.1-ultra', label: 'FLUX Pro Ultra', kind: 'image' },
      { id: 'fal-ai/flux/dev', label: 'FLUX Dev', kind: 'image' },
      // Video models
      { id: 'fal-ai/kling-video/v1.5/pro/text-to-video', label: 'Kling v1.5 Pro', kind: 'video', supportsVideo: true,
        resolutions: ['720p', '1080p'], durations: [5, 10], supportsAudio: false },
      { id: 'fal-ai/kling-video/v1/standard/text-to-video', label: 'Kling v1 Standard', kind: 'video', supportsVideo: true,
        resolutions: ['720p'], durations: [5, 10], supportsAudio: false },
      { id: 'fal-ai/minimax/video-01/text-to-video', label: 'MiniMax Hailuo', kind: 'video', supportsVideo: true,
        resolutions: ['720p'], durations: [6], supportsAudio: false },
      { id: 'fal-ai/wan-t2v', label: 'Wan2.6 文生视频', kind: 'video', supportsVideo: true,
        resolutions: ['720p', '1080p'], durations: [5, 10, 15], supportsAudio: true },
      { id: 'fal-ai/hunyuan-video', label: 'HunyuanVideo (腾讯)', kind: 'video', supportsVideo: true,
        resolutions: ['720p'], durations: [5], supportsAudio: false },
    ],
  },
  {
    // Provider id 'doubao' kept as a stable internal identifier for backward
    // compatibility with persisted IndexedDB state (existing canvas elements
    // carry provider:'doubao'). All endpoints route to BytePlus海外
    // (ark.ap-southeast.bytepluses.com) under the Dreamina-branded Seedance /
    // Seedream models. The legacy cn-beijing.volces.com path was deleted —
    // that account ran out of balance.
    id: 'doubao', label: 'BytePlus Ark (Dreamina)', envVar: 'ARK_API_KEY',
    models: [
      // Image models
      { id: 'dreamina-seedream-5-0-260128', label: 'Seedream 5.0 文生图', kind: 'image' },
      { id: 'dreamina-seedream-4-5-251128', label: 'Seedream 4.5 文生图', kind: 'image' },
      // Video models
      { id: 'dreamina-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast', kind: 'video', supportsVideo: true, supportsRef: true,
        resolutions: ['480p', '720p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], supportsAudio: true, supportsFirstLastFrame: true },
      { id: 'dreamina-seedance-2-0-260128', label: 'Seedance 2.0 (默认)', kind: 'video', supportsVideo: true, supportsRef: true,
        resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], supportsAudio: true, supportsFirstLastFrame: true },
      { id: 'dreamina-seedance-1-5-pro-251215', label: 'Seedance 1.5 Pro', kind: 'video', supportsVideo: true, supportsRef: true,
        resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], supportsAudio: true, supportsFirstLastFrame: true },
    ],
  },
  {
    id: 'tokenrouter', label: 'Apimart', envVar: 'APIMART_API_KEY',
    models: [
      { id: 'openai/gpt-5.4-image-2', label: 'GPT Image 2 (默认)', kind: 'image' },
      { id: 'openai/gpt-5-image', label: 'GPT-5 Image', kind: 'image' },
      { id: 'openai/gpt-5-image-mini', label: 'GPT-5 Image Mini', kind: 'image' },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-image-1', label: 'GPT Image 1 (直连)', kind: 'image' },
      { id: 'dall-e-3', label: 'DALL·E 3', kind: 'image' },
    ],
  },
  {
    id: 'gemini', label: 'Google Gemini (via Apimart)', envVar: 'APIMART_API_KEY',
    models: [
      { id: 'google/gemini-3.1-flash-image-preview', label: 'Gemini 3 Flash (默认)', kind: 'image' },
      { id: 'google/gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image', kind: 'image' },
      { id: 'google/gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', kind: 'image' },
    ],
  },
]

export function getProvider(id: string) {
  return PROVIDERS.find((p) => p.id === id)
}

export function getModel(providerId: string, modelId: string) {
  return getProvider(providerId)?.models.find((m) => m.id === modelId)
}

/** Get all models of a specific kind across all providers */
export function getModelsByKind(kind: 'image' | 'video' | 'audio') {
  return PROVIDERS.flatMap((p) =>
    p.models.filter((m) => m.kind === kind).map((m) => ({ ...m, provider: p.id, providerLabel: p.label }))
  )
}
