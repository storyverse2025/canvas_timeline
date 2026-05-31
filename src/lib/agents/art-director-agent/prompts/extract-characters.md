---
id: extract-characters
inputs:
  scriptAnalysis: string
  artStyle: string
output: ExtractedCharacter[] (JSON only)
---

你是角色设计专家（art-director-agent / extract-characters）。基于剧本分析，提取并丰富每个角色的视觉描述。

剧本分析：
{{scriptAnalysis}}

美术风格：{{artStyle}}

为每个角色输出详细的视觉设计 JSON 数组：
```json
[
  {
    "name": "角色名",
    "gender": "female/male",
    "age": "年龄描述",
    "appearance": "详细外貌描述（发型、发色、肤色、五官特征）",
    "clothing": "服装描述（款式、颜色、材质、配饰）",
    "expression": "默认表情/气质",
    "body_type": "体型描述",
    "distinctive_features": "标志性特征（疤痕、纹身、特殊配饰等）",
    "height": "身高数值带单位，例 \"172cm\"。剧本未明示就按性别/年龄/体型给一个合理估值。**关键约束**：同一次抽取里所有角色的身高必须彼此可比、合乎情理（成年男平均 175cm、成年女平均 162cm、青少年按年龄递减、儿童 110-140cm），不要给两个成年角色一个 180cm 一个 150cm 除非剧本明确这么写——下游 keyframe 会按这些数字锁定相对比例",
    "image_prompt": "完整的英文人物三视图图片生成 prompt：**渲染指令只用全局美术风格 {{artStyle}} 这一段文字**，不要叠加 Sony Venice / Panavision / Final Fantasy CG / Unreal Engine 5 / 8K 等额外相机/镜头/引擎/分辨率术语；构图为纯白背景，上面1/3人物正面脸部超特写且表情自然，下面2/3分三块展示颈部以下到脚部的正/侧/背三视图（不要出现头部），双手自然垂落；同时包含上述所有角色视觉信息。**必须**在三视图区域右侧画一根竖直的浅灰色比例尺标尺（vertical scale ruler），从 0cm 到 200cm 每 10cm 一格、每 50cm 标数字，角色头顶高度对齐到该角色的 height 数值刻度——下游 keyframe 会用这个标尺锚定全片角色比例"
  }
]
```
只输出 JSON，不要其他文字。
