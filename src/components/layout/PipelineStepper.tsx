import { useState, useCallback, useRef, useEffect } from 'react'
import { Check, Loader2, Play, RotateCcw, FileText, Users, Image, Music, Film, Scissors, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  initPipeline,
  clearPipeline,
  getPipelineContext,
  generateStep1_Script,
  generateStep2_Assets,
  generateStep3_Keyframes,
  generateStep4_Audio,
  generateStep5_VideoShots,
  generateStep6_FinalEdit,
} from '@/lib/pipeline-generator'
import { isBackendAvailable } from '@/lib/api'
import { useChatStore } from '@/stores/chat-store'

type StepStatus = 'pending' | 'running' | 'done' | 'error'

interface Step {
  label: string
  icon: React.ElementType
  fn: () => Promise<unknown>
}

const steps: Step[] = [
  { label: 'Script', icon: FileText, fn: generateStep1_Script },
  { label: 'Assets', icon: Users, fn: generateStep2_Assets },
  { label: 'Keyframes', icon: Image, fn: generateStep3_Keyframes },
  { label: 'Audio', icon: Music, fn: generateStep4_Audio },
  { label: 'Video', icon: Film, fn: generateStep5_VideoShots },
  { label: 'Edit', icon: Scissors, fn: generateStep6_FinalEdit },
]

export function PipelineStepper() {
  const [statuses, setStatuses] = useState<StepStatus[]>(steps.map(() => 'pending'))
  const [running, setRunning] = useState(false)
  const [concept, setConcept] = useState('仙逆 - 王林以借命之术逆天改命')
  const [editingConcept, setEditingConcept] = useState(false)
  const [backendUp, setBackendUp] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Check backend on mount
  useEffect(() => {
    isBackendAvailable().then(setBackendUp)
  }, [])

  const ensureInit = useCallback(() => {
    if (!getPipelineContext()) {
      initPipeline(concept)
    }
  }, [concept])

  const runStep = useCallback(async (index: number) => {
    if (running) return
    ensureInit()
    setRunning(true)
    setStatuses((prev) => prev.map((s, i) => (i === index ? 'running' : s)))
    try {
      await steps[index].fn()
      setStatuses((prev) => prev.map((s, i) => (i === index ? 'done' : s)))
    } catch (err) {
      setStatuses((prev) => prev.map((s, i) => (i === index ? 'error' : s)))
      useChatStore.getState().addMessage('system', `Step ${index + 1} error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setRunning(false)
    }
  }, [running, ensureInit])

  const runAll = useCallback(async () => {
    if (running) return
    ensureInit()
    setRunning(true)
    for (let i = 0; i < steps.length; i++) {
      setStatuses((prev) => prev.map((s, j) => (j === i ? 'running' : s)))
      try {
        await steps[i].fn()
        setStatuses((prev) => prev.map((s, j) => (j === i ? 'done' : s)))
      } catch (err) {
        setStatuses((prev) => prev.map((s, j) => (j === i ? 'error' : s)))
        useChatStore.getState().addMessage('system', `Pipeline stopped at step ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`)
        break
      }
    }
    setRunning(false)
  }, [running, ensureInit])

  const handleReset = useCallback(() => {
    clearPipeline()
    setStatuses(steps.map(() => 'pending'))
  }, [])

  const handleConceptSubmit = useCallback(() => {
    setEditingConcept(false)
    if (getPipelineContext()) {
      clearPipeline()
      setStatuses(steps.map(() => 'pending'))
    }
    initPipeline(concept)
  }, [concept])

  return (
    <div className="flex items-center gap-1">
      {/* Backend status dot */}
      <div
        className={`w-2 h-2 rounded-full shrink-0 ${
          backendUp === null ? 'bg-muted-foreground/40' :
          backendUp ? 'bg-green-500' : 'bg-red-500/60'
        }`}
        title={
          backendUp === null ? 'Checking backend...' :
          backendUp ? 'Backend connected' : 'Using local AI'
        }
      />

      {/* Concept input */}
      {editingConcept ? (
        <Input
          ref={inputRef}
          value={concept}
          onChange={(e) => setConcept(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleConceptSubmit()
            if (e.key === 'Escape') setEditingConcept(false)
          }}
          onBlur={handleConceptSubmit}
          className="h-7 w-48 text-[10px]"
          placeholder="Story concept..."
          autoFocus
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[10px] gap-1 px-2 max-w-[140px] truncate"
          onClick={() => setEditingConcept(true)}
          disabled={running}
          title={concept}
        >
          <Pencil className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{concept.slice(0, 15)}...</span>
        </Button>
      )}

      <div className="h-5 w-px bg-border mx-0.5" />

      {/* Step buttons */}
      {steps.map((step, i) => {
        const status = statuses[i]
        const Icon = step.icon
        return (
          <div key={step.label} className="flex items-center">
            <Button
              variant={status === 'done' ? 'default' : status === 'error' ? 'destructive' : 'outline'}
              size="sm"
              className="h-7 text-[10px] gap-1 px-2"
              onClick={() => runStep(i)}
              disabled={running}
              title={`Step ${i + 1}: ${step.label}`}
            >
              {status === 'running' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : status === 'done' ? (
                <Check className="w-3 h-3" />
              ) : (
                <Icon className="w-3 h-3" />
              )}
              <span className="hidden lg:inline">{step.label}</span>
              <span className="lg:hidden">{i + 1}</span>
            </Button>
            {i < steps.length - 1 && (
              <div className={`w-3 h-px mx-0.5 ${status === 'done' ? 'bg-primary' : 'bg-border'}`} />
            )}
          </div>
        )
      })}

      <div className="h-5 w-px bg-border mx-1" />

      <Button
        variant="outline"
        size="sm"
        className="h-7 text-[10px] gap-1 px-2"
        onClick={runAll}
        disabled={running}
        title="Run all steps sequentially"
      >
        <Play className="w-3 h-3" />
        <span className="hidden lg:inline">All</span>
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-[10px] gap-1 px-2"
        onClick={handleReset}
        disabled={running}
        title="Reset pipeline and clear canvas"
      >
        <RotateCcw className="w-3 h-3" />
      </Button>
    </div>
  )
}
