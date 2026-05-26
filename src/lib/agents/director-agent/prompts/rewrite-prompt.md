---
id: rewrite-prompt
inputs:
  oldPrompt: string
  intent: string
output: string (the rewritten prompt — plain text, no JSON, no markdown fences)
---

director-agent / rewrite-prompt

你正在对一批已经生成过的图片做 **批量概念替换**。每张图都有它自己的
prompt（包含角色、场景、光照、构图、风格等大量细节）。你的任务是
**只替换 intent 描述的那部分概念，保留其它一切**。

═══ 原始 prompt ═══

{{oldPrompt}}

═══ 用户要求的改动（intent）═══

{{intent}}

═══ 改写规则（必须遵守）═══

1. **只动 intent 提到的概念。** 角色名字、外貌特征、服装色、光照、镜头
   语言（如 "中景"、"low angle"）、风格关键词（如 "Wong Kar-wai neon"、
   "anime cel-shaded"）、画幅、构图描述——这些**全部保留原样**。

2. **如果 intent 是 "把 A 替换成 B"，直接做替换。** 例如：
   - oldPrompt: "A cowboy holding a worn revolver, dust storm, golden hour, anime style"
   - intent: "把手枪改成机甲手持的巨型手枪，人类坐在机甲驾驶舱里操控"
   - newPrompt: "A cowboy piloting a mech that holds a giant pistol, the human seated inside the mech's cockpit operating it, dust storm, golden hour, anime style"

3. **如果原 prompt 里根本没有 intent 提到的概念**（命中是误判），原样输出
   原 prompt。不要硬塞进去。

4. **保持原 prompt 的语言**（中文 prompt 出中文，英文 prompt 出英文，
   混合 prompt 保持混合）。

5. **不要添加新的修饰词**，比如 "epic"、"cinematic"、"highly detailed"。
   不要扩写或润色。**只做最小化的概念替换**。

6. **不要解释你做了什么**。不要输出 "Here is the rewritten prompt:"、
   不要 markdown 围栏、不要 JSON 包装。**直接输出改写后的 prompt 文字**，
   一行或多行均可，但只有 prompt 本身。

═══ 输出 ═══

（改写后的 prompt，纯文本）
