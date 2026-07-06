import type { VideoConsistencyIssue } from '@/lib/agents/director-agent'

/**
 * Subset of fields the cinematographer reads from a storyboard row to build
 * the Seedance motion prompt. Keep aligned with src/types/storyboard.ts
 * StoryboardRow — the cinematographer doesn't own that shape (the table
 * does), it just consumes a few text fields.
 */
export interface BeatVideoRow {
  shot_number?: string
  duration?: number
  motion_prompts?: string
  storyboard_prompts?: string
  visual_description?: string
  character_actions?: string
  emotion_mood?: string
  emotion_atmosphere?: string
  character_motivation?: string
  character_psychology?: string
  performance_guidance?: string
  lighting_atmosphere?: string
  shot_size?: string
  /** Dialogue spoken in this beat — baked into the motion description so the
   *  model knows what's being said. actor-agent.attachVoiceRefs additionally
   *  pairs each line with its 音色N audio reference. */
  dialogue?: string
  /** SFX annotations for this beat (e.g. "footsteps on gravel; door slams").
   *  Kept in the prompt so the model can sync motion to audio cues. */
  sound_effects?: string
  /** Optional music/BGM instruction. The Seedance prompt formatter includes it
   *  as an explicit constraint, while global hard constraints may still forbid
   *  non-diegetic music for dialogue-first StoryVerse shoots. */
  bgm?: string
}

/**
 * Context-only role descriptor for character / scene / prop. NOT passed to
 * Seedance as an image — the keyframe (omni-reference / 全能参考) is the
 * single image input. Used only to bake names + descriptions into the motion
 * text so the model knows what to read out of the keyframe.
 */
export interface BeatVideoContextRef {
  /** Human-readable role tag (e.g., "角色1", "场景"). */
  role: string
  description?: string
}

/**
 * Legacy union: BeatVideoRef accepts both context-only refs AND the
 * single-image keyframe ref so the consumer's storyboard mapping logic
 * doesn't have to know which is which. The shoot verb peels the keyframe
 * URL out separately.
 */
export interface BeatVideoRef extends BeatVideoContextRef {
  imageUrl?: string
}

/**
 * One virtual-avatar-library reference shipped to Seedance for a character.
 * `assetUri` is the `asset://<id>` form the generation API requires; the
 * resolver in src/lib/virtual-avatar-library produces these for 真人 styles.
 */
export interface VirtualAvatarShootRef {
  /** `asset://<Asset_Id>` — the only form the Seedance content API accepts. */
  assetUri: string
  /** Character display name, e.g. "莉安" — surfaced in the prompt legend. */
  characterName: string
  /** Slot tag this avatar stands in for, e.g. "角色1". */
  slotLabel: string
}

/**
 * One entry of the ordered multi-reference pack (多参考输入合成). The pack
 * ships to Seedance as consecutive reference_image parts in array order —
 * 角色身份版 → 道具图 → 场景图 → 分镜图 → 机位截图 — and the prompt legend
 * @-points each index at its subject so the model knows which image governs
 * what.
 */
export interface ReferencePackImage {
  /** http(s)/data raster URL. Validated by the caller before submission. */
  url: string
  /** Legend label, e.g. 角色身份版「莉安」 / 场景图 / 黑白分镜图 / 机位截图. */
  label: string
  /** What this image locks, spelled into the legend line (e.g. "锁定角色
   *  「莉安」的脸型/服装/比例"). */
  usage: string
  /** Optional named subject for @-referencing (e.g. the character name). */
  subject?: string
  /**
   * Semantic slot in the 角色→道具→场景→分镜→机位 order. buildImageLegend
   * uses this to point CASTING LOCK at the right indices (character images
   * when present, else the camera plate) and to label the cinematography
   * block with the true index of the analyzed keyframe — the pack's
   * composition varies per row, so nothing may hardcode image numbers.
   */
  kind?: 'character' | 'prop' | 'scene' | 'storyboard' | 'camera'
}

export interface ShootRequest {
  /** The storyboard row this clip realizes. */
  row: BeatVideoRow
  /** Optional global art-style hint (e.g., "Cold-toned filmic noir"). */
  visualStyle?: string
  /**
   * The single image sent to Seedance as the omni-reference (全能参考).
   * Required — without a keyframe there's nothing to anchor casting,
   * scene, blocking, and color to.
   */
  keyframeUrl: string
  /**
   * Optional second image: the director storyboard grid (multi-panel sheet
   * with blocking / pacing / multi-beat info). When present it ships to
   * Seedance as a SECOND reference_image alongside the clean keyframe (全能参考
   * / omni-reference — both are reference_image, since Seedance rejects mixing
   * a literal first_frame role with a reference_image). The prompt legend then
   * designates the roles in text: @图片1 = 首帧 / 开场构图, @图片2 = 导演思维图
   * (storyboard sheet — read staging, never render its panels). Omit it to keep
   * the single-image behavior. Ignored in transition (first-last) mode.
   */
  storyboardRefUrl?: string
  /**
   * Multi-reference pack (多参考输入合成). When present (non-empty), it
   * REPLACES the [keyframeUrl, storyboardRefUrl] image pair as Seedance's
   * image inputs: every pack entry ships as a reference_image in array order
   * — 角色身份版 → 场景图 → 分镜图 → 机位截图 — and buildImageLegend @-points
   * each index at its subject. keyframeUrl is still required (it grounds the
   * cinematography-describe step and remains the fallback when the pack is
   * empty). Virtual-avatar asset refs are appended AFTER the pack by the
   * capability plugin, continuing the numbering. Ignored in transition mode.
   */
  referencePack?: ReferencePackImage[]
  /**
   * Optional context — character / scene / prop names + descriptions.
   * Baked into the motion text so the model knows what to look for in
   * the keyframe. NOT passed as additional image inputs.
   */
  contextRefs?: BeatVideoContextRef[]
  /** 16:9 by default; pass '9:16' for vertical shoots. */
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'
  /** Output resolution. Defaults to '720p' when omitted. Caller (UI) threads
   *  the user's selection through generateBeatVideo → here. */
  resolution?: '480p' | '720p' | '1080p'
  /**
   * Override the duration in seconds. Defaults to round(row.duration),
   * clamped to [5, 15] (Seedance's supported range).
   */
  durationSecondsOverride?: number
  /**
   * Optional caller-supplied augmenter that runs *after* the cinematographer
   * assembles its base prompt and *before* the Seedance call. Returns BOTH
   * the augmented prompt AND the list of 音色N voice audio URLs that should
   * travel as audio inputs to Seedance (so the model can match each spoken
   * line to its corresponding character voice). Used by actor-agent.
   * attachVoiceRefs.
   *
   * The augmenter is also allowed to be a plain string-returning function
   * (legacy shape) — in that case no voice audio inputs are added.
   */
  promptPostProcessor?: (
    prompt: string,
  ) =>
    | Promise<string | { videoPrompt: string; voiceAudioUrls?: string[] }>
    | string
    | { videoPrompt: string; voiceAudioUrls?: string[] }
  /**
   * BytePlus digital-asset ids (returned from
   * `byteplus-digital-asset.registerAndWait`) that should travel as
   * `invited_images` alongside the keyframe so the moderator sees the
   * referenced characters as approved. Used by the privacy-block fallback
   * chain in useStoryboardGenerate; empty / undefined in the normal path.
   */
  invitedImageAssetIds?: string[]
  /**
   * Virtual-avatar-library references for 真人 / live-action style. Each entry
   * is a platform (or registered) avatar whose `asset://<id>` URI ships to
   * Seedance as an extra `reference_image` content part so the character is
   * sourced from an approved synthetic persona instead of a photoreal face —
   * the proactive way to avoid the privacy-content (审查) block. The prompt
   * legend designates each one as @图片N = the named character. Presence forces
   * reference-to-video mode (asset refs can't be mixed with a first_frame).
   * Empty / undefined in non-real-person styles. See src/lib/virtual-avatar-library.
   */
  virtualAvatarRefs?: VirtualAvatarShootRef[]
  /**
   * When set, generate a transition clip via Seedance's first-last-frame
   * mode using these two boundary images instead of the omni-reference
   * keyframe. Bridge rows (inserted by storyboard-bridge) thread their
   * prev-row last-frame + next-row first-frame through this so the
   * generated clip actually animates from A to B instead of playing as
   * an independent shot. Keyframe is still required and is used by the
   * cinematography-describe LLM step for prompt grounding.
   */
  transitionFrames?: { firstFrameUrl: string; lastFrameUrl: string }
}

export interface BeatVideoResult {
  /** Video URL returned by the text-to-video capability. */
  url: string
  /** Full prompt that was sent (for retries / revise chain). */
  prompt: string
  /** Effective duration in seconds (post-clamp). */
  durationSeconds: number
  /** Keyframe URL that was used as the omni-reference. */
  keyframeUrl: string
  /** Context refs echoed back (text-only — not image inputs). */
  contextRefs: BeatVideoContextRef[]
}

/** One variant within a multi-strategy shoot. */
export interface ShootVariant {
  /** Short tag identifying the strategy ('stable' | 'balanced' | 'kinetic'). */
  strategyName: string
  /** Human-readable one-line description of what this variant emphasizes. */
  strategyDescription: string
  /** Video URL returned by Seedance for this variant. */
  url: string
  /** Full prompt that was sent (includes the strategy overlay). */
  prompt: string
  /** Effective duration in seconds. */
  durationSeconds: number
}

export interface MultiStrategyResult {
  /** All variants that successfully rendered (failed variants are dropped). */
  variants: ShootVariant[]
  /** Variants that failed, kept so the UI can report cost without surprise. */
  failures: Array<{ strategyName: string; reason: string }>
  /** Keyframe URL that fed every variant. */
  keyframeUrl: string
  /** Context refs (text-only) echoed back. */
  contextRefs: BeatVideoContextRef[]
}

export interface ReviseRequest {
  /** The shoot result that the director flagged for revision. */
  previous: BeatVideoResult
  /** Director-agent.critiqueVideoConsistency output. */
  feedback: VideoConsistencyIssue[]
  /**
   * Optional updated row, in case the director also tweaked the storyboard
   * fields (e.g., re-wrote motion_prompts). Defaults to the row that
   * produced `previous` — but since `previous` only carries the prompt,
   * callers usually pass the row again here for safety.
   */
  row: BeatVideoRow
  visualStyle?: string
  /** Same omni-reference image as the original shoot (or an updated one). */
  keyframeUrl: string
  contextRefs?: BeatVideoContextRef[]
  aspect?: '16:9' | '9:16' | '1:1' | '4:3'
  /** Output resolution. Defaults to '720p' when omitted. */
  resolution?: '480p' | '720p' | '1080p'
  durationSecondsOverride?: number
  /**
   * Same second-reference grid the original shoot used. Without it the
   * reshoot loses the storyboard staging reference.
   */
  storyboardRefUrl?: string
  /**
   * Same multi-reference pack the original shoot used, so the reshoot
   * keeps the identity-sheet / scene / storyboard / camera anchors.
   */
  referencePack?: ReferencePackImage[]
  /**
   * Same virtual-avatar refs the original shoot used. Without them a 真人
   * shot that only passed the privacy filter thanks to approved asset://
   * personas will fail (or drift faces) on the revise reshoot.
   */
  virtualAvatarRefs?: VirtualAvatarShootRef[]
}
