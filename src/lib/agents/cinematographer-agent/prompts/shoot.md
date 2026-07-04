---
id: shoot
inputs:
  imageLegend: string
  cinematographyBlock: string
  dialogueAndSfx: string
output: text (Seedance 2.0 video generation prompt)
---

【全能参考 / Director Reference】
使用上传的参考图作为生成依据；每张图的职责以下方【REFERENCE IMAGES / 参考图】legend 为准（图的数量与顺序随镜头变化，legend 是唯一权威）。
不要拍摄或展示任何参考图板本身；最终输出是干净的全屏电影画面。

【CASTING LOCK / 角色锁定】
角色脸型、发型、服装、体态必须与 legend 中标注的「CASTING 依据 / casting anchor」图一致。不要换角，不要增角。

【NEGATIVE】
不要图板边框、分栏、网格、箭头、字幕、subtitle、caption、watermark、logo、UI、乱码文字、credits、time codes、frame counters。In-world signage 只允许作为画面中实际存在的道具。

【全局硬约束 / GLOBAL HARD CONSTRAINTS】 (every rule below is Hard — must be obeyed)
* No Music Bed (Hard) — 严禁任何 BGM / 配乐 / 背景音乐 / soundtrack / score / instrumental music / orchestral cue / piano / strings / guitar / synthesizer / pad / drone / ambient music / lo-fi beat / electronica / drum / percussion / melodic loop / tonal hum. Do NOT add background music, score, or any non-diegetic music of any kind. The output audio MUST be silent of music.
* Audio = Dialogue + Diegetic SFX Only (Hard) — 音轨只允许两类声音：(a) 角色对白（按下方 音色N 引用合成）; (b) 画面内可见物体产生的 in-world 音效（脚步、呼吸、玻璃碎、风声、雨声、武器碰撞、机械咔嗒等）. 其他一切声音禁止。No score. No background music. No melodic loops. Silence is acceptable where there is no dialogue and no diegetic SFX.
* No On-Screen Text (Hard) — repeats the NEGATIVE block above; counts as hard.
* Casting Lock (Hard) — repeats the CASTING LOCK block above; counts as hard.

{{imageLegend}}

{{cinematographyBlock}}

{{dialogueAndSfx}}

【收尾 / ENDING ANCHOR】
最后 ~1 秒：保持终态构图，完成台词最后一个音节，不再触发新的动作。Hold the final composition and let the dialogue tail finish — no new motion in the last beat.

【NEGATIVE — final reminder before generation】
NO music bed. NO score. NO BGM. NO musical instruments. NO ambient soundtrack. NO subtitle. NO watermark. NO logo. NO frame borders.
