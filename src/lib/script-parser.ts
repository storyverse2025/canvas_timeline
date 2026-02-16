import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { useMappingStore } from '@/stores/mapping-store'
import { extractJson } from '@/lib/pipeline-generator'
import type { ScriptNodeData } from '@/types/canvas'

export interface ParsedBeat {
  number: number
  title?: string
  narration?: string
  dialogues: { speaker: string; text: string; emotion?: string }[]
}

/**
 * Parse Claude's script response text into structured beats.
 * Tries JSON first (pipeline-format responses), then falls back to markdown patterns.
 */
export function parseScriptResponse(text: string): ParsedBeat[] {
  // Try JSON first (pipeline-format responses)
  try {
    const json = extractJson(text)
    const parsed = JSON.parse(json)
    if (parsed.beats && Array.isArray(parsed.beats)) {
      return parsed.beats.map((b: { number: number; title?: string; narration?: string; dialogues?: { speaker: string; text: string }[] }) => ({
        number: b.number,
        title: b.title,
        narration: b.narration,
        dialogues: (b.dialogues || []).map((d) => ({ speaker: d.speaker, text: d.text })),
      }))
    }
  } catch { /* not JSON, try markdown patterns */ }

  const beats: ParsedBeat[] = []

  // Split by beat/section markers: "Beat 1", "**Beat 1**", "### Beat 1", "## Beat 1:", "1.", "**1."
  const beatPattern = /(?:^|\n)(?:#{1,4}\s*)?(?:\*\*)?(?:Beat|Scene|Shot)\s*(\d+)[:\s\-–—]*(?:\*\*)?(?:[:\s\-–—]*)(.*)$/gim
  const numberedPattern = /(?:^|\n)(?:#{1,4}\s*)?(?:\*\*)?(\d+)[\.\)]\s*(?:\*\*)?(?:[:\s\-–—]*)(.*)$/gm

  // Try beat-style patterns first
  let matches = [...text.matchAll(beatPattern)]
  if (matches.length === 0) {
    matches = [...text.matchAll(numberedPattern)]
  }

  if (matches.length === 0) {
    // Fallback: treat the whole text as one beat
    const dialogues = extractDialogues(text)
    const narration = extractNarration(text, dialogues)
    if (dialogues.length > 0 || narration) {
      beats.push({ number: 1, narration, dialogues })
    }
    return beats
  }

  // Process each beat section
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const beatNum = parseInt(match[1])
    const title = match[2]?.trim() || undefined

    // Get the text between this match and the next
    const startIdx = match.index! + match[0].length
    const endIdx = i < matches.length - 1 ? matches[i + 1].index! : text.length
    const section = text.slice(startIdx, endIdx)

    const dialogues = extractDialogues(section)
    const narration = extractNarration(section, dialogues)

    beats.push({
      number: beatNum,
      title,
      narration,
      dialogues,
    })
  }

  return beats
}

function extractDialogues(text: string): { speaker: string; text: string; emotion?: string }[] {
  const dialogues: { speaker: string; text: string; emotion?: string }[] = []

  // Match patterns like:
  // **Character**: "text" or **Character** (emotion): "text"
  // Character: "text"
  // > **Character**: text
  const patterns = [
    /(?:>?\s*)?(?:\*\*)?([A-Z][a-zA-Z\s]{1,20})(?:\*\*)?(?:\s*\(([^)]+)\))?\s*:\s*"?([^"\n]+)"?/g,
    /(?:>?\s*)?(?:\*\*)?([A-Z][a-zA-Z\s]{1,20})(?:\*\*)?(?:\s*\[([^\]]+)\])?\s*:\s*"?([^"\n]+)"?/g,
  ]

  // Words that are NOT character names
  const skipWords = new Set([
    'beat', 'scene', 'shot', 'narration', 'narrator', 'action', 'direction',
    'description', 'setting', 'visual', 'audio', 'note', 'camera', 'duration',
    'dialogue', 'emotion', 'the', 'image', 'prompt', 'title',
  ])

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(text)) !== null) {
      const speaker = match[1].trim()
      if (skipWords.has(speaker.toLowerCase())) continue
      if (speaker.length < 2 || speaker.length > 25) continue

      dialogues.push({
        speaker,
        text: match[3].trim().replace(/^["']|["']$/g, ''),
        emotion: match[2]?.trim(),
      })
    }
  }

  // Deduplicate
  const seen = new Set<string>()
  return dialogues.filter((d) => {
    const key = `${d.speaker}:${d.text}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function extractNarration(text: string, dialogues: { speaker: string; text: string }[]): string | undefined {
  // Look for explicit narration markers
  const narrationPatterns = [
    /(?:narration|narrator|description|setting|action|visual)[:\s]*["\s]*([^"\n]{10,})/gi,
    /\*([^*]{15,})\*/g, // italic text as narration
    />\s*([^>\n]{15,})/g, // blockquoted text
  ]

  for (const pattern of narrationPatterns) {
    const match = pattern.exec(text)
    if (match) {
      const narr = match[1].trim()
      // Make sure it's not a dialogue line
      if (!dialogues.some((d) => narr.includes(d.text))) {
        return narr
      }
    }
  }

  // Fallback: first substantial line that isn't a dialogue
  const dialogueTexts = new Set(dialogues.map((d) => d.text))
  const lines = text.split('\n').map((l) => l.replace(/^[#*>\-\s]+/, '').trim()).filter((l) => l.length > 15)
  for (const line of lines) {
    if (!dialogueTexts.has(line) && !line.includes(':') && !line.startsWith('Beat') && !line.startsWith('[')) {
      return line
    }
  }

  return undefined
}

/**
 * Map parsed beats to canvas nodes and timeline shots.
 * Returns { nodeCount, shotCount } for user feedback.
 */
export function mapBeatsToCanvas(beats: ParsedBeat[]): { nodeCount: number; shotCount: number } {
  const canvasStore = useCanvasStore.getState()
  const timelineStore = useTimelineStore.getState()
  const mappingStore = useMappingStore.getState()

  let nodeCount = 0
  let shotCount = 0

  for (const beat of beats) {
    // Create a shot for this beat (12s default, clamped to 5-15)
    const shotId = timelineStore.addShot(
      beat.title ? `Beat ${beat.number}: ${beat.title}` : `Beat ${beat.number}`,
      12
    )
    shotCount++

    const yBase = (beat.number - 1) * 180

    // Create narration node
    if (beat.narration) {
      const nodeId = canvasStore.addNode('script', {
        scriptType: 'narration',
        content: beat.narration,
        beatNumber: beat.number,
        tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beat.number}` }],
      } as ScriptNodeData, { x: 0, y: yBase })
      nodeCount++

      timelineStore.linkNodeToShot(shotId, nodeId)
      mappingStore.addLinkToShot(nodeId, shotId)
    }

    // Create dialogue nodes
    for (let i = 0; i < beat.dialogues.length; i++) {
      const dlg = beat.dialogues[i]
      const nodeId = canvasStore.addNode('script', {
        scriptType: 'dialogue',
        content: dlg.text,
        characterName: dlg.speaker,
        beatNumber: beat.number,
        tags: [
          { id: `t-${Date.now()}-${Math.random()}`, category: 'character', label: dlg.speaker },
          { id: `t-${Date.now()}-${Math.random()}`, category: 'beat', label: `Beat ${beat.number}` },
        ],
      } as ScriptNodeData, { x: 280 + i * 280, y: yBase })
      nodeCount++

      timelineStore.linkNodeToShot(shotId, nodeId)
      mappingStore.addLinkToShot(nodeId, shotId)
    }
  }

  return { nodeCount, shotCount }
}
