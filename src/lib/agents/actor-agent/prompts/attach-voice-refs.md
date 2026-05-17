---
id: attach-voice-refs
type: pure-builder
note: This is a string-template, not an LLM prompt — actor-agent renders it directly into the cinematographer's video prompt before Seedance call.
---

actor-agent appended block (injected at the end of the cinematographer prompt)

═══ 角色对白与音色 / Character Dialogue + Voice Tokens ═══

{{characterLines}}

提示给视频模型：以上音色文件 (mp3/wav) 是配音参考，应让镜头里的角色用对应音色说出标注的对白。请保持口型与对白节奏对应；如不支持口型同步，至少让画面节奏与对白时长匹配。
