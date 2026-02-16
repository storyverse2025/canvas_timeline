import { useState, useCallback } from 'react'
import { User, Bot, Cog, ChevronDown, ChevronRight, Brain, LayoutGrid } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { ActionCard } from './ActionCard'
import { parseScriptResponse, mapBeatsToCanvas } from '@/lib/script-parser'
import { useChatStore } from '@/stores/chat-store'
import type { ChatMessage as ChatMessageType } from '@/types/chat'

interface ChatMessageProps {
  message: ChatMessageType
}

export function ChatMessage({ message }: ChatMessageProps) {
  const [showThinking, setShowThinking] = useState(false)
  const [mapped, setMapped] = useState(false)
  const addMessage = useChatStore((s) => s.addMessage)

  const handleMapToCanvas = useCallback(() => {
    const beats = parseScriptResponse(message.content)
    if (beats.length === 0) {
      addMessage('system', 'Could not parse any beats from this message. Try asking Claude for a structured script with numbered beats.')
      return
    }
    const { nodeCount, shotCount } = mapBeatsToCanvas(beats)
    addMessage('system', `Mapped ${beats.length} beats → ${nodeCount} canvas nodes + ${shotCount} timeline shots`)
    setMapped(true)
  }, [message.content, addMessage])

  if (message.role === 'system') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground py-1">
        <Cog className="w-3 h-3" />
        <span>{message.content}</span>
      </div>
    )
  }

  if (message.role === 'action' && message.action) {
    return <ActionCard action={message.action} content={message.content} />
  }

  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const hasContent = message.content.length > 50

  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
        isUser ? 'bg-primary/20' : 'bg-violet-500/20'
      }`}>
        {isUser ? (
          <User className="w-3 h-3 text-primary" />
        ) : (
          <Bot className="w-3 h-3 text-violet-400" />
        )}
      </div>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
        isUser
          ? 'bg-primary/20 text-foreground'
          : 'bg-secondary/60 text-foreground'
      }`}>
        {/* Thinking block (collapsible) */}
        {message.thinking && (
          <div className="mb-2">
            <button
              className="flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
              onClick={() => setShowThinking(!showThinking)}
            >
              <Brain className="w-3 h-3" />
              {showThinking ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronRight className="w-2.5 h-2.5" />}
              <span>Thinking...</span>
            </button>
            {showThinking && (
              <div className="mt-1 pl-4 border-l border-muted-foreground/20 text-[10px] text-muted-foreground/60 italic leading-relaxed whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                {message.thinking}
              </div>
            )}
          </div>
        )}

        {/* Message content */}
        <ReactMarkdown
          components={{
            p: ({ children }) => <p className="mb-1 last:mb-0 leading-relaxed">{children}</p>,
            ul: ({ children }) => <ul className="list-disc list-inside mb-1 space-y-0.5">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal list-inside mb-1 space-y-0.5">{children}</ol>,
            li: ({ children }) => <li>{children}</li>,
            code: ({ children }) => (
              <code className="bg-background/50 px-1 py-0.5 rounded text-[10px] font-mono">{children}</code>
            ),
            strong: ({ children }) => <strong className="font-semibold text-primary">{children}</strong>,
            h3: ({ children }) => <h3 className="font-semibold text-primary mt-2 mb-1">{children}</h3>,
            h4: ({ children }) => <h4 className="font-medium text-primary/80 mt-1.5 mb-0.5">{children}</h4>,
          }}
        >
          {message.content}
        </ReactMarkdown>

        {/* Map to Canvas button for assistant messages */}
        {isAssistant && hasContent && (
          <div className="mt-2 pt-1.5 border-t border-border/30">
            <Button
              variant="outline"
              size="sm"
              className="h-5 text-[9px] gap-1 px-2"
              onClick={handleMapToCanvas}
              disabled={mapped}
            >
              <LayoutGrid className="w-2.5 h-2.5" />
              {mapped ? 'Mapped' : 'Map to Canvas'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
