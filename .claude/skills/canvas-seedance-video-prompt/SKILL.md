---
name: canvas-seedance-video-prompt
description: Convert Canvas Timeline storyboard rows, keyframes, and upstream references into Seedance 2.0 / Ark video prompts. Use for Beat Video, cinematographer-agent, or Director Assistant video prompt generation.
---

# Canvas Timeline Seedance Video Prompt

This project-local skill adapts the external `seedance-prompt-zh` guide for Canvas Timeline's API-based generation path.

## Core rule

不要原样照搬 @图片1 / @视频1 / @音频1 as if Canvas were the Jimeng web UI. Canvas sends media through Ark/Seedance API content parts, so prompts must describe the reference roles in natural language and keep the actual media routing in code.

## Inputs

- `StoryboardRow`: `visual_description`, `storyboard_prompts`, `motion_prompts`, `character_actions`, performance/emotion fields, `dialogue`, `sound_effects`, `bgm`.
- Keyframe image: treated as 首帧 / first-frame composition anchor.
- Optional clean keyframe + storyboard grid: clean image is the visual anchor; grid is only director timing/blocking guidance.
- Context refs: 角色参考, 场景参考, 道具参考 from row slots or upstream canvas nodes.
- Global style / art direction node.

## Output contract

A Canvas Seedance prompt should contain:

1. `【Seedance 2.0 视频生成指令】` with shot id and duration.
2. `【参考素材用途】` mapping references to roles:
   - 首帧: keyframe/image1 locks opening composition, character identity, costume, scene, lighting.
   - 角色参考: character slot descriptions or approved avatar refs.
   - 场景参考: scene slot/upstream scene description.
   - 道具参考: prop slot/upstream prop description.
3. `【主体 / 场景 / 风格】` from row description and global style.
4. `【表演与情绪】` grounded in visible performance: eyes, breath, hands, posture, gait rhythm.
5. `【分时段动作与运镜】`; for clips over 8 seconds, use time segments.
6. `【导演分镜格信息】` when a multi-panel storyboard grid exists.
7. `【声音设计】` for dialogue, diegetic SFX, and explicit music/BGM constraints.
8. `【一致性约束】` preserving identity, costume, scene, lighting, and motion direction.

## Multi-panel storyboard rule

If the reference image is a multi-panel director storyboard sheet/grid, explicitly say:

- Read the panels in order as motion, emotion, blocking, and camera progression.
- Do not render panel borders, arrows, captions, timecodes, UI, or grid layout.
- 不要理解为最终视频的分屏画面 / not a literal split-screen.

## Duration and complexity

Seedance 2.0 supports roughly 4–15 秒 output. Canvas currently clamps Beat Video duration to 5–15 seconds. Match prompt complexity to duration: do not stuff four locations into a 5-second shot unless the desired result is chaos wearing a hat.

## Media routing discipline

Default Beat Video should send the keyframe as the primary image reference and carry character/scene/prop information in text. Only use extra image references through an explicit, validated reference-pack mode; reject bad URLs, relative paths, stale node markers, malformed base64, and SVG data URLs before Seedance submission.
