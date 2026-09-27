import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { persist, createJSONStorage } from 'zustand/middleware'

/**
 * 「生成 3D 预演」任务：一个 run 对应画布上一个占位视频节点。
 * 持久化到 localStorage —— 预演要跑好几分钟，刷新页面后要能接着轮询；
 * 真正的任务状态在服务端 studio/work/<shortId>/ 里，这里只是指针 + 最近一次进度。
 */
export type PrevisRunStatus = 'running' | 'done' | 'error'

export interface PrevisRun {
  shortId: string
  itemId: string
  nodeId: string
  status: PrevisRunStatus
  phase: string
  toolCalls: number
  startedAt: number
  error?: string
  sessionUrl?: string
  bundleUrl?: string
  reportUrl?: string
  mp4Url?: string
}

interface State {
  runs: Record<string, PrevisRun>
}

interface Actions {
  addRun: (run: PrevisRun) => void
  updateRun: (shortId: string, patch: Partial<PrevisRun>) => void
  removeRun: (shortId: string) => void
}

export const usePrevisRunsStore = create<State & Actions>()(
  persist(
    immer((set) => ({
      runs: {},
      addRun: (run) => set((s) => { s.runs[run.shortId] = run }),
      updateRun: (shortId, patch) => set((s) => {
        const r = s.runs[shortId]
        if (r) Object.assign(r, patch)
      }),
      removeRun: (shortId) => set((s) => { delete s.runs[shortId] }),
    })),
    { name: 'previs-runs-store', storage: createJSONStorage(() => localStorage) },
  ),
)
