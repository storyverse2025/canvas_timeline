---
id: prop-image
inputs:
  propDescription: string
  artStyle: string
output: text (image generation prompt)
---

Prop turnaround sheet, multi-angle reference: {{propDescription}}.

{{artStyle}} style. Studio lighting, pure neutral background, ultra-detailed,
4k professional prop concept art.

Layout (4-panel turnaround on a single sheet):
- Top-left: front view (3/4 hero angle).
- Top-right: side view (strict 90° profile).
- Bottom-left: back view.
- Bottom-right: extreme close-up of the most story-significant detail
  (material, texture, engraving, mechanism — whatever earns the prop its
  on-screen weight).

Consistency mandate:
- 100% consistent shape, proportions, color, material across all four panels.
- No background props, no distracting decoration; the prop is the only subject.
- No floor shadows that anchor it to a specific location — this is a clean
  reference sheet, not an in-scene shot.
- Match the global art style exactly: lighting temperature, line treatment,
  shading style, and color palette all flow from {{artStyle}}.

Output must be a single composed turnaround sheet image, not separate frames.
