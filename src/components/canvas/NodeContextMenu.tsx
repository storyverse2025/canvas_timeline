import { useEffect, useRef, useState } from 'react'
import {
  Edit3, Copy, Trash2, Replace, Wand2,
  ChevronRight, Film, Mic, Palette,
  Scissors, ZoomIn, Expand, CropIcon, Sparkles,
  Eye, Clapperboard, ArrowUpRight, Layers, Move3d,
  SplitSquareHorizontal, PaintBucket, Volume2,
  AudioLines, TextCursorInput, Music, FolderPlus,
} from 'lucide-react'
import { useCanvasStore } from '@/stores/canvas-store'
import { useCanvasItemStore } from '@/stores/canvas-item-store'
import { useGenerateDialogStore } from '@/stores/generate-dialog-store'
import { useCapabilityDialogStore } from '@/stores/capability-dialog-store'
import { gatherUpstream } from '@/lib/canvas-graph'
import { getCapabilitiesForNodeType } from '@/lib/capabilities/registry'
import { CreateAssetDialog } from '@/components/asset-library/CreateAssetDialog'
import type { CapabilitySpec } from '@/lib/capabilities/types'
import { cn } from '@/lib/utils'

export interface ContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

interface Props {
  menu: ContextMenuState | null;
  onClose: () => void;
}

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  image: Palette,
  video: Film,
  audio: Mic,
}

const CATEGORY_LABELS: Record<string, string> = {
  image: '图片能力',
  video: '视频能力',
  audio: '音频能力',
}

const CAP_ICONS: Record<string, React.ElementType> = {
  'script-rewrite': Edit3, 'script-breakdown': Scissors,
  'element-extraction': Eye, 'shot-extraction': Clapperboard,
  'consistency-check': Layers, 'text-to-image': Sparkles,
  'smart-edit': Wand2, 'inpaint': PaintBucket,
  'upscale-image': ZoomIn, 'outpaint': Expand,
  'crop-image': CropIcon, 'shot-association': ArrowUpRight,
  'multi-angle': Move3d, 'angle-adjust': Eye,
  'pose-edit': Move3d, 'text-to-video': Film,
  'first-last-frame': Clapperboard, 'multi-ref-video': Layers,
  'upscale-video': ZoomIn, 'lip-sync': Volume2,
  'motion-imitation': Move3d, 'video-split': SplitSquareHorizontal,
  'video-style-transfer': PaintBucket, 'preset-voice': AudioLines,
  'voice-clone': Mic, 'polyphonic': TextCursorInput,
  'sound-effects': Music,
}

export function NodeContextMenu({ menu, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [subMenu, setSubMenu] = useState<string | null>(null)
  const node = useCanvasStore((s) => (menu ? s.nodes.find((n) => n.id === menu.nodeId) : undefined))
  const removeNode = useCanvasStore((s) => s.removeNode)
  const addItemNode = useCanvasStore((s) => s.addItemNode)
  const item = useCanvasItemStore((s) => {
    const id = node?.data.itemId
    return id ? s.items[id] : undefined
  })
  const updateItem = useCanvasItemStore((s) => s.updateItem)
  const addItem = useCanvasItemStore((s) => s.addItem)
  const openGenerateDialog = useGenerateDialogStore((s) => s.open)
  const openCapDialog = useCapabilityDialogStore((s) => s.open)
  const [createAssetOpen, setCreateAssetOpen] = useState(false)

  useEffect(() => {
    if (!menu) return
    setSubMenu(null)
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menu, onClose])

  if (!menu || !node) return null

  const isImage = node.type === 'image'
  const isText = node.type === 'text'
  const nodeType = node.type ?? 'image'

  // Agent capabilities belong to 导演助手 / AI Agent flows (table editing, asset
  // extraction), not to per-node right-click actions.
  const caps = getCapabilitiesForNodeType(nodeType).filter((c) => c.category !== 'agent')
  const categories = ['image', 'video', 'audio'].filter(
    (cat) => caps.some((c) => c.category === cat)
  )

  const renameItem = () => {
    if (!item) return
    const name = window.prompt('节点名称', item.name)
    if (name != null) updateItem(item.id, { name })
    onClose()
  }

  const editText = () => {
    if (!item) return
    const c = window.prompt('编辑文本', item.content)
    if (c != null) updateItem(item.id, { content: c })
    onClose()
  }

  const replaceImage = () => {
    if (!item) return
    const url = window.prompt('图片 URL', item.content)
    if (url != null) updateItem(item.id, { content: url })
    onClose()
  }

  const duplicate = () => {
    if (!item) return
    const newItemId = addItem({ kind: item.kind, name: item.name + ' 副本', content: item.content })
    const w = (node.style?.width as number) ?? node.width ?? 240
    const h = (node.style?.height as number) ?? node.height ?? 160
    addItemNode(newItemId, item.kind, { x: node.position.x + 40, y: node.position.y + 40 }, { width: w, height: h })
    onClose()
  }

  const remove = () => {
    removeNode(menu.nodeId)
    onClose()
  }

  const aiGenerate = () => {
    if (!item) return
    const upstream = gatherUpstream(menu.nodeId)
    const selfImage = item.kind === 'image' && item.content && !/\.(mp4|webm|mov)(\?|$)/i.test(item.content)
      ? [item.content] : []
    const selfText = item.kind === 'text' && item.content ? [item.content] : []
    const composedPrompt = [item.name, ...selfText, ...upstream.texts].filter(Boolean).join(' · ')
    openGenerateDialog({
      nodeId: menu.nodeId,
      itemId: item.id,
      prompt: composedPrompt,
      upstreamImages: [...selfImage, ...upstream.images],
      defaultKind: 'image',
    })
    onClose()
  }

  const openCapability = (cap: CapabilitySpec) => {
    if (!item) return
    const upstream = gatherUpstream(menu.nodeId)
    const selfImage = item.kind === 'image' && item.content && !/\.(mp4|webm|mov)(\?|$)/i.test(item.content)
      ? [item.content] : []
    const selfText = item.kind === 'text' && item.content ? [item.content] : []
    const composedPrompt = [item.name, ...selfText, ...upstream.texts].filter(Boolean).join(' · ')
    openCapDialog({
      capability: cap,
      nodeId: menu.nodeId,
      itemId: item.id,
      prompt: composedPrompt,
      refImages: [...selfImage, ...upstream.images],
    })
    onClose()
  }

  return (
    <div
      ref={ref}
      className="fixed z-[60] min-w-[180px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 text-sm"
      style={{ left: menu.x, top: menu.y }}
    >
      <MenuItem icon={Edit3} label="重命名" onClick={renameItem} />
      {isText && <MenuItem icon={Edit3} label="编辑文本" onClick={editText} />}
      {isImage && <MenuItem icon={Wand2} label="AI 生成 / 编辑" onClick={aiGenerate} />}
      {isImage && <MenuItem icon={Replace} label="替换图片 URL" onClick={replaceImage} />}

      {categories.length > 0 && <div className="my-1 border-t border-border" />}

      {categories.map((cat) => {
        const catCaps = caps.filter((c) => c.category === cat)
        const CatIcon = CATEGORY_ICONS[cat] ?? Sparkles
        const isOpen = subMenu === cat
        return (
          <div key={cat} className="relative">
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
              onMouseEnter={() => setSubMenu(cat)}
            >
              <CatIcon className="w-3.5 h-3.5" />
              <span className="flex-1">{CATEGORY_LABELS[cat]}</span>
              <ChevronRight className="w-3 h-3 opacity-50" />
            </button>
            {isOpen && (
              <div
                className="absolute left-full top-0 ml-1 min-w-[180px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 text-sm z-[61]"
                onMouseLeave={() => setSubMenu(null)}
              >
                {catCaps.map((cap) => {
                  const CapIcon = CAP_ICONS[cap.id] ?? Sparkles
                  return (
                    <button
                      key={cap.id}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground"
                      onClick={() => openCapability(cap)}
                      title={cap.description}
                    >
                      <CapIcon className="w-3.5 h-3.5" />
                      <span className="flex-1">{cap.label}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      <div className="my-1 border-t border-border" />
      <MenuItem icon={FolderPlus} label="创建资产" onClick={() => { setCreateAssetOpen(true); onClose() }} />
      <MenuItem icon={Copy} label="复制节点" onClick={duplicate} />
      <MenuItem icon={Trash2} label="删除节点" onClick={remove} danger />
      {createAssetOpen && item && (
        <CreateAssetDialog
          itemName={item.name}
          itemContent={item.content}
          itemKind={item.kind}
          onClose={() => setCreateAssetOpen(false)}
        />
      )}
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={cn(
        'w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent hover:text-accent-foreground',
        danger && 'text-destructive hover:!bg-destructive/10',
        disabled && 'opacity-50 pointer-events-none'
      )}
      onClick={onClick}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}
