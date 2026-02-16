import { useRef, useEffect, useState, useCallback } from 'react'
import { Send, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from './ChatMessage'
import { SkillProgress } from './SkillProgress'
import { useChatStore } from '@/stores/chat-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { streamClaude } from '@/lib/claude-client'
import { generateImage } from '@/lib/fal-client'
import type { ClaudeMessage } from '@/lib/claude-client'
import type { VisualAssetNodeData } from '@/types/canvas'

const CHAT_SYSTEM_PROMPT = `You are StoryVerse AI, a creative assistant for animated video production.
You help users create scripts, characters, scenes, keyframes, and video shots.

The user has a canvas (for visual elements) and a timeline (for shots/beats).
When they ask you to write a script, structure it with numbered beats.

When writing scripts, use this format:
## Beat 1: Title
Narration: Scene description here.
**CharacterName**: "Dialogue line here."

When generating image prompts, prefix with [IMAGE_PROMPT]: followed by the English prompt.

Keep responses concise and actionable.`

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages)
  const isLoading = useChatStore((s) => s.isLoading)
  const skillProgress = useChatStore((s) => s.skillProgress)
  const addMessage = useChatStore((s) => s.addMessage)
  const updateMessage = useChatStore((s) => s.updateMessage)
  const setIsLoading = useChatStore((s) => s.setIsLoading)
  const clearHistory = useChatStore((s) => s.clearHistory)
  const addNode = useCanvasStore((s) => s.addNode)
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const sendMessage = useCallback(async (text: string) => {
    if (!text || isLoading) return
    addMessage('user', text)
    setIsLoading(true)

    try {
      // Build conversation history for Claude
      const currentMessages = useChatStore.getState().messages
      const claudeMessages: ClaudeMessage[] = currentMessages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .filter((m) => m.content.length > 0)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

      const assistantMsgId = addMessage('assistant', '')
      let fullText = ''
      let fullThinking = ''

      for await (const event of streamClaude(claudeMessages, { system: CHAT_SYSTEM_PROMPT })) {
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

      // Check if Claude suggested an image generation prompt
      const imagePromptMatch = fullText.match(/\[IMAGE_PROMPT\]:\s*(.+?)(?:\n|$)/i)
      if (imagePromptMatch) {
        const imagePrompt = imagePromptMatch[1].trim()
        addMessage('system', `Generating image: "${imagePrompt}"...`)
        try {
          const result = await generateImage(imagePrompt)
          const nodeId = addNode('visual', {
            assetType: 'keyframe',
            imageUrl: result.url,
            label: imagePrompt.slice(0, 40),
            prompt: imagePrompt,
            tags: [],
          } as VisualAssetNodeData, { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 })
          addMessage('system', `Image generated and added to canvas (node ${nodeId.slice(0, 8)})`)
        } catch (err) {
          addMessage('system', `Image generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
        }
      }
    } catch (err) {
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Something went wrong'}`)
    } finally {
      setIsLoading(false)
    }
  }, [isLoading, addMessage, updateMessage, setIsLoading, addNode])

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
