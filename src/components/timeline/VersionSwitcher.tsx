import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVersionStore } from '@/stores/version-store'

export function VersionSwitcher() {
  const versions = useVersionStore((s) => s.versions)
  const activeVersionId = useVersionStore((s) => s.activeVersionId)

  // VersionSwitcher is currently disabled in the shot-centric timeline.
  // Keeping component for future re-enablement.
  if (versions.length === 0) return null

  return (
    <div className="flex items-center gap-1">
      {versions.map((v) => (
        <button
          key={v.id}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] transition-colors ${
            v.id === activeVersionId
              ? 'bg-primary/20 text-primary border border-primary/30'
              : 'bg-secondary/50 text-muted-foreground hover:bg-secondary border border-transparent'
          }`}
        >
          {v.name}
        </button>
      ))}
    </div>
  )
}
