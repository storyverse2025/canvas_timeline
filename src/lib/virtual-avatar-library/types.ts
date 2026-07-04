/**
 * Virtual Avatar Library (虚拟人像库) — type definitions.
 *
 * Volcengine's Seedance virtual avatar library provides platform-owned,
 * pre-approved synthetic personas that can be referenced when generating
 * video. Because they are approved assets, referencing them avoids the
 * `InputImageSensitiveContentDetected.PrivacyInformation` content-review
 * block that real-person reference images trip.
 *
 * Doc: https://www.volcengine.com/docs/82379/2223965
 */

export type AvatarGender = 'male' | 'female' | 'neutral'

/**
 * One virtual avatar asset from the library.
 *
 * `id` is the platform asset id (the value that ends up in the Seedance
 * request — exact binding field confirmed in the Phase-0 spike). `name` is
 * the `@素材名` token shown in the experience center. `uri` is the public
 * reference-image URL, used when the avatar is shipped as a reference_image
 * content part rather than (or in addition to) an asset-id binding.
 */
export interface VirtualAvatarAsset {
  id: string
  name: string
  uri?: string
  gender: AvatarGender
  /** Inclusive age bounds used to match against a casting card's age range. */
  ageMin: number
  ageMax: number
  /** Lowercased nationality/ethnicity token, e.g. 'chinese', 'east_asian'. */
  nationality?: string
  /** Freeform descriptors for tie-break matching (hair, build, vibe…). */
  tags?: string[]
}

/** Result of matching a casting card against the catalog. */
export interface AvatarMatch {
  avatar: VirtualAvatarAsset
  /** Higher = better. Deterministic; ties broken by avatar id. */
  score: number
}
