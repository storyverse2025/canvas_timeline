import { useRef, useEffect, useState, useCallback } from 'react'
import { Send, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './ChatMessage'
import { SkillProgress } from './SkillProgress'
import { QuickActions } from './QuickActions'
import { useChatStore } from '@/stores/chat-store'
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { streamClaude } from '@/lib/claude-client'
import { generateImage } from '@/lib/fal-client'
import { detectIntent, executeIntent } from '@/lib/chat-intent'
import { buildCanvasContext } from '@/lib/canvas-context'
import { parseAndValidateStoryboard } from '@/lib/storyboard-parser'
import { useStoryboardStore } from '@/stores/storyboard-store'
import { ensureElements, buildElementContext, type ElementInventory } from '@/lib/canvas-elements'
import { useProjectDB } from '@/stores/project-db'
import type { ClaudeMessage } from '@/lib/claude-client'

const CHAT_SYSTEM_PROMPT = `You are StoryVerse AI, a creative assistant for animated video production.
You help users create scripts, characters, scenes, keyframes, and video shots.

The user has a canvas (for visual elements) and a timeline (for shots/beats).
The current canvas state is provided in a block prefixed with "## Canvas Context" in the system message.
When the user mentions "画布" / "canvas" / "根据画布", read from that block.
You can reference canvas nodes by their short id (the 6-char prefix shown in the context) and use image URLs for image nodes, text content for text nodes.
IMPORTANT: When the user mentions any of these keywords — 分镜, 表格, storyboard, shot list, 生成分镜, 重新生成 — you MUST respond ONLY with a fenced JSON array, no explanation, no prose. Just output the JSON. Use the canvas context to fill in visual descriptions, character info, and scene details. Schema:
\`\`\`json
[
  {
    "shot_number": "S1",
    "duration": 3.5,
    "visual_description": "...",
    "visual_anchor": "visual consistency anchor (key visual elements that must stay consistent across shots)",
    "reference_image": "<canvas node short id or full image URL or empty>",
    "shot_size": "特写|近景|中景|全景|远景",
    "character1": { "image": "<canvas node short id or empty>", "description": "角色1外貌/服装描述" },
    "character2": { "image": "<canvas node short id or empty>", "description": "角色2外貌/服装描述" },
    "prop1": { "image": "<canvas node short id or empty>", "description": "道具1描述" },
    "prop2": { "image": "<canvas node short id or empty>", "description": "道具2描述" },
    "scene": { "image": "<canvas node short id or empty>", "description": "场景描述" },
    "character_actions": "...",
    "emotion_mood": "...",
    "scene_tags": "室内,夜间",
    "lighting_atmosphere": "...",
    "sound_effects": "...",
    "dialogue": "对白文本",
    "dialogue_audio": "",
    "storyboard_prompts": "english prompt for keyframe image",
    "motion_prompts": "english prompt for beat video motion",
    "bgm": "BGM description",
    "bgm_audio": ""
  }
]
\`\`\`
Required fields: shot_number (string), duration (positive number in seconds). Element slots (character1/2, prop1/2, scene) have {image, description} sub-fields. All other fields default to empty string if unknown. If a validator error is fed back, fix ONLY the listed fields and resend the complete JSON array.
When they ask you to write a script, structure it with numbered beats.

When writing scripts, use this format:
## Beat 1: Title
Narration: Scene description here.
**CharacterName**: "Dialogue line here."

When the user asks you to create visual assets, use these markers (one per line):
[IMAGE_PROMPT]: detailed english image generation prompt
[CHARACTER]: Name | english visual description for image generation
[SCENE]: Name | english visual description for image generation
[PROP]: Name | english visual description for image generation
[SFX]: Name | english sound description | duration_seconds

You can include multiple markers in one response. Each marker creates a canvas node.

Keep responses concise and actionable.`

function randomPos() {
  return { x: Math.random() * 400 + 100, y: Math.random() * 400 + 100 }
}

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages)
  const isLoading = useChatStore((s) => s.isLoading)
  const skillProgress = useChatStore((s) => s.skillProgress)
  const addMessage = useChatStore((s) => s.addMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const setIsLoading = useChatStore((s) => s.setIsLoading)
  const clearHistory = useChatStore((s) => s.clearHistory)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function processResponse(fullText: string) {
    const assetStore = useAssetStore.getState()
    const canvasStore = useCanvasStore.getState()
    const timelineStore = useTimelineStore.getState()
    const chatStore = useChatStore.getState()
    let created = 0

    function addAssetToCanvas(
      type: 'character' | 'scene' | 'prop' | 'keyframe',
      name: string,
      prompt: string
    ) {
      const assetId = assetStore.addAsset({
        type,
        name,
        prompt,
        status: 'pending',
        tags: [{ id: `t-${Date.now()}-${Math.random()}`, category: type as any, label: name }],
      })
      canvasStore.addNode(assetId, randomPos())
      return assetId
    }

    // 1. Multiple [IMAGE_PROMPT]: lines → generate images via FAL
    const imagePrompts = [...fullText.matchAll(/\[IMAGE_PROMPT\]:\s*(.+?)(?:\n|$)/gi)]
    for (const match of imagePrompts) {
      const prompt = match[1].trim()
      chatStore.addMessage('system', `Generating image: "${prompt.slice(0, 50)}..."`)
      try {
        const result = await generateImage(prompt)
        const assetId = assetStore.addAsset({
          type: 'keyframe',
          name: prompt.slice(0, 40),
          imageUrl: result.url,
          prompt,
          status: 'completed',
          tags: [],
        })
        canvasStore.addNode(assetId, randomPos())
        created++
      } catch (err) {
        chatStore.addMessage('system', `Image failed: ${err instanceof Error ? err.message : 'error'}`)
      }
    }

    // 2. [CHARACTER]: Name | description → asset + canvas node + background image gen
    const chars = [...fullText.matchAll(/\[CHARACTER\]:\s*(.+?)\s*\|\s*(.+?)(?:\n|$)/gi)]
    for (const match of chars) {
      const assetId = addAssetToCanvas('character', match[1].trim(), match[2].trim())
      created++
      generateImage(match[2].trim()).then((result) => {
        useAssetStore.getState().updateAsset(assetId, { imageUrl: result.url, status: 'completed' })
      }).catch(() => {
        useAssetStore.getState().updateAsset(assetId, { status: 'failed' })
      })
    }

    // 3. [SCENE]: Name | description → asset + canvas node + background image gen
    const scenes = [...fullText.matchAll(/\[SCENE\]:\s*(.+?)\s*\|\s*(.+?)(?:\n|$)/gi)]
    for (const match of scenes) {
      const assetId = addAssetToCanvas('scene', match[1].trim(), match[2].trim())
      created++
      generateImage(match[2].trim()).then((result) => {
        useAssetStore.getState().updateAsset(assetId, { imageUrl: result.url, status: 'completed' })
      }).catch(() => {
        useAssetStore.getState().updateAsset(assetId, { status: 'failed' })
      })
    }

    // 4. [PROP]: Name | description → asset + canvas node + background image gen
    const props = [...fullText.matchAll(/\[PROP\]:\s*(.+?)\s*\|\s*(.+?)(?:\n|$)/gi)]
    for (const match of props) {
      const assetId = addAssetToCanvas('prop', match[1].trim(), match[2].trim())
      created++
      generateImage(match[2].trim()).then((result) => {
        useAssetStore.getState().updateAsset(assetId, { imageUrl: result.url, status: 'completed' })
      }).catch(() => {
        useAssetStore.getState().updateAsset(assetId, { status: 'failed' })
      })
    }

    // 5. [SFX]: Name | description | duration → add to dialogue track in timeline
    const sfx = [...fullText.matchAll(/\[SFX\]:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(\d+)(?:\n|$)/gi)]
    for (const match of sfx) {
      const dialogueTrack = timelineStore.tracks.find((t) => t.type === 'dialogue')
      if (dialogueTrack) {
        const maxEnd = dialogueTrack.items.reduce((m, i) => Math.max(m, i.startTime + i.duration), 0)
        timelineStore.addItem(dialogueTrack.id, {
          label: match[1].trim(),
          startTime: maxEnd,
          duration: parseInt(match[3]),
        })
        created++
      }
    }

    if (created > 0) {
      chatStore.addMessage('system', `已添加 ${created} 个资产`)
    }
  }

  const sendMessage = useCallback(async (text: string) => {
    if (!text || isLoading) return
    addMessage('user', text)
    setIsLoading(true)

    try {
      // Check for intent match before calling Claude
      const intent = detectIntent(text)
      if (intent) {
        addMessage('system', `Running: ${intent.label}...`)
        try {
          await executeIntent(intent, 'test')
        } catch (err) {
          addMessage('system', `Error: ${err instanceof Error ? err.message : 'Unknown'}`)
        }
        return // skip Claude call
      }

      // Pre-process: if this is a storyboard request, classify canvas elements first
      const isStoryboardRequest = /分镜|storyboard|shot.?list|表格|生成.*表|重新生成/i.test(text)
      let elementInventory: ElementInventory | null = null
      if (isStoryboardRequest) {
        try {
          const { artDirection, script } = useProjectDB.getState()
          elementInventory = await ensureElements((msg) => addMessage('system', msg), {
            scriptText: script.text || text,
            stylePreset: artDirection.stylePreset,
            customStyle: artDirection.customStyle,
          })
        } catch (e) {
          addMessage('system', `元素分析失败: ${(e as Error).message}，继续生成…`)
        }
      }

      // Build conversation history for Claude
      const currentMessages = useChatStore.getState().messages
      const claudeMessages: ClaudeMessage[] = currentMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => m.content.length > 0)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const assistantMsgId = addMessage('assistant', '')
      let fullText = ''
      let fullThinking = ''

      const canvasCtx = buildCanvasContext()
      const elementCtx = elementInventory ? `\n\n## 已识别的画布元素\n${buildElementContext(elementInventory)}\n\nIMPORTANT: 在生成分镜表时，请将上面识别的角色、道具、场景填入每行的 character1/character2、prop1/prop2、scene 字段中。image 填入对应的图片URL，description 填入描述。` : ''
      const systemWithCtx = `${CHAT_SYSTEM_PROMPT}\n\n## Canvas Context\n${canvasCtx}${elementCtx}`

      for await (const event of streamClaude(claudeMessages, { system: systemWithCtx })) {
        switch (event.type) {
          case 'thinking':
            fullThinking += event.text
            updateMessage(assistantMsgId, { thinking: fullThinking })
            break
          case 'text':
            fullText += event.text
            updateMessage(assistantMsgId, { content: fullText })
            break
          case 'error':
            updateMessage(assistantMsgId, {
              content: fullText || `Error: ${event.text}`,
            })
            break
          case 'done':
            break
        }
      }

      // Parse structured markers from response
      await processResponse(fullText)

      // Auto-detect storyboard JSON → validate → retry on schema failure
      const STORYBOARD_TRIGGER = /分镜|storyboard|shot.?list|表格|生成.*表|重新生成/i
      const hasShotJson = /"shot_number"\s*:/.test(fullText)
      if (STORYBOARD_TRIGGER.test(text) || hasShotJson) {
        let attempt = 0
        let lastText = fullText
        let result = parseAndValidateStoryboard(lastText)
        const maxRetries = 2
        while (!result.ok && attempt < maxRetries) {
          attempt++
          addMessage('system', `分镜 schema 校验失败（第 ${attempt} 次）：${(result.errors ?? []).slice(0, 5).join('; ')} — 正在让 AI 修正…`)
          const retryMsg = `上次输出未通过 schema 校验，错误：\n${(result.errors ?? []).join('\n')}\n\n请严格按 system prompt 中的 JSON schema 重新输出完整数组，只返回 \`\`\`json 代码块，不要任何解释文本。`
          const retryMessages = [...claudeMessages, { role: 'assistant' as const, content: lastText }, { role: 'user' as const, content: retryMsg }]
          const retryMsgId = addMessage('assistant', '')
          lastText = ''
          for await (const ev of streamClaude(retryMessages, { system: systemWithCtx })) {
            if (ev.type === 'text') { lastText += ev.text; updateMessage(retryMsgId, { content: lastText }) }
            else if (ev.type === 'error') { updateMessage(retryMsgId, { content: lastText || `Error: ${ev.text}` }); break }
          }
          result = parseAndValidateStoryboard(lastText)
        }
        if (result.ok && result.rows) {
          useStoryboardStore.getState().replaceAll(result.rows)
          addMessage('system', `✓ 分镜表已生成：${result.rows.length} 行，时间轴已同步 → 切到「表格」/「时间线」查看`)
        } else {
          addMessage('system', `分镜生成失败（重试 ${attempt} 次后仍不通过）：${(result.errors ?? []).slice(0, 5).join('; ')}`)
        }
      }
    } catch (err) {
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Something went wrong'}`)
    } finally {
      setIsLoading(false)
    }
  }, [isLoading, addMessage, updateMessage, setIsLoading])

  const handleSend = async () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    await sendMessage(text)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <ScrollArea className="flex-1 p-3" ref={scrollRef as React.Ref<HTMLDivElement>}>
        <div className="space-y-3">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Processing...</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Skill Progress */}
      {skillProgress && <SkillProgress progress={skillProgress} />}

      {/* Quick Actions */}
      <QuickActions onAction={sendMessage} />

      {/* Input */}
      <div className="border-t border-border p-2">
        <div className="flex gap-1.5">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI agent..."
            className="text-xs h-8 bg-secondary/50"
            disabled={isLoading}
          />
          <Button
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
          >
            <Send className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={clearHistory}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
