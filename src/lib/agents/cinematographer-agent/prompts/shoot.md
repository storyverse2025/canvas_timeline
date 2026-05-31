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

{{imageLegend}}

{{cinematographyBlock}}

{{dialogueAndSfx}}
