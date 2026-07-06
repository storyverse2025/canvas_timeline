import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('RAG reference picker UI contract', () => {
  const tableContext = readFileSync(join(process.cwd(), 'src/components/table/TableContextMenu.tsx'), 'utf8')

  it('opens a modal instead of dumping RAG hits into chat', () => {
    expect(tableContext).toContain('RagReferenceModal')
    expect(tableContext).toContain('美术 / 动作 / 镜头各显示前 10 条')
    expect(tableContext).not.toContain('复制 prompt 粘进')
  })

  it('queries LLM-extracted top-10 video buckets for art, action, and camera references', () => {
    expect(tableContext).toContain('buildRagQueryExtractionPrompt')
    expect(tableContext).toContain('parseRagExtractedQueries')
    expect(tableContext).toContain("api.artRag.search({ query: extractedQueries.art, topK: 10, outputMediaType: 'video' })")
    expect(tableContext).toContain("api.artRag.search({ query: extractedQueries.action, topK: 10, outputMediaType: 'video' })")
    expect(tableContext).toContain("api.artRag.search({ query: extractedQueries.camera, topK: 10, outputMediaType: 'video' })")
    expect(tableContext).toContain('RAG 结果不足 10 条')
    expect(tableContext).toContain('期望至少 20000 个视频 prompt')
  })

  it('shows the LLM-generated RAG queries in an expandable section above results', () => {
    expect(tableContext).toContain('generatedQueries')
    expect(tableContext).toContain('RAG LLM 生成的 query')
    expect(tableContext).toContain('<details')
    expect(tableContext).toContain('美术 query')
    expect(tableContext).toContain('动作 query')
    expect(tableContext).toContain('镜头 query')
  })

  it('applies selected references through AI row rewrite instead of manual copy-paste', () => {
    expect(tableContext).toContain("capability: 'freeform-text'")
    expect(tableContext).toContain('parseRagRowPatch')
    expect(tableContext).toContain('updateRow(targetRow.id, patch)')
    expect(tableContext).toContain('useChatStore.getState().addMessage')
    expect(tableContext).toContain('buildRagRowPatchDiffMessage')
  })
})
