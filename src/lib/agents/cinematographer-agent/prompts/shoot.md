---
id: shoot
inputs:
  imageLegend: string
  cinematographyBlock: string
  dialogueAndSfx: string
output: text (Seedance 2.0 video generation prompt)
---

【全能参考 / Director Reference】
使用上传的 @图片1 / image1 作为起始帧 / 主参考。从图中读取角色、服装、场景、调度、光影、运镜节奏。
不要拍摄或展示这张图板本身；最终输出是干净的全屏电影画面。

【CASTING LOCK / 角色锁定】
角色脸型、发型、服装、体态必须与 @图片1 一致。

【NEGATIVE】
不要图板边框、分栏、网格、箭头、字幕、logo、水印、UI、乱码文字。不要换角，不要增角。

【AUDIO / 音轨】
仅保留对白与音效。NO background music, NO score, NO musical instruments, NO ambient soundtrack。不要任何配乐或BGM。

{{imageLegend}}

{{cinematographyBlock}}

{{dialogueAndSfx}}

【收尾 / ENDING ANCHOR】
最后 ~1 秒：保持终态构图，完成台词最后一个音节，不再触发新的动作。Hold the final composition and let the dialogue tail finish — no new motion in the last beat.
