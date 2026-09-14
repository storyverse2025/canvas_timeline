/**
 * Character design orchestrator.
 *
 * Sits between art-director's character extraction and art-director's
 * character-image generation. For each ExtractedCharacter:
 *
 *   1. Drives actor-agent.designCharacters → biography + 7-pillar
 *      appearance + composed image-prompt.
 *   2. Persists biography + appearance_pillars + appearance_prompt onto
 *      the matching casting card (projectDB.script.castingCards).
 *   3. Returns the extraction with each character's `image_prompt`
 *      replaced by the actor-built `appearance_prompt`, so art-director's
 *      image generator sees the richer description.
 *
 * Spawning the canvas text nodes is a separate step the caller runs
 * AFTER the image generation, so it can wire edges from the character's
 * image node to its biography/appearance text nodes (see
 * spawnCharacterBioCanvasNodes).
 */

import { runAgentWithChatBridge } from '@/lib/agents/chat-bridge'
import { createMemoryContext } from '@/lib/agents/_shared/context/memory'
import { createCapabilityLLM } from '@/lib/agents/_shared/llm/capability'
import {
  designCharacters,
  type CharacterDesigns,
  type ExtractedCharacterInput,
} from '@/lib/agents/actor-agent'
import { styleFragmentFor } from '@/lib/style-library'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useProjectDB, type PersistedCastingCard } from '@/stores/project-db'

const CHARACTER_TEXT_NODE_ROLE = 'character-bio' as const

export interface RunDesignCharactersArgs {
  extractedCharacters: ExtractedCharacterInput[]
}

export interface RunDesignCharactersResult {
  /** Mirror of input but every character has the actor-built appearance_prompt
   *  in image_prompt (untouched when the actor LLM skipped that character). */
  augmentedExtraction: ExtractedCharacterInput[]
  /** Designs keyed by character name — for caller to inspect / log. */
  designsByName: Record<string, CharacterDesigns[number]>
}

/**
 * Run actor-agent.designCharacters + persist results. Failures here are
 * non-fatal at the call site (director-assistant logs + continues with the
 * original prompts); this helper rethrows so the caller can decide.
 */
export async function runDesignCharactersAndPersist(
  args: RunDesignCharactersArgs,
): Promise<RunDesignCharactersResult> {
  if (args.extractedCharacters.length === 0) {
    return { augmentedExtraction: [], designsByName: {} }
  }

  const db = useProjectDB.getState()
  const castingCards = db.script.castingCards ?? []
  const creativeBrief = db.script.creativeBrief

  // visualStyle hint: prefer the user's free-form override, else the style
  // library's preset goal line.
  const visualStyle = (db.artDirection.customStyle || '').trim() ||
    styleFragmentFor(db.artDirection.stylePreset)

  // freeform-text, not the default element-extraction — designCharacters
  // ships a complete prompt and returns a rich JSON array; routing it
  // through element-extraction's domain system prompt risks the same
  // 角色/场景/道具 hijack that broke cast-voices. See voice-binding.ts.
  const ctx = createMemoryContext({ llm: createCapabilityLLM({ capabilityId: 'freeform-text' }) })
  const designs = await runAgentWithChatBridge(
    'actor-agent',
    designCharacters(
      {
        extractedCharacters: args.extractedCharacters,
        castingCards,
        creativeBrief,
        visualStyle,
      },
      ctx,
    ),
    { verb: 'design-characters' },
  )

  const designsByName = Object.fromEntries(designs.map((d) => [d.name, d]))

  // Persist biography + appearance onto matching casting cards (merge — leave
  // unmatched cards untouched so the rest of the dossier survives intact).
  const updatedCards: PersistedCastingCard[] = castingCards.map((card) => {
    const d = designsByName[card.name]
    if (!d) return card
    return {
      ...card,
      biography: d.biography,
      appearance_pillars: d.appearance_pillars,
      appearance_prompt: d.appearance_prompt,
    }
  })

  // For characters who had a design but no matching casting card (rare —
  // art-director sometimes extracts side characters the dossier didn't
  // name), synthesize a minimal card so they still show up in 演员表/UI.
  const existingNames = new Set(updatedCards.map((c) => c.name.toLowerCase()))
  for (const d of designs) {
    if (!existingNames.has(d.name.toLowerCase())) {
      updatedCards.push({
        name: d.name,
        biography: d.biography,
        appearance_pillars: d.appearance_pillars,
        appearance_prompt: d.appearance_prompt,
      })
    }
  }
  useProjectDB.getState().updateScript({ castingCards: updatedCards })

  const augmentedExtraction: ExtractedCharacterInput[] = args.extractedCharacters.map((c) => {
    const d = designsByName[c.name]
    if (!d) return c
    return { ...c, image_prompt: d.appearance_prompt }
  })

  return { augmentedExtraction, designsByName }
}

/**
 * Per-character biography + appearance text canvas node, wired from the
 * character's image node when one exists. Idempotent:
 *   - reuses an existing text item if one's already there for this character
 *   - updates content when biography or appearance changed
 *   - never duplicates the canvas node / edge
 *
 * Call this AFTER the character image nodes have been created (so the
 * edge has somewhere to attach).
 */
export function spawnCharacterBioCanvasNodes(): void {
  const projectDB = useProjectDB.getState()
  const castingCards = projectDB.script.castingCards ?? []
  if (castingCards.length === 0) return

  let stagger = 0
  for (const card of castingCards) {
    if (!card.biography && !card.appearance_prompt) continue
    const textItemName = `${card.name} · 人物小传与外貌`
    const content = formatCharacterBioBody(card)

    const existing = Object.values(useCanvasItemStore.getState().items).find(
      (it) =>
        it.kind === 'text' && it.role === CHARACTER_TEXT_NODE_ROLE && it.name === textItemName,
    )

    let textItemId: string
    if (existing) {
      textItemId = existing.id
      if (existing.content !== content) {
        useCanvasItemStore.getState().updateItem(textItemId, { content })
      }
    } else {
      textItemId = useCanvasItemStore.getState().addItem({
        kind: 'text',
        name: textItemName,
        content,
        role: CHARACTER_TEXT_NODE_ROLE,
      })
    }

    const existingTextNode = useCanvasStore.getState().nodes.find((n) => {
      const data = n.data as { itemId?: string }
      return data.itemId === textItemId
    })
    let textNodeId: string
    if (existingTextNode) {
      textNodeId = existingTextNode.id
    } else {
      // Place the bio text nodes to the LEFT of the character images so the
      // text is upstream (NodeEditPanel.regenerate's gatherUpstream then
      // pulls the bio content into the regen prompt). LR auto-layout
      // keeps the arrow pointing right (text → image).
      // Character images spawn at x=50 width=200; bio width 320 + 40 gap →
      // bio.x = 50 - 320 - 40 = -310.
      textNodeId = useCanvasStore.getState().addItemNode(
        textItemId,
        'text',
        { x: -310, y: 50 + stagger * 240 },
        { width: 320, height: 220 },
      )
      stagger++
    }

    // Wire bio text → character image so the bio is UPSTREAM of the
    // image. The image's NodeEditPanel.regenerate now pulls the bio's
    // text via gatherUpstream so the latest bio content always feeds the
    // next regeneration. Character image canvas items live in
    // useCanvasItemStore — lookup by role + name.
    const items = useCanvasItemStore.getState().items
    const characterItem = Object.values(items).find(
      (it) =>
        it.kind === 'image' &&
        it.role === 'character' &&
        it.name.trim().toLowerCase() === card.name.trim().toLowerCase(),
    )
    if (characterItem) {
      const charNode = useCanvasStore.getState().nodes.find((n) => {
        const data = n.data as { itemId?: string }
        return data.itemId === characterItem.id
      })
      if (charNode) {
        // Migrate any pre-existing reverse edge (image → text) — older
        // sessions wired it the wrong way before this fix.
        const reverseEdgeId = useCanvasStore
          .getState()
          .edges.find((e) => e.source === charNode.id && e.target === textNodeId)?.id
        if (reverseEdgeId) {
          useCanvasStore.getState().setEdges(
            useCanvasStore.getState().edges.filter((e) => e.id !== reverseEdgeId),
          )
        }
        const existingEdge = useCanvasStore
          .getState()
          .edges.find((e) => e.source === textNodeId && e.target === charNode.id)
        if (!existingEdge) {
          useCanvasStore.getState().addEdge(textNodeId, charNode.id)
        }
      }
    }

    // Wire bio text → voice audio node so the bio (which carries the
    // voice_print line and biographical tone cues) is visibly upstream
    // of the cast voice. voice-binding.spawnVoiceCanvasNodes runs BEFORE
    // bio spawn in director-assistant, so the audio item already exists
    // by the time we get here. Idempotent: skip when the edge is in place.
    const voiceItem = Object.values(items).find(
      (it) =>
        it.kind === 'audio' &&
        it.role === 'voice' &&
        it.name === `${card.name} · 音色`,
    )
    if (voiceItem) {
      const voiceNode = useCanvasStore.getState().nodes.find((n) => {
        const data = n.data as { itemId?: string }
        return data.itemId === voiceItem.id
      })
      if (voiceNode) {
        const existingEdge = useCanvasStore
          .getState()
          .edges.find((e) => e.source === textNodeId && e.target === voiceNode.id)
        if (!existingEdge) {
          useCanvasStore.getState().addEdge(textNodeId, voiceNode.id)
        }
      }
    }
  }
}

/**
 * Compose the on-canvas text body for one character: biography first,
 * then the 7 pillars in order, then the composed appearance prompt as
 * a final block users can copy verbatim into a generation request.
 */
export function formatCharacterBioBody(card: PersistedCastingCard): string {
  const sections: string[] = []
  sections.push(`# ${card.name}`)
  if (card.dramatic_function) sections.push(`戏剧功能: ${card.dramatic_function}`)
  if (card.voice_print) sections.push(`声纹: ${card.voice_print}`)
  if (card.biography) {
    sections.push('')
    sections.push('## 人物小传')
    sections.push(card.biography)
  }
  if (card.appearance_pillars) {
    sections.push('')
    sections.push('## 外貌 (7-pillar)')
    const p = card.appearance_pillars
    sections.push(`1 主体 — ${p.subject}`)
    sections.push(`2 骨相结构 — ${p.bone_structure}`)
    sections.push(`3 五官特征 — ${p.features}`)
    sections.push(`4 面部神态 — ${p.expression}`)
    sections.push(`5 材质光影 — ${p.texture_light}`)
    sections.push(`6 画质修饰 — ${p.quality}`)
    sections.push(`7 防 AI — ${p.anti_ai}`)
  }
  if (card.appearance_prompt) {
    sections.push('')
    sections.push('## 拼好的图像 prompt (可复制)')
    sections.push(card.appearance_prompt)
  }
  return sections.join('\n')
}
