---
id: allocate-shots
inputs:
  scriptAnalysis: string
  visualStrategy: string
  totalDurationSeconds: number
  revisedScript: string
output: text (shot allocation plan)
---

director-agent / allocate-shots

作为分镜导演，制定镜头分配计划：
- 每个叙事段落分配多少个镜头
- 每个镜头的景别分配（保证景别多样性）
- 节奏控制（快切 vs 长镜头的分布）
- **少而长优先**：同一场景 / 同一叙事段落优先分配少而长（目标 10-15 秒）的镜头，把同场景的多个机位 / cut 归到同一个长镜头单元里，避免默认切太碎。只有用户显式快剪、RAPID CUTS 或明确强节奏点才分配 < 10s 的短镜头。
- 总时长 = {{totalDurationSeconds}} 秒（硬约束 — 每镜头分配的总时长之和必须等于此值；每个镜头本身的时长必须 ∈ [2, 15] 秒）

【尊重用户已经写好的分镜（最高优先级）】
- 如果"医生诊断后剧本"里有形如 **"镜头 A / B / C"、"SERIES OF SHOTS"、"RAPID CUTS"、"FLASH IMAGES"、"SHOT N"、"场景 N. 时间.地点"** 等显式分镜/段落标记，**必须为每一个标记单独分配 1 个镜头**。不要把多个标记合并、也不要按时间段聚合。
- 用户在剧本里写明的运镜（"摄像机拉远"、"快剪"、"慢动作"、"特写/中景/全景"）必须**逐字保留**到对应镜头的景别 / 运镜说明里。
- "RAPID CUTS" / "FLASH IMAGES" 通常列出 3-5 个子镜头，每个独立分配，典型每个 2-4 秒。
- 用户在剧本里给出的镜头数量暗示（"系列镜头 ABC = 3 个"、"凯/陆/空 三人各一段战斗 = 3 个"）优先匹配，再让 totalDurationSeconds 约束最终时长。
- 只有当用户剧本没有显式分镜结构时，才从剧本分析自由发明镜头分配。

医生诊断后剧本（权威基准，按这个来切镜头数，不要按分析摘要重新发明）：
{{revisedScript}}

剧本分析：{{scriptAnalysis}}
视觉策略：{{visualStrategy}}

输出镜头分配表（场景→镜头数→景别→时长），可以是简单的列表/markdown 格式，后续 compose-shots 会读取它。
