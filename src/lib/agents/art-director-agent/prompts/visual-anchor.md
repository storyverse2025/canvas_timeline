---
id: visual-anchor
inputs:
  scriptAnalysis: string
  characterDesigns: string
  sceneDesigns: string
  elementContext: string
output: text (visual anchor description)
---

art-director-agent / visual-anchor

基于剧本分析和已有画布元素，提取视觉锚点：
- 每个场景的核心视觉标识（色调、构图母题、标志性道具）
- 角色的视觉一致性锚点（服装颜色、特征配饰、体型比例）
- 跨镜头的视觉连接线索

剧本分析：
{{scriptAnalysis}}

角色设计：
{{characterDesigns}}

场景设计：
{{sceneDesigns}}

画布元素：
{{elementContext}}

输出每个场景/角色的视觉锚点列表。
