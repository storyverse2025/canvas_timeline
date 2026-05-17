/**
 * Voice binding orchestrator.
 *
 * Sits between `actor-agent.castVoices` (pure LLM picker) and the canvas
 * stores. Drives the pick, persists the bindings to projectDB.script, and
 * spawns audio canvas nodes wired from each character node to its picked
 * voice — fulfilling the user request:
 *
 *   > 音色文件也自动作为音频node 出现在画布
 *
 * Re-running is idempotent: existing audio nodes are reused (URL updated
 * if the voice changed); existing edges are not duplicated.
 */

import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import { castVoices, type VoiceBindings, type VoiceCandidateSummary } from '@/lib/agents/actor-agent'
import { getVoice, shortlistForCard } from '@/lib/voice-library'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB, type PersistedCastingCard } from '@/stores/project-db'

const VOICE_NODE_ROLE = 'voice' as const

export interface CastVoicesArgs {
  castingCards: PersistedCastingCard[]
  creativeBrief?: { projectType?: string; tone?: string; genre?: string }
}

/**
 * Pick voices via actor-agent, persist to projectDB, spawn audio canvas
 * nodes per binding. Returns the bindings map even when the canvas
 * spawn fails (the binding is the durable artifact; the canvas is a
 * visualization). Throws only when the LLM picker fails fatally.
 */
export async function runCastVoicesAndSpawnAudio(args: CastVoicesArgs): Promise<VoiceBindings> {
  if (args.castingCards.length === 0) return {}

  // Prefilter on gender + age (the only signals the catalog supports
  // structurally — 4-bucket 幼儿/少年/中年/老年). Semantic match
  // against the biography happens downstream in actor-agent.castVoices,
  // which sees displayName + sampleSnippet + tags for every candidate.
  const candidatesPerCard: Record<string, VoiceCandidateSummary[]> = {}
  for (const card of args.castingCards) {
    candidatesPerCard[card.name] = shortlistForCard(
      {
        gender_presentation: card.gender_presentation,
        age_range: card.age_range,
        voice_print: card.voice_print,
      },
      40,
    ).map((v) => ({
      id: v.id,
      displayName: v.displayName,
      sampleSnippet: v.sampleSnippet,
      gender: v.gender,
      age: v.age,
      tags: v.tags,
    }))
  }

  const ctx = createMemoryContext({ llm: createCapabilityLLM() })
  const bindings = await runAgentWithChatBridge(
    'actor-agent',
    castVoices(
      {
        castingCards: args.castingCards,
        creativeBrief: args.creativeBrief,
        candidatesPerCard,
      },
      ctx,
    ),
    { verb: 'cast-voices' },
  )

  useProjectDB.getState().updateScript({ voiceBindings: bindings })

  try {
    spawnVoiceCanvasNodes(bindings)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[voice-binding] failed to spawn canvas audio nodes:', (e as Error).message)
  }

  return bindings
}

/**
 * Per-character audio canvas node. Idempotent — re-running:
 *   - reuses an existing audio item if one already exists for this
 *     character (just updates its content URL if the voice changed)
 *   - keeps a single canvas node per item
 *   - draws an edge from the character's canvas node to the audio node
 *     once, never duplicates it
 */
export function spawnVoiceCanvasNodes(bindings: VoiceBindings): void {
  const itemStore = useCanvasItemStore.getState()
  const canvas = useCanvasStore.getState()
  const projectDB = useProjectDB.getState()

  let stagger = 0
  for (const [characterName, voiceId] of Object.entries(bindings)) {
    const voice = getVoice(voiceId)
    if (!voice) continue

    const characterElement = Object.values(projectDB.elements).find(
      (el) =>
        el.kind === 'image' &&
        el.role === 'character' &&
        el.name.trim().toLowerCase() === characterName.trim().toLowerCase(),
    )

    // Find or create the audio canvas item for this character.
    const audioItemName = `${characterName} · 音色`
    const existingAudioItem = Object.values(itemStore.items).find(
      (it) => it.kind === 'audio' && it.role === VOICE_NODE_ROLE && it.name === audioItemName,
    )

    let audioItemId: string
    if (existingAudioItem) {
      audioItemId = existingAudioItem.id
      if (existingAudioItem.content !== voice.urlPath) {
        useCanvasItemStore.getState().updateItem(audioItemId, {
          content: voice.urlPath,
          description: voice.displayName,
        })
      }
    } else {
      audioItemId = useCanvasItemStore.getState().addItem({
        kind: 'audio',
        name: audioItemName,
        content: voice.urlPath,
        description: voice.displayName,
        role: VOICE_NODE_ROLE,
      })
    }

    // Find or create the canvas node for this audio item.
    const existingAudioNode = useCanvasStore.getState().nodes.find((n) => {
      const data = n.data as { itemId?: string }
      return data.itemId === audioItemId
    })

    let audioNodeId: string
    if (existingAudioNode) {
      audioNodeId = existingAudioNode.id
    } else {
      // Stack the audio nodes near the canvas origin with a vertical stagger
      // so they don't pile on top of one another.
      // Native <audio controls> needs ~320×54 min to render; 340×140
      // leaves room for the Mic header + audio bar + filename caption
      // without the play button getting squashed or clipped.
      audioNodeId = useCanvasStore.getState().addItemNode(
        audioItemId,
        'audio',
        { x: 420, y: 40 + stagger * 160 },
        { width: 340, height: 140 },
      )
      stagger++
    }

    // Wire character canvas node → audio node, if both exist on the canvas.
    if (characterElement) {
      const characterCanvasNode = useCanvasStore.getState().nodes.find((n) => {
        const data = n.data as { assetId?: string }
        return data.assetId === characterElement.id
      })
      if (characterCanvasNode) {
        const existingEdge = useCanvasStore
          .getState()
          .edges.find((e) => e.source === characterCanvasNode.id && e.target === audioNodeId)
        if (!existingEdge) {
          useCanvasStore.getState().addEdge(characterCanvasNode.id, audioNodeId)
        }
      }
    }
  }
}
