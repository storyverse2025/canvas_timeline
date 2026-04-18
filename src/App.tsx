import { Component, useEffect, type ReactNode } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Toaster } from '@/components/ui/sonner'
import { AppShell } from '@/components/layout/AppShell'
import { migrateStores } from '@/lib/migrate-stores'
import { initStoryboardTimelineLink } from '@/lib/storyboard-timeline-sync'
import { initCanvasStoryboardSync } from '@/lib/canvas-storyboard-sync'

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
  useEffect(() => {
    // Run once after all persisted stores have rehydrated
    migrateStores()
    initStoryboardTimelineLink()
    initCanvasStoryboardSync()
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
