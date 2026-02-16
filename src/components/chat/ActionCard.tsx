import { Check, X, Loader2, Plus, Link } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { AgentAction } from '@/types/chat'

interface ActionCardProps {
  action: AgentAction
  content: string
}

export function ActionCard({ action, content }: ActionCardProps) {
  const statusIcon = {
    pending: <Loader2 className="w-3 h-3 text-muted-foreground" />,
    running: <Loader2 className="w-3 h-3 text-primary animate-spin" />,
    success: <Check className="w-3 h-3 text-emerald-400" />,
    error: <X className="w-3 h-3 text-destructive" />,
  }[action.status]

  const statusColor = {
    pending: 'border-muted',
    running: 'border-primary/40',
    success: 'border-emerald-500/40',
    error: 'border-destructive/40',
  }[action.status]

  return (
    <div className={`rounded-lg border ${statusColor} bg-card/60 p-2.5`}>
      <div className="flex items-center gap-2 mb-1.5">
        {statusIcon}
        <span className="text-[11px] font-medium capitalize">
          {action.type.replace(/_/g, ' ')}
        </span>
        <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full ${
          action.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' :
          action.status === 'error' ? 'bg-destructive/20 text-destructive' :
          'bg-secondary text-muted-foreground'
        }`}>
          {action.status}
        </span>
      </div>

      <p className="text-[11px] text-muted-foreground">{content}</p>

      {action.status === 'success' && action.canvasNodeIds && action.canvasNodeIds.length > 0 && (
        <div className="flex gap-1.5 mt-2">
          <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1">
            <Plus className="w-2.5 h-2.5" />
            Add to Canvas ({action.canvasNodeIds.length})
          </Button>
          <Button variant="outline" size="sm" className="h-6 text-[10px] gap-1">
            <Link className="w-2.5 h-2.5" />
            Link to Timeline
          </Button>
        </div>
      )}

      {action.error && (
        <p className="text-[10px] text-destructive mt-1">{action.error}</p>
      )}
    </div>
  )
}
