import { isValidReferenceImageUrl } from '@/lib/agents/cinematographer-agent'
import type { ReferencePackImage } from '@/lib/agents/cinematographer-agent'
import { rowCharacters, rowIdentitySheets, rowProps, type StoryboardRow, type ElementSlot } from '@/types/storyboard'

/**
 * Assemble the ordered multi-reference pack (多参考输入合成) for a row:
 * 角色身份版 → 道具图 → 场景图 → 黑白分镜图 → 机位截图. Every entry is
 * validated (http(s)/data/uploads raster) and de-duplicated. Returns []
 * when the row has nothing beyond the legacy keyframe pair OR when the
 * 机位/开场构图 anchor itself failed validation — the caller then keeps the
 * single-keyframe (+grid) path so pre-identity-sheet projects behave
 * exactly as before and Seedance never receives a pack without its
 * first-frame anchor.
 *
 * Pure (row in, pack out) — kept out of useStoryboardGenerate so pack
 * composition is unit-testable without dragging the store graph into tests.
 */
export function buildReferencePack(row: StoryboardRow): ReferencePackImage[] {
  const pack: ReferencePackImage[] = []
  const push = (
    url: string | undefined,
    label: string,
    usage: string,
    subject: string | undefined,
    kind: ReferencePackImage['kind'],
  ) => {
    if (!isValidReferenceImageUrl(url)) return
    if (pack.some((p) => p.url === url)) return
    pack.push({ url, label, usage, subject, kind })
  }

  // 1. 角色 — identity sheet when generated, else the raw slot image as a
  // fallback so the pack NEVER ships without a character anchor while the
  // row has characters (a pack whose only casting source is the B&W
  // storyboard's hand-drawn figures cannot lock faces).
  const charName = (slot: ElementSlot | null | undefined, fallback: string) =>
    slot?.description?.split(/[，,。\n]/)[0]?.trim() || fallback
  const pushCharacter = (slot: ElementSlot | null | undefined, sheetUrl: string | undefined, fallbackName: string) => {
    const name = charName(slot, fallbackName)
    if (sheetUrl && isValidReferenceImageUrl(sheetUrl)) {
      push(
        sheetUrl,
        `角色身份版「${name}」`,
        `锁定角色「${name}」的脸型、发型、服装、体型比例与道具尺寸关系（全身锚点+多视角+表情+细节以此为准）`,
        name,
        'character',
      )
    } else {
      push(
        slot?.image,
        `角色图「${name}」`,
        `锁定角色「${name}」的脸型、发型、服装（暂无身份版，以这张角色设定图为准）`,
        name,
        'character',
      )
    }
  }
  // All characters in the row, each with its OWN per-member identity sheet
  // (identitySheetUrls[i]); members without a sheet yet fall back to their raw
  // character setup image (pushCharacter's fallback).
  const sheetUrls = rowIdentitySheets(row)
  rowCharacters(row).forEach((slot, i) => pushCharacter(slot, sheetUrls[i] || undefined, `角色${i + 1}`))

  // 2. 道具图 — hero props carry identity too (a signature weapon that
  // changes shape between shots is as jarring as a face swap). Text-only
  // prop slots still travel via contextRefs; this covers slots that have
  // an actual reference image.
  const pushProp = (slot: ElementSlot | null | undefined, fallbackName: string) => {
    if (!slot?.image) return
    const name = charName(slot, fallbackName)
    push(
      slot.image,
      `道具图「${name}」`,
      `锁定道具「${name}」的造型、材质、颜色与比例（画面中出现该道具时以这张图为准）`,
      name,
      'prop',
    )
  }
  rowProps(row).forEach((slot, i) => pushProp(slot, `道具${i + 1}`))

  // 3. 场景图 — 虚拟影棚约束：the scene slot holds either the 360° panorama
  // itself or a 机位截图 captured from it (PanoramaViewer 截机位); either way
  // the environment is locked to one sphere, so structure/摆设/光向 must stay
  // physically consistent across every shot.
  const sceneName = row.scene?.description?.split(/[，,。\n]/)[0]?.trim()
  push(
    row.scene?.image,
    sceneName ? `场景图「${sceneName}」` : '场景图',
    '参考图片环境生成，保持场景一致性——建筑结构、摆设位置、光线方向必须与这张图完全连贯；机位在此空间内取景',
    sceneName,
    'scene',
  )

  // Nothing beyond the legacy keyframe pair → let the caller keep the
  // single-keyframe path. Character/prop refs (身份版 OR raw slot image)
  // and the scene image are what justify pack mode — without them the pack
  // would just be a reordered keyframe pair.
  if (pack.length === 0) return []

  // 4. 黑白分镜图 (the hand-drawn storyboard grid).
  const gridUrl =
    row.keyframeUrl && row.keyframeUrl !== row.keyframeCleanUrl ? row.keyframeUrl : undefined
  push(
    gridUrl,
    '黑白手绘分镜图',
    '按分格顺序读取动作/调度/节奏，并执行其标注：橙色箭头=轮廓光方向、红色箭头=人物动作、蓝色箭头=摄影机运动；严禁把分格、边框、箭头、文字渲染进画面',
    undefined,
    'storyboard',
  )

  // 5. 机位截图 — the clean single frame anchors the opening camera setup.
  push(
    row.keyframeCleanUrl || row.keyframeUrl || row.reference_image,
    '机位截图 / 开场构图',
    '以这张作为开场机位、构图与画面长相的最终标准（首帧感觉以它为准）',
    undefined,
    'camera',
  )

  // Pack mode REPLACES the keyframe as Seedance's image inputs, so a pack
  // without the 机位/开场构图 anchor would ship e.g. a lone scene plate and
  // lose the first-frame contract entirely (the exact failure behind
  // "input 只剩场景图" reports). If the anchor didn't survive validation,
  // fall back to the legacy path where keyframeUrl passes through as-is.
  if (!pack.some((p) => p.kind === 'camera')) return []

  // 黑白分镜图 (storyboard grid) ALWAYS leads the pack — it's the single most
  // important reference: the action / staging / rhythm authority the video
  // must follow (user directive). Everything else (identity / scene / props /
  // 机位) is a secondary lock. Stable-partition so the rest keep their order.
  return [
    ...pack.filter((p) => p.kind === 'storyboard'),
    ...pack.filter((p) => p.kind !== 'storyboard'),
  ]
}
