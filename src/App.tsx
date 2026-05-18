import { Component, useEffect, type ReactNode } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/layout/AppShell'
import { migrateStores } from '@/lib/migrate-stores'
import { initStoryboardTimelineLink } from '@/lib/storyboard-timeline-sync'
import { initCanvasStoryboardSync } from '@/lib/canvas-storyboard-sync'
import { useServerBackupSync } from '@/lib/session-backup'
import { migrateInlineDataUrlsOnce } from '@/lib/storage/data-url-migration'
import { useProjectDB } from '@/stores/project-db'
import { toast } from 'sonner'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  handleClearAndReset = () => {
    localStorage.removeItem('canvas-store')
    localStorage.removeItem('timeline-store')
    localStorage.removeItem('timeline-store-v2')
    localStorage.removeItem('mapping-store')
    localStorage.removeItem('asset-store')
    localStorage.removeItem('pipeline-context')
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
          <div className="max-w-lg p-8 rounded-lg border border-border bg-card space-y-4">
            <h2 className="text-xl font-semibold text-destructive">Something went wrong</h2>
            <p className="text-sm text-muted-foreground">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <pre className="text-xs bg-muted p-3 rounded overflow-auto max-h-40">
              {this.state.error?.stack?.slice(0, 500)}
            </pre>
            <div className="flex gap-3">
              <button
                onClick={this.handleReset}
                className="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Try Again
              </button>
              <button
                onClick={this.handleClearAndReset}
                className="px-4 py-2 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Clear Data & Reload
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function AppWithMigration() {
  // Subscribe to every persisted store and debounce-push the snapshot
  // to the server. Pulls on empty IDB happen in main.tsx BEFORE
  // Zustand hydrates — this hook only handles the push side.
  useServerBackupSync()

  useEffect(() => {
    // Run once after all persisted stores have rehydrated
    migrateStores()
    initStoryboardTimelineLink()
    initCanvasStoryboardSync()
    // Initialize ProjectDB: force a write to localStorage so it's visible in DevTools.
    // Zustand persist only writes on set(), not on getState(), so we trigger a no-op update.
    const db = useProjectDB.getState()
    if (Object.keys(db.elements).length === 0 && db.artDirection.updatedAt === 0) {
      db.updateArtDirection({}) // triggers set() → persist writes to localStorage
    }

    // One-shot: upload any inline `data:image/...` URLs in
    // canvas-item-store to /uploads and replace with the path. Cuts
    // snapshot size by ~80% on dense canvases and unblocks the
    // server-side backup from hitting nginx's body limit. Runs once
    // and self-heals — items that fail this round retry on next load.
    void migrateInlineDataUrlsOnce().then((r) => {
      if (r.migrated > 0) {
        const freedKB = Math.round(r.bytesFreed / 1024)
        toast.success(`迁移了 ${r.migrated} 个内联图片到 /uploads (省下 ${freedKB} KB)`, {
          description: r.failed > 0 ? `${r.failed} 个失败 — 下次启动会重试` : undefined,
        })
      }
    })
  }, [])

  return (
    <>
      <AppShell />
      <Toaster position="bottom-right" />
    </>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <ReactFlowProvider>
        <AppWithMigration />
      </ReactFlowProvider>
    </ErrorBoundary>
  )
}
