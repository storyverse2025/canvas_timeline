import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { tryHydrateFromServerIfIdbEmpty } from '@/lib/session-backup'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

// Pull the server snapshot BEFORE React mounts if (and only if) IDB
// came up empty for every tracked store — this is the fallback for
// the laptop-sleep-mid-write case where IDB lost data. The function
// writes restored values directly into IDB; we then reload so Zustand
// picks them up via its normal hydration path (re-hydrating after
// stores have already initialized is racy).
async function bootstrap() {
  try {
    const r = await tryHydrateFromServerIfIdbEmpty()
    if (r.hydrated) {
      // eslint-disable-next-line no-console
      console.log(`[session-backup] IDB empty — restored server snapshot from ${r.savedAt}. Reloading…`)
      window.location.reload()
      return
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[session-backup] hydrate-from-server failed:', (e as Error).message)
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrap()
