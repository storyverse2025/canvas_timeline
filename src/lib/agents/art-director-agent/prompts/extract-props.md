---
id: extract-props
inputs:
  scriptAnalysis: string
  artStyle: string
output: ExtractedProp[] (JSON only)
---

你是道具设计专家（art-director-agent / extract-props）。基于剧本分析，提取关键道具的视觉描述。

剧本分析：
{{scriptAnalysis}}

美术风格：{{artStyle}}

为每个关键道具输出 JSON 数组（只提取剧情中重要的道具，不超过5个）：
```json
[
  {
    "name": "道具名",
    "description": "外观描述",
    "material": "材质",
    "significance": "剧情意义",
    "dimensions": "尺寸数值带单位，例 \"长 30cm × 宽 8cm\" / \"直径 15cm\" / \"高 1.8m\"。剧本未明示就给合理估值。**关键约束**：同一次抽取里所有道具尺寸彼此自洽（手枪 ~25cm，长剑 ~90cm，背包 ~50cm，水杯 ~10cm），不要让一把小刀和一支步枪都标 30cm",
    "scale_reference": "相对参照（必填），从下列锚点里选最贴切的：\"指节大小\" / \"掌心大小\" / \"前臂长度\" / \"半人高\" / \"齐人高\" / \"超过人高\"——给图像模型一个具象人体参照系",
    "image_prompt": "完整的英文图片生成 prompt，product shot on neutral background，适合 {{artStyle}} 风格。**必须**在道具旁边按 scale_reference 加一个对应大小的人手剪影或竖直比例尺：指节/掌心大小→画一只张开的手作背景参照；前臂长度→画一条前臂；半人高/齐人高/超过人高→画一个 175cm 的竖直人形剪影作高度参照。背景仍保持简洁中性"
  }
]
```
只输出 JSON，不要其他文字。如果没有关键道具，输出空数组 []。
