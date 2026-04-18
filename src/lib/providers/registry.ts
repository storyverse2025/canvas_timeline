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
      { id: 'fal-ai/flux-pro/v1.1', label: 'FLUX Pro v1.1', kind: 'image' },
      { id: 'fal-ai/flux/dev', label: 'FLUX Dev', kind: 'image' },
    ],
  },
  {
    id: 'doubao', label: '豆包 (火山方舟)', envVar: 'ARK_API_KEY',
    models: [
      { id: 'doubao-seedream-4-5-251128', label: 'Seedream 4.5 文生图', kind: 'image' },
      { id: 'doubao-seedance-2-0-fast-260128', label: 'Seedance 2.0 Fast 视频 (默认)', kind: 'video', supportsVideo: true, supportsRef: true },
      { id: 'doubao-seedance-2-0-260128', label: 'Seedance 2.0 视频', kind: 'video', supportsVideo: true, supportsRef: true },
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
      { id: 'gemini-2.5-flash-image-preview', label: 'Gemini Image Preview', kind: 'image' },
    ],
  },
]

export function getProvider(id: string) {
  return PROVIDERS.find((p) => p.id === id)
}

export function getModel(providerId: string, modelId: string) {
  return getProvider(providerId)?.models.find((m) => m.id === modelId)
}
