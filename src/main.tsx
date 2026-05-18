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
//
// CRITICAL: the hydrate is wrapped in a Promise.race + timeout. Without
// it, a slow /local-session fetch (server restarting, network hiccup,
// 50 MB body) freezes the await and React never mounts — the page
// stays blank with no useful error in the console. After the timeout
// we mount React regardless; the worst case is that a stale IDB
// renders instead of a server-restored one, fixable by refreshing or
// using the Session picker.
const HYDRATE_TIMEOUT_MS = 3000

function mountReact(): void {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}

async function bootstrap() {
  try {
    const timeout = new Promise<{ hydrated: false; timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ hydrated: false, timedOut: true }), HYDRATE_TIMEOUT_MS),
    )
    const r = await Promise.race([tryHydrateFromServerIfIdbEmpty(), timeout])
    if ('timedOut' in r && r.timedOut) {
      // eslint-disable-next-line no-console
      console.warn(`[session-backup] hydrate exceeded ${HYDRATE_TIMEOUT_MS}ms — mounting React with whatever IDB has`)
    } else if (r.hydrated) {
      // eslint-disable-next-line no-console
      console.log(`[session-backup] IDB empty — restored server snapshot from ${r.savedAt}. Reloading…`)
      window.location.reload()
      return
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[session-backup] hydrate-from-server failed:', (e as Error).message)
  }
  mountReact()
}

void bootstrap()
