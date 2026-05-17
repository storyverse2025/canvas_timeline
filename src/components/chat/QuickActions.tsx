import { Image as ImageIcon, Film, Camera, ListPlus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { useChatStore } from '@/stores/chat-store'

/**
 * Five gap-driven actions. Each one inspects the current project state
 * (via gap-finder) and loops the appropriate agent / hook over the
 * missing items — the user doesn't have to specify which row / asset.
 *
 * Implementations live in src/lib/chat-quick-actions.ts so the same
 * handlers can be invoked by project-manager-agent action dispatch
 * (when the LLM picks `generate-missing-*` from a free-form request).
 *
 * Replaces the pre-agent QuickActions chips (Script / Characters /
 * Keyframes / Auto-Map / Video / Full Pipeline), which were all
 * superseded by 导演助手 + storyboard table right-click menu and
 * competed with the structured agent flow.
 */
const quickActions = [
  {
    id: 'generate-missing-assets' as const,
    label: '生成缺失 assets',
    icon: ImageIcon,
    title: '把所有 content 为空的角色 / 场景 / 道具画布节点重新跑一遍图片生成 (并行)',
  },
  {
    id: 'generate-missing-keyframes' as const,
    label: '生成缺失 keyframe',
    icon: Camera,
    title: '给所有 keyframeUrl 为空的分镜行生成 keyframe (顺序)',
  },
  {
    id: 'add-missing-storyboard-rows' as const,
    label: '添加缺失的分镜行',
    icon: ListPlus,
    title: '检测剧本中尚未被分镜表覆盖的 beat，新增对应行 (本版占位 — 改重跑导演助手)',
  },
  {
    id: 'generate-missing-videos' as const,
    label: '生成缺失视频',
    icon: Film,
    title: '给所有有 keyframe 但无 beat video 的行生成 beat video',
  },
  {
    id: 'update-downstream-videos' as const,
    label: 'update 下游视频',
    icon: RefreshCw,
    title: '重拍所有已经生成过的 beat video — 当 keyframe / 对白 / 音色更新后用',
  },
]

export type QuickActionId = (typeof quickActions)[number]['id']

interface QuickActionsProps {
  onAction: (id: QuickActionId) => Promise<void> | void
}

export function QuickActions({ onAction }: QuickActionsProps) {
  const isLoading = useChatStore((s) => s.isLoading)

  return (
    <div className="border-t border-border px-2 py-1.5">
      <ScrollArea className="w-full">
        <div className="flex gap-1">
          {quickActions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              size="sm"
              className="h-6 text-[10px] gap-1 shrink-0 whitespace-nowrap"
              onClick={() => onAction(action.id)}
              disabled={isLoading}
              title={action.title}
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
