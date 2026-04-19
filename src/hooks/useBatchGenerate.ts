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

const MAX_CONCURRENT = 2

export function useBatchGenerate() {
  const [batch, setBatch] = useState<BatchState | null>(null)
  const { generateKeyframe, generateBeatVideo } = useStoryboardGenerate()

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
            await generateKeyframe(row)
          } else {
            await generateBeatVideo(row)
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
    const finalJobs = useStoryboardStore.getState().rows
    const label = type === 'keyframe' ? 'Keyframe' : 'Beat Video'
    toast.success(`批量 ${label} 生成完成`)
  }, [generateKeyframe, generateBeatVideo])

  const cancelBatch = useCallback(() => {
    setBatch(null)
  }, [])

  return { batch, startBatch, cancelBatch }
}
