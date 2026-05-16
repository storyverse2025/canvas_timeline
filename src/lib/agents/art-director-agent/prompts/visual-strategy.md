---
id: visual-strategy
inputs:
  artStyle: string
  stylePreset: string
  scriptAnalysis: string
  visualAnchor: string
output: text (visual strategy document)
---

art-director-agent / visual-strategy

作为视觉总监，制定全局视觉策略。美术方向：{{artStyle}}

请基于此美术方向制定：
- 整体色彩方案（每幕的色调变化，须符合 {{stylePreset}} 风格）
- 镜头语言风格（手持/稳定/斯坦尼康）
- 光影基调（自然光/人工光/混合）
- 构图规则（三分法/中心/对称）
- 转场策略（硬切/溶解/匹配剪辑）

剧本分析：{{scriptAnalysis}}
视觉锚点：{{visualAnchor}}

输出视觉策略文档。
