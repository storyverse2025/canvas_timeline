---
id: apply-timeline-fixes
inputs:
  storyboardJson: string
  issuesList: string
  totalDurationSeconds: number
output: text (fixed JSON array)
---

director-agent / apply-timeline-fixes

你是分镜修复专家。根据自检发现的问题修复分镜表。

问题列表：
{{issuesList}}

原始分镜表：
{{storyboardJson}}

修复规则：
- 只修改有问题的镜头，不要改动正确的部分
- **[anchor-missing An] 类问题必须新增 row**（不是 edit），shot 字段为 'MISSING' 时插在 fix 建议指定的位置；shot 指明现有镜号时插入到该镜号之后；新 row 的 visual_description / character_actions / storyboard_prompts 必须用 issue 给出的锚点字面描述（不要重新概括）。
- **[anchor-diluted An] 类问题必须把被合并的 row 拆开**，每个原剧本的 RAPID CUT / 镜头 / 招式各占一行，每行专注一个锚点；不要再把它们压回去。
- **[anchor-replaced An] 类问题必须把被改写的字段恢复成 issue 中的"原 X"字面**（特别是 dialogue 字段：剧本原台词不能改写、弱化或翻译）。
- **每一行 row 的 duration 必须 ∈ [2, 15] 秒。** 任何 > 15s 的行必须拆分；任何 < 2s 的行必须与相邻行合并。修复后再次自检。
- **总时长锁定为 {{totalDurationSeconds}} 秒**。修复后所有 row 的 duration 字段之和必须等于 {{totalDurationSeconds}} 秒（容差 ±0.5s）。若 anchor 类 issue 增加了新 row，必须按比例缩短其它非锚点 row 的 duration 把总和拉回 {{totalDurationSeconds}}（不要简单删除别的 row）。
- **每行 scene + character 人数上限**：一行只能有 1 个 scene + 至多 2 个 character。如自检指出某行有 3+ 角色或跨 2 场景，必须拆成多行，重新分配 duration 使总和仍等于 {{totalDurationSeconds}}。拆分时把原 character 信息分到不同行的 character1/character2 槽；scene 字段填实际所在场景。
- 确保修复后的景别分布合理
- 保持角色和场景的连续性
- 优先把同一地点、同一动作链、同一情绪推进的碎镜合并多个分镜到单个 10-15秒 row（仍然 ≤ 15s），并在 storyboard_prompts 中写成多格导演分镜图。
- 允许轻微重复；不要为了避免重复而破坏强一致动作情节、空间轴线、视线方向和情绪递进。

输出修复后的完整分镜表 JSON 数组（```json ... ```），不要其他文字。
