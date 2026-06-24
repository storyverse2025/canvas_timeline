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
- **每一行 row 的 duration 必须 ∈ [2, 15] 秒。** 任何 > 15s 的行必须拆分；任何 < 2s 的行必须与相邻行合并。修复后再次自检。
- **总时长锁定为 {{totalDurationSeconds}} 秒**。修复后所有 row 的 duration 字段之和必须等于 {{totalDurationSeconds}} 秒（容差 ±0.5s）。若问题列表中包含总时长或单行超界项，必须重新分配每行 duration。
- **每行 scene + character 人数上限**：一行只能有 1 个 scene + 至多 2 个 character。如自检指出某行有 3+ 角色或跨 2 场景，必须拆成多行，重新分配 duration 使总和仍等于 {{totalDurationSeconds}}。拆分时把原 character 信息分到不同行的 character1/character2 槽；scene 字段填实际所在场景。
- 确保修复后的景别分布合理
- 保持角色和场景的连续性
- **按自检 issue 主动合并同场景碎镜**：当 issue 指出某几行同场景且过碎（< 10s），把它们合并为单个 10-15s row，每个原行成为该 row 内 storyboard_prompts 的一格/cut（内容、运镜、对白逐格保留，不丢信息），并重算各 row 的 duration 使总和仍等于 {{totalDurationSeconds}}。跨场景的行不要合并。
- **补全 / 修正 transition_note**：换场景的行写开头过渡手法 + 上一行结尾 ~1s 留白；同场景连续的行写画面构图衔接；第一行写开场处理。让 storyboard_prompts 开头格体现过渡、独立 row 结尾格体现留白。
- 允许轻微重复；不要为了避免重复而破坏强一致动作情节、空间轴线、视线方向和情绪递进。

输出修复后的完整分镜表 JSON 数组（```json ... ```），不要其他文字。
