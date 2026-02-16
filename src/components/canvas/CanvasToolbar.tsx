import { FileText, Image, Music, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCanvasStore } from '@/stores/canvas-store'

export function CanvasToolbar() {
  const addNode = useCanvasStore((s) => s.addNode)
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const removeNode = useCanvasStore((s) => s.removeNode)

  const handleAddScript = () => {
    addNode('script', {
      scriptType: 'dialogue',
      content: 'New dialogue...',
      tags: [],
    }, { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 })
  }

  const handleAddVisual = () => {
    addNode('visual', {
      assetType: 'keyframe',
      label: 'New Visual',
      tags: [],
    }, { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 })
  }

  const handleAddAudio = () => {
    addNode('audio', {
      audioType: 'bgm',
      duration: 10,
      label: 'New Audio',
      tags: [],
    }, { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 })
  }

  const handleDelete = () => {
    selectedNodeIds.forEach((id) => removeNode(id))
  }

  return (
    <TooltipProvider>
      <div className="absolute top-3 left-3 flex gap-1 bg-card/90 backdrop-blur border border-border rounded-lg p-1 z-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleAddScript}>
              <FileText className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add Script Node</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleAddVisual}>
              <Image className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add Visual Asset</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleAddAudio}>
              <Music className="w-4 h-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Add Audio Block</TooltipContent>
        </Tooltip>
        {selectedNodeIds.length > 0 && (
          <>
            <div className="w-px bg-border mx-0.5" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={handleDelete}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Delete Selected</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </TooltipProvider>
  )
}
