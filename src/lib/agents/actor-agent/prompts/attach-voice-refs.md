---
id: attach-voice-refs
type: pure-builder
note: String template, not an LLM prompt — actor-agent renders it into the cinematographer prompt. Dialogue itself is already 音色N-annotated inline in the 【对白 / DIALOGUE】 block above; this block is just the slot→voice manifest plus model instructions.
---

【音色映射 / VOICE MAPPING】
{{characterLines}}

提示给视频模型 (Seedance) — 重要：
- 每个 `音色N` 对应 Seedance 输入中第 N 个 audio reference（已作为 audio_url 上传）：音色1 = audio reference 1，音色2 = audio reference 2，以此类推。
- 上方 【对白 / DIALOGUE】 已在每行旁标注了 `(音色N)`。镜头里对应角色说话时，请用 *该 N 号音色* 的声纹 / 音色 / 语速 / 口音。不要混用音色，不要让 A 角色说出 B 音色。
- 保持口型 / 节奏 / 时长与对白匹配。若模型不支持口型同步，至少让人物开口 / 闭口的节奏与对白时长一致。
- 仅限于本镜头出场的角色；本镜头未出场的角色（即使存在音色绑定）不要插入对白。
