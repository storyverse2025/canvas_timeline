---
id: compose-shots
inputs:
  shotAllocation: string
  visualAnchor: string
  revisedScript: string
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

【尊重用户原剧本里的视觉指令】
- 如果剧本里写明了某镜的运镜 / 机位 / 焦段 / 景别 / 光影（例如"摄像机拉远"、"低角度仰拍"、"剪影逆光"），把它**直接用在该镜的构图设计里**，不要替换成"更标准"的方案。
- 如果剧本里描述了具体走位（"莉安跨过裂缝"、"陆翻滚倒挂在浮空石上"），保留为构图的核心动作。
- 用户没有写明的镜头才由你自由设计。

医生诊断后剧本（按这个来对照镜头分配，复用剧本里的具体视觉指令）：
{{revisedScript}}

镜头分配：{{shotAllocation}}
视觉锚点：{{visualAnchor}}

输出每个镜头的构图设计说明，可以是按镜号分段的 markdown。后续 generate-storyboard-table 会读取它。
