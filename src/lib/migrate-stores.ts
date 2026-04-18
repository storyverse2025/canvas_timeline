/**
 * One-time migration from old store format to new asset-based stores.
 * Called on app mount. Safe to call multiple times (idempotent).
 */
import { useAssetStore } from '@/stores/asset-store'
import { useCanvasStore } from '@/stores/canvas-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useTimelineStore } from '@/stores/timeline-store'
import type { AssetType } from '@/types/asset'

export function migrateStores() {
  const assetStore = useAssetStore.getState()
  const canvasStore = useCanvasStore.getState()
  const mappingStore = useMappingStore.getState()

  // Initialize default timeline tracks if empty
  useTimelineStore.getState().initDefaultTracks()

  // Only run migration if asset store is empty but canvas store has legacy nodes
  const hasAssets = assetStore.assets.length > 0
  if (hasAssets) return

  // Read legacy canvas nodes (old format had type: 'visual' | 'script' | 'audio')
  const legacyNodes = canvasStore.nodes as unknown as Array<{
    id: string
    type: string
    position: { x: number; y: number }
    data: Record<string, unknown>
  }>

  if (legacyNodes.length === 0) return

  const nodeIdToAssetId: Record<string, string> = {}
  const migratedNodeIds: string[] = []

  for (const node of legacyNodes) {
    if (node.type !== 'visual') continue
    const d = node.data
    const assetType = d.assetType as string
    if (!['character', 'scene', 'prop', 'keyframe'].includes(assetType)) continue

    const assetId = assetStore.addAsset({
      type: assetType as AssetType,
      name: (d.label as string) || 'Unnamed',
      imageUrl: d.imageUrl as string | undefined,
      thumbnailUrl: d.thumbnailUrl as string | undefined,
      prompt: d.prompt as string | undefined,
      sourceId: d.sourceId as string | undefined,
      status: d.status as any,
      versions: d.versions as any,
      tags: (d.tags as any[]) || [],
      position: node.position,
    })

    nodeIdToAssetId[node.id] = assetId
    migratedNodeIds.push(node.id)
  }

  if (migratedNodeIds.length === 0) return

  // Rewrite canvas nodes to new format (keep only visual nodes with assetId)
  const newNodes = legacyNodes
    .filter((n) => nodeIdToAssetId[n.id])
    .map((n) => ({
      id: n.id,
      type: 'asset',
      position: n.position,
      data: { assetId: nodeIdToAssetId[n.id] },
    }))

  canvasStore.setNodes(newNodes as any)

  // Update mapping store links to include assetId
  const updatedLinks = mappingStore.links.map((link) => ({
    ...link,
    assetId: nodeIdToAssetId[link.canvasNodeId] ?? link.assetId,
  }))
  mappingStore.setLinks(updatedLinks)

  console.log(`[migrate] Migrated ${migratedNodeIds.length} legacy canvas nodes to asset store`)
}
