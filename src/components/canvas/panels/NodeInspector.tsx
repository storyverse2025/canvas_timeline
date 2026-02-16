import { useMemo, useState, useCallback } from 'react'
import { FileText, Image, Music, Tag, Link2, X, ChevronDown, ChevronRight, Check, RefreshCw, Loader2, Film } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useCanvasStore } from '@/stores/canvas-store'
import { useMappingStore } from '@/stores/mapping-store'
import { useTimelineStore } from '@/stores/timeline-store'
import { generateImage, generateVideo } from '@/lib/fal-client'
import { api } from '@/lib/api-client'
import { isBackendAvailable } from '@/lib/api'
import type { ScriptNodeData, VisualAssetNodeData, AudioBlockNodeData, ImageVersion } from '@/types/canvas'

export function NodeInspector() {
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const nodes = useCanvasStore((s) => s.nodes)
  const updateNode = useCanvasStore((s) => s.updateNode)
  const addTag = useCanvasStore((s) => s.addTag)
  const removeTag = useCanvasStore((s) => s.removeTag)
  const links = useMappingStore((s) => s.links)
  const addLinkToShot = useMappingStore((s) => s.addLinkToShot)
  const removeLinkFromShot = useMappingStore((s) => s.removeLinkFromShot)
  const shots = useTimelineStore((s) => s.shots)
  const linkNodeToShot = useTimelineStore((s) => s.linkNodeToShot)
  const unlinkNodeFromShot = useTimelineStore((s) => s.unlinkNodeFromShot)

  const [shotsExpanded, setShotsExpanded] = useState(true)
  const [regenerating, setRegenerating] = useState(false)

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeIds[0]),
    [nodes, selectedNodeIds]
  )

  const linkedShotIds = useMemo(() => {
    if (!selectedNode) return new Set<string>()
    return new Set(
      links
        .filter((l) => l.canvasNodeId === selectedNode.id)
        .map((l) => l.timelineItemId)
    )
  }, [links, selectedNode])

  if (!selectedNode) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
        <div className="text-center">
          <Settings2Icon className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p>Select a node to inspect its properties</p>
        </div>
      </div>
    )
  }

  const data = selectedNode.data as Record<string, unknown>
  const tags = (data.tags as { id: string; label: string; category: string }[]) || []

  const toggleShotLink = (shotId: string) => {
    if (linkedShotIds.has(shotId)) {
      removeLinkFromShot(selectedNode.id, shotId)
      unlinkNodeFromShot(shotId, selectedNode.id)
    } else {
      addLinkToShot(selectedNode.id, shotId)
      linkNodeToShot(shotId, selectedNode.id)
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          {selectedNode.type === 'script' && <FileText className="w-4 h-4 text-emerald-400" />}
          {selectedNode.type === 'visual' && (
            (data as unknown as VisualAssetNodeData).assetType === 'video'
              ? <Film className="w-4 h-4 text-green-400" />
              : <Image className="w-4 h-4 text-violet-400" />
          )}
          {selectedNode.type === 'audio' && <Music className="w-4 h-4 text-amber-400" />}
          <span className="text-sm font-semibold capitalize">{selectedNode.type} Node</span>
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">{selectedNode.id.slice(0, 8)}</span>
        </div>

        {/* Type-specific fields */}
        {selectedNode.type === 'script' && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Type</label>
              <div className="mt-1 text-xs capitalize text-foreground/80">
                {(data as unknown as ScriptNodeData).scriptType}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Content</label>
              <Textarea
                value={(data as unknown as ScriptNodeData).content}
                onChange={(e) => updateNode(selectedNode.id, { content: e.target.value } as Partial<ScriptNodeData>)}
                className="mt-1 text-xs min-h-[80px] bg-secondary/50"
              />
            </div>
            {(data as unknown as ScriptNodeData).characterName && (
              <div>
                <label className="text-xs text-muted-foreground">Character</label>
                <Input
                  value={(data as unknown as ScriptNodeData).characterName || ''}
                  onChange={(e) => updateNode(selectedNode.id, { characterName: e.target.value } as Partial<ScriptNodeData>)}
                  className="mt-1 text-xs bg-secondary/50"
                />
              </div>
            )}
            {(data as unknown as ScriptNodeData).beatNumber != null && (
              <div>
                <label className="text-xs text-muted-foreground">Beat Number</label>
                <div className="mt-1 text-xs text-foreground/80">
                  Beat {(data as unknown as ScriptNodeData).beatNumber}
                </div>
              </div>
            )}
          </div>
        )}

        {selectedNode.type === 'visual' && (
          <VisualInspectorSection
            nodeId={selectedNode.id}
            data={data as unknown as VisualAssetNodeData}
            updateNode={updateNode}
            regenerating={regenerating}
            setRegenerating={setRegenerating}
          />
        )}

        {selectedNode.type === 'audio' && (
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Audio Type</label>
              <div className="mt-1 text-xs capitalize text-foreground/80">
                {(data as unknown as AudioBlockNodeData).audioType}
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Label</label>
              <Input
                value={(data as unknown as AudioBlockNodeData).label}
                onChange={(e) => updateNode(selectedNode.id, { label: e.target.value } as Partial<AudioBlockNodeData>)}
                className="mt-1 text-xs bg-secondary/50"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Duration (s)</label>
              <Input
                type="number"
                value={(data as unknown as AudioBlockNodeData).duration}
                onChange={(e) => updateNode(selectedNode.id, { duration: Number(e.target.value) } as Partial<AudioBlockNodeData>)}
                className="mt-1 text-xs bg-secondary/50"
              />
            </div>
            {(data as unknown as AudioBlockNodeData).audioUrl && (
              <div>
                <label className="text-xs text-muted-foreground">Audio</label>
                {(data as unknown as AudioBlockNodeData).audioUrl!.startsWith('blob:') ? (
                  <p className="mt-1 text-[10px] text-amber-400">Audio blob expired after refresh. Re-generate to play.</p>
                ) : (
                  <audio
                    src={(data as unknown as AudioBlockNodeData).audioUrl}
                    controls
                    preload="metadata"
                    className="mt-1 w-full"
                  />
                )}
              </div>
            )}
          </div>
        )}

        {/* Tags */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Tag className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Tags</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="text-[10px] gap-1 pr-1">
                {tag.label}
                <button onClick={() => removeTag(selectedNode.id, tag.id)} className="hover:text-destructive">
                  <X className="w-2.5 h-2.5" />
                </button>
              </Badge>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-5 text-[10px] px-2"
              onClick={() => addTag(selectedNode.id, { category: 'custom', label: 'New Tag' })}
            >
              + Add Tag
            </Button>
          </div>
        </div>

        {/* Linked Shots */}
        <div>
          <button
            className="flex items-center gap-1.5 mb-2 w-full text-left"
            onClick={() => setShotsExpanded(!shotsExpanded)}
          >
            {shotsExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
            <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Linked Shots</span>
            <span className="text-[10px] text-muted-foreground ml-auto">
              {linkedShotIds.size} / {shots.length}
            </span>
          </button>

          {shotsExpanded && (
            <div className="space-y-0.5">
              {shots.length === 0 ? (
                <p className="text-[11px] text-muted-foreground pl-5">No shots in timeline</p>
              ) : (
                shots.map((shot) => {
                  const isLinked = linkedShotIds.has(shot.id)
                  return (
                    <button
                      key={shot.id}
                      className={`flex items-center gap-2 w-full text-left rounded px-2 py-1.5 text-[11px] transition-colors ${
                        isLinked
                          ? 'bg-cyan-500/15 text-foreground hover:bg-cyan-500/25'
                          : 'bg-secondary/30 text-muted-foreground hover:bg-secondary/50'
                      }`}
                      onClick={() => toggleShotLink(shot.id)}
                    >
                      <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                        isLinked ? 'bg-cyan-500 border-cyan-500' : 'border-muted-foreground/40'
                      }`}>
                        {isLinked && <Check className="w-2.5 h-2.5 text-white" />}
                      </div>
                      <span className="truncate flex-1">{shot.label}</span>
                      <span className="text-[9px] text-muted-foreground shrink-0">{shot.duration}s</span>
                    </button>
                  )
                })
              )}
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  )
}

function VisualInspectorSection({
  nodeId,
  data,
  updateNode,
  regenerating,
  setRegenerating,
}: {
  nodeId: string
  data: VisualAssetNodeData
  updateNode: (id: string, data: Partial<VisualAssetNodeData>) => void
  regenerating: boolean
  setRegenerating: (v: boolean) => void
}) {
  const [versionsExpanded, setVersionsExpanded] = useState(false)
  const versions = data.versions || []
  const isVideo = data.assetType === 'video'

  const handleRegenerate = useCallback(async () => {
    const prompt = data.prompt
    if (!prompt) return
    setRegenerating(true)
    try {
      if (isVideo) {
        // Try backend first, fall back to FAL
        let videoUrl: string | undefined
        const backendUp = await isBackendAvailable()
        if (backendUp) {
          try {
            const result = await api.shots.regenerate('test', { prompt })
            videoUrl = result.shot_url
          } catch { /* fallback below */ }
        }
        if (!videoUrl && data.imageUrl) {
          const result = await generateVideo(data.imageUrl, prompt)
          videoUrl = result.url
        }
        if (videoUrl) {
          const newVersions: ImageVersion[] = [...versions]
          if (data.videoUrl) {
            newVersions.push({ url: data.videoUrl, timestamp: Date.now() })
          }
          newVersions.push({ url: videoUrl, timestamp: Date.now() })
          updateNode(nodeId, { videoUrl, status: 'completed', versions: newVersions } as Partial<VisualAssetNodeData>)
        }
      } else {
        const result = await generateImage(prompt)
        const newVersions: ImageVersion[] = [...versions]
        if (data.imageUrl) {
          newVersions.push({ url: data.imageUrl, timestamp: Date.now() })
        }
        newVersions.push({ url: result.url, timestamp: Date.now() })
        updateNode(nodeId, { imageUrl: result.url, versions: newVersions } as Partial<VisualAssetNodeData>)
      }
    } catch (err) {
      console.error('Regenerate failed:', err)
    } finally {
      setRegenerating(false)
    }
  }, [data.prompt, data.imageUrl, data.videoUrl, isVideo, versions, nodeId, updateNode, setRegenerating])

  const selectVersion = useCallback((version: ImageVersion) => {
    if (isVideo) {
      updateNode(nodeId, { videoUrl: version.url } as Partial<VisualAssetNodeData>)
    } else {
      updateNode(nodeId, { imageUrl: version.url } as Partial<VisualAssetNodeData>)
    }
  }, [nodeId, updateNode, isVideo])

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-muted-foreground">Asset Type</label>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="text-xs capitalize text-foreground/80">{data.assetType}</span>
          {isVideo && data.status && (
            <Badge variant="secondary" className={`text-[9px] ${
              data.status === 'completed' ? 'bg-green-500/20 text-green-300' :
              data.status === 'generating' ? 'bg-amber-500/20 text-amber-300' :
              data.status === 'failed' ? 'bg-red-500/20 text-red-300' :
              'bg-muted text-muted-foreground'
            }`}>
              {data.status}
            </Badge>
          )}
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Label</label>
        <Input
          value={data.label}
          onChange={(e) => updateNode(nodeId, { label: e.target.value } as Partial<VisualAssetNodeData>)}
          className="mt-1 text-xs bg-secondary/50"
        />
      </div>
      {data.prompt != null && (
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <label className="text-xs text-muted-foreground">Prompt</label>
            <Button
              variant="outline"
              size="sm"
              className="h-5 text-[10px] px-2 ml-auto gap-1"
              onClick={handleRegenerate}
              disabled={regenerating || !data.prompt}
            >
              {regenerating ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              {regenerating ? 'Generating...' : 'Regenerate'}
            </Button>
          </div>
          <Textarea
            value={data.prompt || ''}
            onChange={(e) => updateNode(nodeId, { prompt: e.target.value } as Partial<VisualAssetNodeData>)}
            className="text-xs min-h-[60px] bg-secondary/50"
          />
        </div>
      )}

      {/* Video player (full controls) */}
      {isVideo && data.videoUrl && (
        <div>
          <label className="text-xs text-muted-foreground">Video Preview</label>
          <video
            src={data.videoUrl}
            poster={data.imageUrl}
            controls
            preload="metadata"
            className="mt-1 rounded border border-border w-full"
          />
        </div>
      )}

      {/* Current image (for non-video or keyframe reference) */}
      {data.imageUrl && !isVideo && (
        <div>
          <label className="text-xs text-muted-foreground">Current Image</label>
          <img src={data.imageUrl} alt="Asset preview" className="mt-1 rounded border border-border w-full" />
        </div>
      )}

      {/* Poster image for video */}
      {isVideo && data.imageUrl && (
        <div>
          <label className="text-xs text-muted-foreground">Reference Keyframe</label>
          <img src={data.imageUrl} alt="Keyframe reference" className="mt-1 rounded border border-border w-full" />
        </div>
      )}

      {/* Version history */}
      {versions.length > 0 && (
        <div>
          <button
            className="flex items-center gap-1.5 w-full text-left"
            onClick={() => setVersionsExpanded(!versionsExpanded)}
          >
            {versionsExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
            <span className="text-xs font-medium">Versions</span>
            <span className="text-[10px] text-muted-foreground ml-auto">{versions.length}</span>
          </button>
          {versionsExpanded && (
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              {versions.map((v, i) => {
                const isActive = isVideo ? v.url === data.videoUrl : v.url === data.imageUrl
                return (
                  <button
                    key={i}
                    className={`relative rounded border overflow-hidden aspect-video ${
                      isActive ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/50'
                    }`}
                    onClick={() => selectVersion(v)}
                  >
                    {isVideo ? (
                      <video src={v.url} muted className="w-full h-full object-cover" />
                    ) : (
                      <img src={v.url} alt={`v${i + 1}`} className="w-full h-full object-cover" />
                    )}
                    <span className="absolute bottom-0 left-0 right-0 text-[8px] bg-black/60 text-white text-center py-0.5">
                      v{i + 1}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Settings2Icon(props: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
      <path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>
    </svg>
  )
}
