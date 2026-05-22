import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App'
import { tryHydrateFromServerIfIdbEmpty, setPushesPaused } from '@/lib/session-backup'
import { preHydrateCleanIdb } from '@/lib/storage/pre-hydrate-clean'

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
// stays blank with no useful error in the console.
//
// Bumped from 3s → 60s after a 63 MB session reproduced the failure
// mode the old 3s budget was supposed to prevent: race fired, React
// mounted with 0/7 stores in Zustand, hydrate finished 6/7 writes in
// the background, but Zustand had already initialized so the UI showed
// blank canvas + the auto-push then uploaded the partial state back to
// the server — risking overwriting the good snapshot we just downloaded.
// 60 s comfortably covers a 63 MB GET + parse + 7-store sequential IDB
// commit on a residential uplink (~10-30 s in practice); only a truly
// hung server hits the timeout now, and on timeout we leave pushes
// paused (see below) so partial state can't clobber the server copy.
const HYDRATE_TIMEOUT_MS = 60_000

function showSplash(message: string): void {
  const el = document.getElementById('root')
  if (!el) return
  // Pure HTML/CSS — no React, no bundled fonts. Renders the moment
  // bootstrap() runs so a slow hydrate has visible feedback instead of
  // a blank tab that looks identical to a crash.
  el.innerHTML = `
    <style>@keyframes splash-spin{to{transform:rotate(360deg);}}</style>
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e5e5e5;font-family:system-ui,-apple-system,sans-serif;font-size:13px;">
      <div style="display:flex;flex-direction:column;align-items:center;gap:14px;">
        <div style="width:28px;height:28px;border:2px solid #2a2a2a;border-top-color:#9b87f5;border-radius:50%;animation:splash-spin 0.9s linear infinite;"></div>
        <div>${message}</div>
        <div style="font-size:11px;color:#666;max-width:320px;text-align:center;line-height:1.5;">大型会话可能需要 10–60s 从服务器恢复，请勿关闭页面</div>
      </div>
    </div>
  `
}

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
  showSplash('正在恢复会话…')
  // Pause auto-push for the entire hydrate window. Without this the
  // 30 s debounced push fires WHILE we're mid-restore, reads a partial
  // IDB, and uploads that partial state back — potentially overwriting
  // the good server snapshot we're concurrently downloading. After a
  // successful hydrate we reload (module reinits → pauses default-off
  // again). After a timeout / error we LEAVE pushes paused on purpose,
  // since partial IDB state could still overwrite a good server copy.
  setPushesPaused(true)
  let safeToUnpause = false
  try {
    const timeout = new Promise<{ hydrated: false; timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ hydrated: false, timedOut: true }), HYDRATE_TIMEOUT_MS),
    )
    const r = await Promise.race([tryHydrateFromServerIfIdbEmpty(), timeout])
    if ('timedOut' in r && r.timedOut) {
      // eslint-disable-next-line no-console
      console.warn(
        `[session-backup] hydrate exceeded ${HYDRATE_TIMEOUT_MS}ms — mounting React with whatever IDB has. ` +
        `Auto-push remains PAUSED until the next reload to protect the server-side good snapshot.`,
      )
    } else if (r.hydrated) {
      // eslint-disable-next-line no-console
      console.log(`[session-backup] IDB empty — restored server snapshot from ${r.savedAt}. Reloading…`)
      window.location.reload()
      return
    } else {
      // No hydrate needed: local IDB had every tracked store. Safe to
      // resume normal auto-push.
      safeToUnpause = true
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[session-backup] hydrate-from-server failed:', (e as Error).message)
    // Leave pushes paused — same defensive reason as timeout.
  }
  // Pre-hydrate IDB cleanup: scan canvas-item-store + asset-store for
  // inline data:image/...;base64,... URLs and replace with /uploads/ URLs
  // BEFORE Zustand hydrates. Without this, a single 4K base64 image in
  // the snapshot blows past 4GB JS heap on parse + render. See
  // src/lib/storage/pre-hydrate-clean.ts for the incident write-up.
  try {
    showSplash('正在压缩本地缓存…')
    const cleaned = await preHydrateCleanIdb()
    if (cleaned.migrated > 0) {
      // eslint-disable-next-line no-console
      console.log(`[pre-hydrate-clean] migrated ${cleaned.migrated} inline data URLs, freed ${(cleaned.bytesFreed/1024/1024).toFixed(1)}MB (${cleaned.failed} failed)`)
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[pre-hydrate-clean] failed (non-fatal, continuing):', (e as Error).message)
  }

  if (safeToUnpause) setPushesPaused(false)
  mountReact()
}

void bootstrap()
