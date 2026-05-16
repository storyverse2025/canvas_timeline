---
id: compose-shots
inputs:
  shotAllocation: string
  visualAnchor: string
output: text (per-shot composition design)
---

director-agent / compose-shots

作为构图设计师，为每个镜头设计具体构图：
- 画面主体位置和大小（参考导演分镜知识库中"01 · The Subject"）
- 前景/中景/背景层次（参考"05 · The Aesthetic"）
- 引导线和视觉重心
- 角色站位和走位
- 光源方向和阴影（参考"灯光设计"）
- 视线/轴线（180° 规则）

镜头分配：{{shotAllocation}}
视觉锚点：{{visualAnchor}}

输出每个镜头的构图设计说明，可以是按镜号分段的 markdown。后续 generate-storyboard-table 会读取它。
