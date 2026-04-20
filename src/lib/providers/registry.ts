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
    id: 'doubao', label: '豆包 (火山方舟)', envVar: 'ARK_API_KEY',
    models: [
      // Image models
      { id: 'doubao-seedream-5-0-260128', label: 'Seedream 5.0 文生图', kind: 'image' },
      { id: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5 文生图', kind: 'image' },
      // Video models
      { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast (默认)', kind: 'video', supportsVideo: true, supportsRef: true,
        resolutions: ['480p', '720p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], supportsAudio: true, supportsFirstLastFrame: true },
      { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0', kind: 'video', supportsVideo: true, supportsRef: true,
        resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], supportsAudio: true, supportsFirstLastFrame: true },
      { id: 'doubao-seedance-1-5-pro-251215', label: 'Seedance 1.5 Pro', kind: 'video', supportsVideo: true, supportsRef: true,
        resolutions: ['480p', '720p', '1080p'], durations: [4, 5, 6, 7, 8, 9, 10, 11, 12], supportsAudio: true, supportsFirstLastFrame: true },
    ],
  },
  {
    id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-image-1', label: 'GPT Image 1', kind: 'image' },
      { id: 'dall-e-3', label: 'DALL·E 3', kind: 'image' },
    ],
  },
  {
    id: 'gemini', label: 'Google Gemini', envVar: 'GEMINI_API_KEY',
    models: [
      { id: 'gemini-2.5-flash-image-preview', label: 'Gemini 2.5 Flash Image', kind: 'image' },
      { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash', kind: 'image' },
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
