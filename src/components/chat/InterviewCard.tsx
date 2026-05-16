/**
 * Renders an agent's interview Question (from the agent runtime protocol)
 * as a structured card: question text, recommended option highlighted,
 * radio/checkbox options, plus a free-text "Other" input.
 *
 * Lives in src/components/chat/ because Phase 2 wires it into ChatPanel,
 * but it's a pure presentational component — no chat store coupling.
 */

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import type { Answer, Question } from '@/lib/agents/_shared/runtime/types'

interface InterviewCardProps {
  question: Question
  /** Short chip label shown above the title, e.g. agent slug. */
  askedBy?: string
  onSubmit(answer: Answer): void
  /** When true, the form locks and shows the chosen answer. */
  submitted?: boolean
  submittedAnswer?: Answer
}

const OTHER_VALUE = '__other__'

export function InterviewCard({
  question,
  askedBy,
  onSubmit,
  submitted,
  submittedAnswer,
}: InterviewCardProps) {
  const initialSelected = useMemo<string[]>(() => {
    if (submittedAnswer) return submittedAnswer.selected
    return question.recommended ? [question.recommended] : []
  }, [question, submittedAnswer])

  const [selected, setSelected] = useState<string[]>(initialSelected)
  const [otherText, setOtherText] = useState<string>(submittedAnswer?.text ?? '')

  const isMulti = question.multiSelect ?? false
  const otherChecked = selected.includes(OTHER_VALUE)

  function toggleMulti(value: string, checked: boolean) {
    setSelected((prev) => {
      if (checked) return prev.includes(value) ? prev : [...prev, value]
      return prev.filter((v) => v !== value)
    })
  }

  function handleSubmit() {
    const chosen = selected.filter((v) => v !== OTHER_VALUE)
    const answer: Answer = { selected: chosen }
    if (otherChecked && otherText.trim().length > 0) answer.text = otherText.trim()
    // Allow a free-text-only answer even when no options were picked.
    if (chosen.length === 0 && !otherChecked && otherText.trim().length > 0) {
      answer.text = otherText.trim()
    }
    onSubmit(answer)
  }

  const canSubmit = !submitted && (selected.length > 0 || otherText.trim().length > 0)

  return (
    <Card className="border-blue-200 bg-blue-50/40 dark:border-blue-900 dark:bg-blue-950/30">
      <CardHeader className="pb-3">
        {(askedBy || question.header) && (
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            {askedBy && <span>{askedBy} asks</span>}
            {question.header && (
              <span className="rounded bg-muted px-2 py-0.5 text-[10px]">{question.header}</span>
            )}
          </div>
        )}
        <CardTitle className="text-base font-medium leading-snug">{question.q}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isMulti
          ? renderCheckboxes(question, selected, toggleMulti, submitted)
          : renderRadios(question, selected[0] ?? '', (v) => setSelected([v]), submitted)}

        <div className="flex items-start gap-2 pt-1">
          {isMulti ? (
            <Checkbox
              id="iv-other"
              checked={otherChecked}
              onCheckedChange={(c) => toggleMulti(OTHER_VALUE, c === true)}
              disabled={submitted}
            />
          ) : (
            <RadioOtherToggle
              checked={otherChecked}
              onChange={(c) => setSelected(c ? [OTHER_VALUE] : [])}
              disabled={submitted}
            />
          )}
          <div className="flex-1">
            <Label htmlFor="iv-other-text" className="text-xs text-muted-foreground">
              Other
            </Label>
            <Input
              id="iv-other-text"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder="Free-text answer…"
              disabled={submitted}
              className="mt-1"
            />
          </div>
        </div>

        {!submitted && (
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              Submit
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function renderRadios(
  question: Question,
  value: string,
  onChange: (v: string) => void,
  disabled?: boolean,
) {
  return (
    <RadioGroup value={value} onValueChange={onChange} disabled={disabled} className="space-y-2">
      {question.options.map((opt) => {
        const isRec = question.recommended === opt.value
        return (
          <div key={opt.value} className="flex items-start gap-2">
            <RadioGroupItem id={`iv-${opt.value}`} value={opt.value} className="mt-1" />
            <Label htmlFor={`iv-${opt.value}`} className="flex-1 cursor-pointer leading-snug">
              <span className="font-medium">{opt.label}</span>
              {isRec && (
                <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900 dark:text-blue-200">
                  Recommended
                </span>
              )}
              {opt.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>
              )}
            </Label>
          </div>
        )
      })}
    </RadioGroup>
  )
}

function renderCheckboxes(
  question: Question,
  selected: string[],
  onToggle: (v: string, checked: boolean) => void,
  disabled?: boolean,
) {
  return (
    <div className="space-y-2">
      {question.options.map((opt) => {
        const isRec = question.recommended === opt.value
        const isChecked = selected.includes(opt.value)
        return (
          <div key={opt.value} className="flex items-start gap-2">
            <Checkbox
              id={`iv-${opt.value}`}
              checked={isChecked}
              onCheckedChange={(c) => onToggle(opt.value, c === true)}
              disabled={disabled}
              className="mt-1"
            />
            <Label htmlFor={`iv-${opt.value}`} className="flex-1 cursor-pointer leading-snug">
              <span className="font-medium">{opt.label}</span>
              {isRec && (
                <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700 dark:bg-blue-900 dark:text-blue-200">
                  Recommended
                </span>
              )}
              {opt.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{opt.description}</span>
              )}
            </Label>
          </div>
        )
      })}
    </div>
  )
}

function RadioOtherToggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (c: boolean) => void
  disabled?: boolean
}) {
  return (
    <input
      type="radio"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="mt-1.5 h-4 w-4 cursor-pointer"
    />
  )
}
