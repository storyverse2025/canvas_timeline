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

Negative directives (must NOT appear in the prop reference sheet):
- 不要出现人脸 / no human faces, no portraits, no facial features at all.
- 不要出现手、手指、手臂或任何身体部位 / no hands, no fingers, no arms,
  no body parts of any kind (even partially).
- 不要把道具戴在脸上或身上 / do not show the prop being worn, held,
  or modeled by a person.
- 如果道具的功能涉及人体（如眼罩、面具、首饰），仍然只画道具本身在中性
  背景上的多视角，不要出现承载它的脸或身体——必要时可以用透明假人/
  隐形模特轮廓示意佩戴位置，但绝不可有任何皮肤、五官或人物剪影。
- 不要画品牌 logo、版权标志、文字水印。
