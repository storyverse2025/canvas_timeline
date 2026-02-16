import { FileText, Users, Image, Shuffle, Film, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { useChatStore } from '@/stores/chat-store'

const quickActions = [
  { label: 'Script', icon: FileText, command: 'Write a short 5-beat story script with narration and dialogue for each beat. Include character names and emotions.' },
  { label: 'Characters', icon: Users, command: 'Create 4 unique characters for an animated story. Give each a name, role, and brief visual description.' },
  { label: 'Keyframes', icon: Image, command: 'Suggest 5 keyframe image descriptions for the story beats. For each, provide [IMAGE_PROMPT]: followed by a detailed visual prompt.' },
  { label: 'Auto-Map', icon: Shuffle, command: 'Help me organize the canvas elements into a timeline. What shots should I create and which elements should go in each?' },
  { label: 'Video', icon: Film, command: 'Describe 5 video shots for the story, including camera movement, action, and duration (5-15 seconds each).' },
  { label: 'Full Pipeline', icon: Zap, command: 'Plan a complete video production pipeline: script, characters, scenes, keyframes, and shot list. Start with a creative story concept.' },
]

interface QuickActionsProps {
  onAction: (command: string) => Promise<void>
}

export function QuickActions({ onAction }: QuickActionsProps) {
  const isLoading = useChatStore((s) => s.isLoading)

  return (
    <div className="border-t border-border px-2 py-1.5">
      <ScrollArea className="w-full">
        <div className="flex gap-1">
          {quickActions.map((action) => (
            <Button
              key={action.label}
              variant="outline"
              size="sm"
              className="h-6 text-[10px] gap-1 shrink-0 whitespace-nowrap"
              onClick={() => onAction(action.command)}
              disabled={isLoading}
            >
              <action.icon className="w-2.5 h-2.5" />
              {action.label}
            </Button>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  )
}
