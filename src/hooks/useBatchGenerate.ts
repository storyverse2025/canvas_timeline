import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { useStoryboardGenerate } from '@/hooks/useStoryboardGenerate'
import type { StoryboardRow } from '@/types/storyboard'

export type BatchJobStatus = 'pending' | 'running' | 'done' | 'error'
export type BatchType = 'keyframe' | 'beat-video'

export interface BatchJob {
  rowId: string
  shotNumber: string
  status: BatchJobStatus
  error?: string
}

export interface BatchState {
  type: BatchType
  jobs: BatchJob[]
  completedCount: number
  totalCount: number
  isRunning: boolean
}

const MAX_CONCURRENT = 5

export function useBatchGenerate() {
  const [batch, setBatch] = useState<BatchState | null>(null)
  const { generateKeyframe, generateBeatVideo, generateIdentitySheets } = useStoryboardGenerate()

  const updateJob = (rowId: string, patch: Partial<BatchJob>) => {
    setBatch((prev) => {
      if (!prev) return prev
      const jobs = prev.jobs.map((j) => j.rowId === rowId ? { ...j, ...patch } : j)
      const completedCount = jobs.filter((j) => j.status === 'done' || j.status === 'error').length
      return { ...prev, jobs, completedCount }
    })
  }

  const startBatch = useCallback(async (type: BatchType) => {
    const rows = useStoryboardStore.getState().rows
    if (rows.length === 0) { toast.error('分镜表为空'); return }

    const jobs: BatchJob[] = rows.map((r) => ({
      rowId: r.id,
      shotNumber: r.shot_number,
      status: 'pending' as const,
    }))

    setBatch({ type, jobs, completedCount: 0, totalCount: jobs.length, isRunning: true })
    toast.info(`开始批量生成 ${type === 'keyframe' ? 'Keyframe' : 'Beat Video'}（${jobs.length} 个）`)

    // Process with concurrency limit
    const queue = [...jobs]
    const running = new Set<string>()

    const processNext = async () => {
      while (queue.length > 0 && running.size < MAX_CONCURRENT) {
        const job = queue.shift()!
        running.add(job.rowId)
        updateJob(job.rowId, { status: 'running' })

        try {
          // Get the latest row data
          const row = useStoryboardStore.getState().rows.find((r) => r.id === job.rowId)
          if (!row) throw new Error('row not found')

          if (type === 'keyframe') {
            // Per-row chain: ①角色身份版 → ②黑白故事板 → ③开场构图.
            // The sheets feed the storyboard as character refs; the
            // storyboard's first panel anchors the 开场构图 (②→③ is
            // sequenced inside the generateKeyframe verb). Existing sheets
            // are reused — a re-run only fills what's missing. Sheet
            // failures don't abort the row (generateIdentitySheets toasts
            // internally); the keyframe then falls back to raw slot images.
            const needs1 = Boolean((row.character1?.image || row.character1?.description) && !row.identitySheet1Url)
            const needs2 = Boolean((row.character2?.image || row.character2?.description) && !row.identitySheet2Url)
            if (needs1 && needs2) await generateIdentitySheets(row)
            else if (needs1) await generateIdentitySheets(row, 1)
            else if (needs2) await generateIdentitySheets(row, 2)
            // Re-read: the sheets were persisted onto the row by updateRow.
            const fresh = useStoryboardStore.getState().rows.find((r) => r.id === job.rowId) ?? row
            await generateKeyframe(fresh)
          } else {
            await generateBeatVideo(row)
            const updatedRow = useStoryboardStore.getState().rows.find((r) => r.id === job.rowId)
            if (type === 'beat-video' && !updatedRow?.beatVideoUrl) {
              throw new Error('missing beat video result')
            }
          }
          updateJob(job.rowId, { status: 'done' })
        } catch (e) {
          updateJob(job.rowId, { status: 'error', error: String((e as Error).message) })
        } finally {
          running.delete(job.rowId)
        }
      }
    }

    // Start concurrent workers
    const workers = Array.from({ length: MAX_CONCURRENT }, () => {
      return (async () => {
        while (queue.length > 0) {
          await processNext()
        }
      })()
    })

    await Promise.all(workers)

    setBatch((prev) => prev ? { ...prev, isRunning: false } : null)
    const label = type === 'keyframe' ? 'Keyframe' : 'Beat Video'
    toast.success(`批量 ${label} 生成完成`)
  }, [generateKeyframe, generateBeatVideo])

  const cancelBatch = useCallback(() => {
    setBatch(null)
  }, [])

  return { batch, startBatch, cancelBatch }
}
