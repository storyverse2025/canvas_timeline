// 3D 导演台（storyai-director-studio）对外地址。服务端 vite-previs-plugin 的
// PREVIS_STUDIO_PUBLIC_URL 默认值与此一致；前端可用 VITE_DIRECTOR_STUDIO_URL 覆盖。
export const DIRECTOR_STUDIO_URL = (
  (import.meta.env.VITE_DIRECTOR_STUDIO_URL as string | undefined) || 'http://studio.35.168.148.47.nip.io'
).replace(/\/+$/, '')
