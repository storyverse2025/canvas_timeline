import { useEffect, useRef, useState } from 'react'
import { Mic, Square, Send, Loader2, X, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useVoiceRecorder } from '@/hooks/use-voice-recorder'
import { api } from '@/lib/api-client'
import { useProjectStore } from '@/stores/project-store'

export type VoiceElementKind = 'character' | 'scene' | 'prop' | 'keyframe' | 'shot'

export interface VoicePlan {
  jobId: string
  elementKind: VoiceElementKind
  elementId: string
  newPrompt: string
  userIntent?: string
  transcript?: string
  keyChanges?: string[]
  preserve?: string[]
  severity?: string
}

interface Props {
  elementKind: VoiceElementKind
  /** Stable client-side id for this element. Only used to scope status + dedupe callbacks. */
  elementId: string
  /** Snapshot of current element state — sent verbatim to the planner LLM. */
  elementContext?: Record<string, unknown>
  /** Optional human label for tooltip / a11y. */
  label?: string
  /** Compact icon-only style for embedding inside table rows / canvas nodes. */
  compact?: boolean
  /**
   * Fires exactly once per completed voice-feedback job for this element.
   * Hosts use it to run their own local regeneration with the new prompt.
   */
  onPlanReady?: (plan: VoicePlan) => void | Promise<void>
}

type Phase = 'idle' | 'submitting' | 'in_flight' | 'done' | 'error'

export function VoiceFeedbackButton({
  elementKind,
  elementId,
  elementContext,
  label,
  compact = false,
  onPlanReady,
}: Props) {
  const projectId = useProjectStore((s) => s.project?.id ?? null)
  const { state, blob, durationMs, error, start, stop, reset } = useVoiceRecorder()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [serverError, setServerError] = useState<string | null>(null)
  const [latestJob, setLatestJob] = useState<null | {
    job_id: string
    status?: string
    phase?: string
    progress?: number
    user_intent?: string
    new_prompt?: string
    transcript?: string
    key_changes?: string[]
    preserve?: string[]
    severity?: string
    error?: string | null
  }>(null)

  // Job ids whose `onPlanReady` we've already invoked, so we never fire twice.
  const firedJobsRef = useRef<Set<string>>(new Set())
  const onPlanReadyRef = useRef(onPlanReady)
  onPlanReadyRef.current = onPlanReady

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    const tick = async () => {
      try {
        const progress = await api.progress.get(projectId)
        if (cancelled) return
        const mine = (progress.voice_feedback_jobs || [])
          .filter((j) => j.element_kind === elementKind && j.element_id === elementId)
          .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        const job = mine[0] ?? null
        if (job) {
          setLatestJob(job)
          if (
            job.status === 'completed' &&
            job.new_prompt &&
            !firedJobsRef.current.has(job.job_id)
          ) {
            firedJobsRef.current.add(job.job_id)
            try {
              await onPlanReadyRef.current?.({
                jobId: job.job_id,
                elementKind,
                elementId,
                newPrompt: job.new_prompt,
                userIntent: job.user_intent,
                transcript: job.transcript,
                keyChanges: (job as { key_changes?: string[] }).key_changes,
                preserve: (job as { preserve?: string[] }).preserve,
                severity: (job as { severity?: string }).severity,
              })
            } catch (err) {
              // Surface the regen failure inline; don't break the poller.
              console.error('voice-feedback onPlanReady failed', err)
              setServerError(err instanceof Error ? err.message : String(err))
            }
          }
        }
      } catch {
        // Swallow — /progress may transiently fail; next tick will retry.
      }
    }
    tick()
    const id = window.setInterval(tick, 4000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [projectId, elementKind, elementId])

  const handleSend = async () => {
    if (!blob) {
      setServerError('No recording captured yet')
      return
    }
    setServerError(null)
    setPhase('submitting')
    try {
      if (projectId) {
        // Backend-tracked path: project-scoped voice-feedback job → polled to
        // completion → onPlanReady fires from the poller.
        await api.voiceFeedback.submit(projectId, {
          audio: blob,
          elementKind: elementKind as 'character' | 'scene' | 'prop' | 'keyframe' | 'shot',
          elementId,
          elementContext: elementContext ?? {},
        })
        setPhase('in_flight')
      } else {
        // Frontend-only path: no backend project — call TokenRouter directly,
        // synthesize a one-shot job locally, fire onPlanReady inline.
        const plan = await api.voiceFeedback.revise({
          audio: blob,
          elementKind,
          elementContext: elementContext ?? {},
        })
        const jobId = `local-${Date.now().toString(36)}`
        const synthetic = {
          job_id: jobId,
          status: 'completed' as const,
          new_prompt: plan.new_prompt,
          user_intent: plan.user_intent,
          transcript: plan.transcript,
          key_changes: plan.key_changes,
          preserve: plan.preserve,
          severity: plan.severity,
        }
        setLatestJob(synthetic)
        firedJobsRef.current.add(jobId)
        setPhase('done')
        await onPlanReadyRef.current?.({
          jobId,
          elementKind,
          elementId,
          newPrompt: plan.new_prompt,
          userIntent: plan.user_intent,
          transcript: plan.transcript,
          keyChanges: plan.key_changes,
          preserve: plan.preserve,
          severity: plan.severity,
        })
      }
      reset()
      setOpen(false)
    } catch (err) {
      setPhase('error')
      setServerError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCancelRecording = () => {
    if (state === 'recording') stop()
    reset()
    if (phase === 'submitting' || phase === 'error') setPhase('idle')
    setServerError(null)
  }

  const seconds = (durationMs / 1000).toFixed(1)
  const tooltip = label ? `Voice feedback for ${label}` : 'Voice feedback'

  const liveStatus = latestJob?.status
  const livePhase = latestJob?.phase
  const iconSize = compact ? 'w-3.5 h-3.5' : 'w-4 h-4'
  let statusIcon = <Mic className={iconSize} />
  let statusClass = 'text-muted-foreground hover:text-foreground'
  if (phase === 'submitting' || liveStatus === 'pending' || liveStatus === 'running') {
    statusIcon = <Loader2 className={cn(iconSize, 'animate-spin')} />
    statusClass = 'text-amber-300'
  } else if (liveStatus === 'completed') {
    statusIcon = <CheckCircle2 className={iconSize} />
    statusClass = 'text-emerald-400'
  } else if (liveStatus === 'failed') {
    statusIcon = <AlertCircle className={iconSize} />
    statusClass = 'text-destructive'
  }

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) handleCancelRecording() }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={tooltip}
          aria-label={tooltip}
          className={cn(
            'inline-flex items-center justify-center rounded transition-colors',
            compact ? 'p-1' : 'p-1.5',
            'bg-black/40 hover:bg-black/60 backdrop-blur',
            statusClass,
          )}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {statusIcon}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 p-3 space-y-2"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="text-xs text-muted-foreground">
          🎤 {elementKind} feedback{label ? ` · ${label}` : ''}
        </div>

        {state === 'idle' && phase !== 'submitting' && (
          <button
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded bg-primary/10 hover:bg-primary/20 text-primary text-sm"
            onClick={start}
          >
            <Mic className="w-4 h-4" /> Start recording
          </button>
        )}

        {state === 'requesting' && (
          <div className="text-xs text-muted-foreground">Requesting microphone…</div>
        )}

        {state === 'recording' && (
          <button
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded bg-red-500/15 hover:bg-red-500/25 text-red-300 text-sm animate-pulse"
            onClick={stop}
          >
            <Square className="w-4 h-4" /> Stop recording
          </button>
        )}

        {state === 'recorded' && blob && (
          <div className="space-y-2">
            <audio controls src={URL.createObjectURL(blob)} className="w-full h-8" />
            <div className="text-[10px] text-muted-foreground">
              {seconds}s · {(blob.size / 1024).toFixed(1)} KB · {blob.type}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 text-sm disabled:opacity-50"
                onClick={handleSend}
                disabled={phase === 'submitting'}
              >
                {phase === 'submitting' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Sending…</>
                ) : (
                  <><Send className="w-4 h-4" /> Send</>
                )}
              </button>
              <button
                className="inline-flex items-center justify-center gap-1 px-2 py-2 rounded hover:bg-accent text-muted-foreground text-sm"
                onClick={handleCancelRecording}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div className="text-xs text-destructive">Recorder error: {error}</div>
        )}

        {serverError && (
          <div className="text-xs text-destructive">Send failed: {serverError}</div>
        )}

        {latestJob && (
          <div className="text-[10px] text-muted-foreground border-t border-border pt-2">
            Latest job: {latestJob.job_id.slice(0, 8)} · {liveStatus ?? 'queued'}
            {livePhase ? ` · ${livePhase}` : ''}
          </div>
        )}

        {latestJob?.user_intent && (
          <div className="text-[10px] text-muted-foreground border-t border-border pt-2">
            <div className="font-medium text-foreground/80 mb-0.5">Last intent</div>
            <div className="line-clamp-2">{latestJob.user_intent}</div>
          </div>
        )}

        {latestJob?.new_prompt && (
          <div className="text-[10px] text-muted-foreground border-t border-border pt-2">
            <div className="font-medium text-foreground/80 mb-0.5">New prompt</div>
            <div className="line-clamp-3">{latestJob.new_prompt}</div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
