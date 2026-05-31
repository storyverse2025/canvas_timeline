import { useState } from 'react'
import { Loader2, MessageSquare, Check, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api-client'
import { cn } from '@/lib/utils'

interface Props {
  /** What kind of element the prompt is for — character / scene / prop / keyframe / shot. */
  elementKind: 'character' | 'scene' | 'prop' | 'keyframe' | 'shot'
  /** Current prompt text we're asking the AI to revise. */
  currentPrompt: string
  /** Snapshot of the element (name, description, image URL, etc.) for the LLM. */
  elementContext: Record<string, unknown>
  /** Called when the user confirms the revised prompt. */
  onApply: (newPrompt: string) => void
  /** Custom button label / size. Defaults to a compact "AI 反馈" chip. */
  compact?: boolean
  className?: string
}

/**
 * Small popover that lets the user describe a change in natural language
 * and have an LLM rewrite the current generation prompt, with a confirm
 * step before applying. Same flow as DialogEditPanel's "给 AI 反馈" tab
 * — extracted so the NodeInspector + any other prompt textarea can wire
 * it in without duplicating the state machine.
 */
export function PromptFeedbackPopover({
  elementKind,
  currentPrompt,
  elementContext,
  onApply,
  compact = true,
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [revising, setRevising] = useState(false)
  const [revisedPrompt, setRevisedPrompt] = useState<string | null>(null)
  const [userIntent, setUserIntent] = useState('')
  const [keyChanges, setKeyChanges] = useState<string[]>([])

  const handleRevise = async () => {
    if (!feedback.trim()) return
    setRevising(true)
    setRevisedPrompt(null)
    try {
      const plan = await api.voiceFeedback.textRevise({
        text: feedback.trim(),
        elementKind,
        elementContext: { ...elementContext, current_prompt: currentPrompt },
      })
      setRevisedPrompt(plan.new_prompt)
      setUserIntent(plan.user_intent || '')
      setKeyChanges(plan.key_changes ?? [])
    } catch (e) {
      toast.error('AI 改写失败', { description: String((e as Error).message).slice(0, 200) })
    } finally {
      setRevising(false)
    }
  }

  const handleApply = () => {
    if (!revisedPrompt) return
    onApply(revisedPrompt)
    setOpen(false)
    setFeedback('')
    setRevisedPrompt(null)
    setUserIntent('')
    setKeyChanges([])
    toast.success('已应用新 prompt')
  }

  const handleDiscard = () => {
    setRevisedPrompt(null)
    setUserIntent('')
    setKeyChanges([])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size={compact ? 'sm' : 'default'}
          className={cn(compact && 'h-5 text-[10px] px-2 gap-1', className)}
          title="给 AI 自然语言反馈，让它帮你改写 prompt"
        >
          <MessageSquare className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
          AI 反馈
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-3 space-y-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[10px] text-muted-foreground uppercase">
          告诉 AI 你想怎么改 ({elementKind})
        </div>
        <textarea
          className="w-full min-h-[70px] text-xs bg-background border border-border rounded px-2 py-1.5 outline-none resize-y"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="例: 角色应该更愤怒一些；背景灯光太亮了"
          disabled={revising}
        />
        {!revisedPrompt && (
          <Button
            size="sm"
            className="w-full h-7 text-xs gap-1.5"
            disabled={revising || !feedback.trim()}
            onClick={handleRevise}
          >
            {revising ? <Loader2 className="w-3 h-3 animate-spin" /> : <MessageSquare className="w-3 h-3" />}
            AI 改写 prompt
          </Button>
        )}
        {revisedPrompt && (
          <div className="space-y-2 rounded border border-emerald-700/40 bg-emerald-950/20 p-2">
            {userIntent && (
              <div className="text-[10px] text-emerald-300/80">
                <strong>AI 理解:</strong> {userIntent}
              </div>
            )}
            <div className="text-[10px] text-muted-foreground">
              <strong>改写后的 prompt:</strong>
            </div>
            <div className="text-[11px] text-foreground/90 max-h-40 overflow-auto whitespace-pre-wrap">
              {revisedPrompt}
            </div>
            {keyChanges.length > 0 && (
              <div className="text-[10px] text-muted-foreground">
                <strong>关键改动:</strong>
                <ul className="list-disc list-inside">
                  {keyChanges.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                className="flex-1 h-7 text-xs gap-1.5"
                onClick={handleApply}
              >
                <Check className="w-3 h-3" />
                采用
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={handleDiscard}
                title="重新写反馈"
              >
                <RotateCcw className="w-3 h-3" />
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
