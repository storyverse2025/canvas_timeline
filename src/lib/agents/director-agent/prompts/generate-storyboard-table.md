---
id: generate-storyboard-table
inputs:
  artStyle: string
  totalDurationSeconds: number
  characterDesigns: string
  sceneDesigns: string
  propDesigns: string
  shotAllocation: string
  shotComposition: string
  visualStrategy: string
  elementContext: string
output: text (JSON array of storyboard rows)
---

director-agent / generate-storyboard-table

将以上所有分析整合，输出最终的分镜表 JSON 数组。

【时长硬约束（不可违反）】
- 用户已指定本片总时长为 **{{totalDurationSeconds}} 秒**。
- 所有分镜 row 的 duration 字段之和必须严格等于 {{totalDurationSeconds}} 秒（允许 0.5 秒以内的舍入误差）。
- **每一行 row 的 duration 必须满足 2 ≤ duration ≤ 15 秒**。
  - 任何 > 15s 的行必须立即拆分成多行（每行仍 2-15s）。
  - 任何 < 2s 的行必须与相邻行合并。
  - 想要长情绪段落？多行串联，每行最多 15s，主体/构图/节奏可以非常相近但必须有新动作或新情绪信息。
- 在编辑每个 row 的 duration 之前先做整体规划：按节拍权重分配各 row 时长，确保总时长 == {{totalDurationSeconds}} 且每行落在 [2, 15] 区间内。
- 输出前在心里逐行核对：每行 ∈ [2, 15]；Σ duration == {{totalDurationSeconds}}。违反任何一条则整张表作废。

【小蔡剧本转分镜 Skill 基准】
你不是单纯拆 shot list，而是把剧本先当作分镜前的创作基准：
- 先依据剧本动作建立情绪锚点，再生成每个镜头；禁止为切而切。
- 把抽象心理转成可拍/可演/可听的具象视听语言。
- 每个镜头必须说明情绪与氛围感如何指导后续焦段、光圈、机位、构图、运镜。
- 表格必须补充角色动机、心理状态、表演指导：演员为什么这样演、此刻面对什么处境、内在纠结是什么。
- 角色心理描写要来自剧本上下文，但输出要能指导表演和镜头，不能只写空泛文学句。

【单 row 演员/场景上限（硬约束）】
- 每一行 row 只能承载 **一个场景 (scene)** 和 **至多两位主要角色 (character1 + character2)**。
- 如果剧本同一个 beat 里出现 3 位以上有戏份的角色，**必须拆成多行**：第一行带主线角色对，下一行立刻切到新角色对（同场景不同人物 / 视点切换）。每行仍满足 2 ≤ duration ≤ 15s 和总时长锁定。
- 同理，如果一个 beat 跨越两个空间（例：从屋内拍到屋外），**必须为每个空间各开一行 row**，scene 字段填该行实际所在的那一个，不要把两个场景塞进同一个 scene.description。
- 拆分原则：保持因果与情绪连续（A 行结尾的动作 → B 行开头的反应/承接），但每行 character / scene 数量都不得超过上限。
- 字段意图：character1 / character2 是这一行需要参考其外形 / 表演的核心人物，不是路人。背景群演不要塞进 character 字段。

【多格导演分镜图与长视频 row 规则】
- 不要把连续动作机械拆成一堆 2-3 秒碎镜；对同一地点、同一动作链、同一情绪推进的内容，尽量合并为单个 10-15秒 长视频 row（仍 ≤ 15s）。
- 每个 row 的 storyboard_prompts 必须生成一张"多格导演分镜图 / multi-panel director storyboard sheet/grid"，而不是单张电影 still。
- 多格数量必须根据时长和节奏自动决定：短镜头可少格，10-15秒 或动作/情绪信息密集的 row 需要更多格，覆盖完整起承转合。
- 每格必须写清 timing slice、构图、机位/焦段/光圈、运镜、角色调度、视线/轴线、景深、转场，以及这一格新增的视觉信息或情绪信息。
- 允许轻微重复：为了保持连续性，角色姿态、空间方向、道具位置可以轻微重复；不要把这种连续性误判为单调。
- 合并后的 row 必须保持强一致动作情节：动作因果、角色目标、视线方向、空间轴线和情绪递进要连续，不得跳戏。
- 生成 keyframe 时把多格图当作"导演分镜板"；生成视频时要按格子顺序理解为时间推进，不要理解为最终视频的分屏。

重要：每行的 character1/character2 的 description 和 image_prompt 必须使用前面角色提取步骤中的详细描述，
scene 的 description 必须使用场景提取步骤中的详细描述。这样才能确保后续生成图片时角色和场景一致。

每行格式：
{
  "shot_number": "S1",
  "duration": 3.5,
  "visual_description": "完整画面描述",
  "visual_anchor": "该镜头的视觉锚点",
  "shot_size": "景别",
  "character_actions": "角色动作",
  "emotion_mood": "情绪关键词",
  "emotion_atmosphere": "情绪+氛围感：本镜要让观众感到什么，以及这种氛围如何指导镜头语言",
  "character_motivation": "角色动机：角色为什么这样行动/说话",
  "character_psychology": "心理状态：内在纠结、压力、潜台词、面对的处境",
  "performance_guidance": "表演指导：演员可执行的眼神/呼吸/手部/姿态/节奏",
  "lighting_atmosphere": "光影氛围",
  "dialogue": "对白",
  "storyboard_prompts": "english prompt for a multi-panel director storyboard sheet/grid, not a single still; include style: {{artStyle}}; choose panel count by duration/rhythm; each panel includes timing slice, composition, camera angle/lens/aperture/movement, blocking, eye-line/axis, depth of field, transition, and new visual/emotional information; this is storyboard guidance, not final split-screen video",
  "motion_prompts": "english video motion prompt following the panel progression from storyboard_prompts; include camera movement motivated by emotion_atmosphere and character_motivation; interpret the storyboard grid sequentially, not as a literal split-screen",
  "character1": { "image": "", "description": "从角色提取结果复制完整描述" },
  "character2": { "image": "", "description": "从角色提取结果复制完整描述" },
  "prop1": { "image": "", "description": "道具描述" },
  "prop2": { "image": "", "description": "" },
  "scene": { "image": "", "description": "从场景提取结果复制完整描述" }
}

字段硬约束：
- 每一行的 duration ∈ [2, 15]（秒）。任何超出区间的行都视为违反硬约束，整张表作废。
- 所有 row 的 duration 字段之和必须等于 {{totalDurationSeconds}} 秒（容差 ±0.5s）。这是 hard constraint，违反则整张表作废。
- **每一行只能填 1 个 scene + 至多 2 个 character (character1, character2)**。剧本同一 beat 有 3+ 角色 → 拆成多行；跨 2 个场景 → 拆成多行。违反则整张表作废。
- emotion_atmosphere 不等于 lighting_atmosphere；前者是情绪/氛围目标，后者是光影实现。
- character_motivation 必须回答"为什么这样表演/行动"。
- character_psychology 必须回答"心理纠结/潜台词/处境压力"。
- performance_guidance 必须是演员能演出来的身体细节，不要写抽象鸡汤。
- storyboard_prompts 必须明确是多格导演分镜图，并包含每格的时间切片和动作/情绪推进；不要只写单帧 keyframe prompt。
- motion_prompts 必须引用 storyboard_prompts 的格子顺序，让 Seedance 2 视频按多格时间推进生成，不要把多格图当最终分屏画面。

角色设计：
{{characterDesigns}}

场景设计：
{{sceneDesigns}}

道具设计：
{{propDesigns}}

镜头分配：{{shotAllocation}}
构图设计：{{shotComposition}}
视觉策略：{{visualStrategy}}
画布元素：{{elementContext}}

只输出 ```json ... ``` 代码块，不要其他文字。
