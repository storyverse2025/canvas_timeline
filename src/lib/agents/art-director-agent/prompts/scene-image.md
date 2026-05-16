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
- No camera artifacts, no warped people, no straight-line architecture broken into
  visible projection stretches.

This image will be displayed inside the canvas scene node as a draggable
360° viewer — render it so any 60° window across the panorama reads as a
plausible, art-directed view of the scene.
