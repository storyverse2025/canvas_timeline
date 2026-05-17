---
id: scene-image
inputs:
  sceneDescription: string
  artStyle: string
output: text (image generation prompt)
---

360° immersive equirectangular panorama, 4K ultra-high definition: {{sceneDescription}}.

{{artStyle}} style. Cinematic wide establishing environment, dramatic lighting, ultra-detailed.

Equirectangular projection requirements:
- 2:1 aspect ratio canvas (the standard panorama wrap shape).
- Seamless seam-free wraparound: the leftmost pixel column must match the rightmost
  so the image tiles continuously when used as a 360° environment map.
- Horizon line near vertical center; nadir (ground directly below viewer) and zenith
  (sky directly above) gracefully resolved.
- No camera artifacts, no straight-line architecture broken into visible projection
  stretches.

This image will be displayed inside the canvas scene node as a draggable
360° viewer — render it so any 60° window across the panorama reads as a
plausible, art-directed view of the scene.

Negative directives (must NOT appear in the scene panorama):
- 不要出现任何人物、角色、面孔、人体剪影或人形雕像。这是空场景 (empty environment plate)，
  人物会在视频生成时由 Seedance 合成进画面。
- No characters, no people, no human figures, no faces, no human silhouettes, no
  mannequins. NPCs in the distance, crowd in the background, statues with human
  features — all forbidden.
- 不要包含与主体场景无关的浮动文字、品牌 logo、版权水印、UI 元素。
- 不要把人物剪影合成进窗户倒影、墙面阴影、画中画 — 即使是间接的人形线索也不可以。
- The atmosphere (lighting, weather, props in place) must imply human presence
  through environmental storytelling (a half-finished cup of tea, rumpled
  bedsheets, footsteps in dust) but NEVER through depicted bodies.
