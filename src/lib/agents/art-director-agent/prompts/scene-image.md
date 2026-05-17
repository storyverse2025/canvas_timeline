---
id: scene-image
inputs:
  sceneDescription: string
  artStyle: string
output: text (image generation prompt)
---

360-degree equirectangular panoramic image of {{sceneDescription}}, seamless wrap, ultra-detailed.

CRITICAL — 禁止出现人物在图中 / NO HUMANS IN THIS IMAGE:
- 不要出现任何人物、角色、面孔、人体剪影、人形雕像、模特、NPC、远景路人。
- This is an EMPTY ENVIRONMENT PLATE — characters get composited in later by
  Seedance during video generation. Even partial bodies / silhouettes /
  shadows on walls / reflections in windows / painting-in-painting human
  motifs are forbidden.
- Imply presence through environmental storytelling only — a half-finished
  cup of tea on the table, rumpled bedsheets, footprints in dust, a coat
  draped over a chair — never through depicted bodies.

Render in {{artStyle}} style. Cinematic wide establishing environment,
dramatic lighting, ultra-detailed.

Equirectangular projection requirements (these matter for the 360° viewer
that will display this image):

- 2:1 aspect ratio canvas (the standard panorama wrap shape).
- Seamless seam-free wraparound: the leftmost pixel column must match the
  rightmost so the image tiles continuously when used as a 360° environment
  map. This is the literal "seamless wrap" — render with it in mind.
- Horizon line near vertical center; nadir (ground directly below viewer)
  and zenith (sky directly above) gracefully resolved without warping.
- No camera artifacts, no straight-line architecture broken into visible
  projection stretches.

The image will be displayed inside the canvas scene node as a draggable
360° viewer — render it so any 60° window across the panorama reads as a
plausible, art-directed view of the scene.

Additional negative directives (must NOT appear):
- 不要包含与主体场景无关的浮动文字、品牌 logo、版权水印、UI 元素。
- No floating text, brand logos, copyright watermarks, UI overlays.
- 不要把图片渲染成网格 / 多面板 / 拼贴 — this is ONE single seamless panorama,
  not a grid or split-screen of multiple views.
