---
id: allocate-shots
inputs:
  scriptAnalysis: string
  visualStrategy: string
  totalDurationSeconds: number
output: text (shot allocation plan)
---

director-agent / allocate-shots

作为分镜导演，制定镜头分配计划：
- 每个叙事段落分配多少个镜头
- 每个镜头的景别分配（保证景别多样性）
- 节奏控制（快切 vs 长镜头的分布）
- 总时长 = {{totalDurationSeconds}} 秒（硬约束 — 每镜头分配的总时长之和必须等于此值；每个镜头本身的时长必须 ∈ [2, 15] 秒）

剧本分析：{{scriptAnalysis}}
视觉策略：{{visualStrategy}}

输出镜头分配表（场景→镜头数→景别→时长），可以是简单的列表/markdown 格式，后续 compose-shots 会读取它。
