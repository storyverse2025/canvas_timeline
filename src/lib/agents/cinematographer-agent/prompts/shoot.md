---
id: shoot
inputs:
  motionDescription: string
  imageLegend: string
output: text (Seedance 2.0 video generation prompt)
---

{{motionDescription}}

【全能参考 / Director Reference】
使用上传的同一张 @图片1 / image1 作为导演分镜调度图参考。@图片1 不是最终画面，
不要拍摄或展示这张图板本身。请从图中读取角色 casting、服装锚点、场景设定、镜头序列、
调度关系、轴线/视线、光影氛围、色彩、运动方向和情绪节奏。最终输出必须是干净的
全屏电影画面。强烈的电影感与镜头语言，动态夸张，动作清晰有冲击力。

【CASTING LOCK / 角色锁定】
确保角色的脸型、发型、服装配色、体态、武器和角色关系必须和参考图保持一致。

【NEGATIVE】
不要出现图板边框、分栏、网格、箭头、注释文字、字幕、logo、水印、UI、乱码文字。
不要换角，不要增角，不要把背景人物/路人/怪物/士兵/分身当主角。

{{imageLegend}}
