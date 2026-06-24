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

你的任务：把"医生诊断后剧本"+ 角色/场景/道具设计 + 镜头分配/构图/视觉策略 整合，最终输出可直接喂下游 keyframe / video 的分镜表 JSON 数组。具体输出指令在本提示词末尾，请先读完全部硬约束与输入再开始构思。

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
- **默认节奏：绝大多数 row 应落在 10-15 秒。** 不要把内容机械拆成一堆 2-3 秒碎镜。只有用户显式快剪 / RAPID CUTS / 明确的强节奏点才允许 row < 10s（仍 ≥ 2s）。
- **只要场景不变，就把同一场景内连续的多个分镜/镜头合并进一个 10-15 秒 row**，每个原分镜成为该 row 内的一格 / 一个 cut。换句话说：一个 row = 一个不超过 15s 的"场景片段"，里面可以包含**同场景的多个 cut（机位切换、景别切换、视点切换）**，不再只限于单一连续镜头的时间推进。
- 一旦**场景发生变化**（换地点 / 换空间），必须**另起一个新的 row**——不要把两个场景塞进同一个 row。
- 每个 row 的 storyboard_prompts 必须生成一张"多格导演分镜图 / multi-panel director storyboard sheet/grid"，而不是单张电影 still。
- 多格数量必须根据时长和节奏自动决定：10-15秒 或包含多个 cut 的 row 需要更多格，覆盖完整起承转合；每个 cut 至少一格。
- 每格必须写清 timing slice、构图、机位/焦段/光圈、运镜、角色调度、视线/轴线、景深、转场，以及这一格新增的视觉信息或情绪信息。同 row 内相邻两格如果是不同 cut，要写清楚它们之间是硬切 / 匹配剪辑 / 运镜衔接。
- 允许轻微重复：为了保持连续性，角色姿态、空间方向、道具位置可以轻微重复；不要把这种连续性误判为单调。
- 合并后的 row 必须保持同场景内的强一致动作情节：动作因果、角色目标、视线方向、空间轴线和情绪递进要连续，即便切了机位也不得跳戏 / 跳场。
- 生成 keyframe 时把多格图当作"导演分镜板"；生成视频时要按格子顺序理解为时间推进（含 row 内的 cut 切换），不要理解为最终视频的分屏。

【前后衔接（transition_note 字段，必填）】
逐行思考"这一行相对上一行如何衔接"，把关键设计写进 `transition_note`：
- **独立 row（相对上一行换了场景 / 时间 / 空间，是一次硬切）**：
  - 开头要有**过渡手法**，并写清用哪一种（鼓励多样化，不要每次都一样）：对白关键词呼应（上一行结尾的台词关键词在本行开头被接住）、匹配剪辑 match-cut（相似构图/形状/动作承接）、场景穿越（镜头穿过门/窗/物体进入新场景）、动作衔接（上一行的动作在本行延续）、声音先入 J-cut 等。
  - 本行**结尾保留 ~1s 留白**（一个安静的 hold / 呼吸点），避免硬切显得仓促。
- **连续 row（相对上一行还在同一场景、同一动作链）**：写**画面构图衔接**——上一行收尾画面的机位、景别、视线方向、角色位置 / 朝向、调度，如何被本行开头那一格自然承接（让观众感觉是同一段戏在推进，不是新起一镜）。
- **第一行**：`transition_note` 写开场处理（冷开场 / 定场镜头 / 渐入等）。
- `transition_note` 的设计必须落到画面：本行 `storyboard_prompts` 的**开头格**要体现这里写的过渡手法；独立 row 的**结尾格**要体现 ~1s 留白；`motion_prompts` 也要相应带上开头过渡与结尾留白，让最终视频真的有过渡和呼吸。

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
  "transition_note": "相对上一行的衔接设计：换场景→开头过渡手法（点名是对白关键词呼应/匹配剪辑/场景穿越/动作衔接等）+ 本行结尾~1s留白；同场景连续→画面构图衔接（机位/景别/视线/角色位置如何承接上一行收尾画面）；第一行写开场处理",
  "storyboard_prompts": "english prompt for a multi-panel director storyboard sheet/grid, not a single still; include style: {{artStyle}}; choose panel count by duration/rhythm; a single same-scene row may contain multiple cuts (the opening panel must realize the transition device noted in transition_note; for a scene-change row reserve ~1s hold/breath in the final panel); each panel includes timing slice, composition, camera angle/lens/aperture/movement, blocking, eye-line/axis, depth of field, transition, and new visual/emotional information; this is storyboard guidance, not final split-screen video",
  "motion_prompts": "english video motion prompt following the panel progression from storyboard_prompts; open with the transition_note device, end a scene-change row with ~1s hold/breath; include camera movement motivated by emotion_atmosphere and character_motivation; interpret the storyboard grid sequentially (including cut changes), not as a literal split-screen",
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
- transition_note 必填且不能空泛：换场景的行必须点名开头过渡手法 + 结尾 ~1s 留白；同场景连续的行必须写出画面构图如何承接上一行；第一行写开场处理。

【尊重用户已经写好的分镜（最高优先级，但用"格/cut"而非"行"来保留）】
- 如果"医生诊断后剧本"里有形如 **"镜头 A / 镜头 B / 镜头 C"、"SERIES OF SHOTS"、"RAPID CUTS"、"FLASH IMAGES"、"SHOT N"、"场景 N. 时间.地点"** 等显式分镜/段落标记，**每一个标记的内容都必须完整保留、不可丢失、不可摘要合写**（拒绝"【0-30s】角色 A 做了 XYZ"这种把若干镜头压成一句的写法）。
- **保留 ≠ 每个标记都单独成行**：同一场景内连续的多个显式标记，应**合并进一个 10-15s row**，每个标记成为该 row 内 storyboard_prompts 的**一格 / 一个 cut**（按原顺序、原内容、原运镜逐格落地）。只有当标记**跨到新场景**时才另起新 row。这样既不丢用户内容，又满足"少而长"的节奏。
- 用户在剧本里写明的运镜（"摄像机拉远"、"快剪"、"慢动作"、"闪回"、"特写/中景/全景"标注）必须**逐字保留**到对应那一格 / row 的 `visual_description` / `shot_size` / `storyboard_prompts` / `motion_prompts` 字段里。这是 keyframe 和视频生成阶段必须看到的明确指令，不要翻译成抽象语言。
- "RAPID CUTS" / "FLASH IMAGES" 通常列出 3-5 个子镜头（典型每个 1-2 秒）：把它们**作为同一个 row 内的连续多格快剪**保留（同场景时尤其如此），每个子镜头一格，保留快剪节奏；不要摘成一句，也不必为每个 1-2s 子镜头单独开一行。仅当子镜头跨越不同场景时才拆成多行。
- 用户在剧本里对镜头数量已经给出明确暗示时（"系列镜头 ABC = 3 个"、"凯/陆/空 三人各一段战斗 = 3 个"），优先把这些数量落实为**格 / cut 的数量**（同场景就在一个 row 内分格；跨场景才跨行），再让 totalDurationSeconds 约束最终时长。
- **反摘要硬约束**：如果"医生诊断后剧本"看起来已经是【0-20s】这种时间码段落格式（说明上游 script-agent 出了 bug 没保留分镜），你仍然要尝试从原剧本结构推断出合理的镜头切分，而不是直接拿时间段当 row。

【医生诊断后剧本（权威基准，所有镜头必须忠实于它，不要再次"扩写"或"总结"它，只是把它转成分镜；剧本里如果有显式分镜标记，每个标记都要完整保留为一格/cut——同场景合并进一个 10-15s row 的多格，跨场景才另起新 row）】
{{revisedScript}}

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

═══ 输出指令（最重要，最后阅读） ═══
现在把上面"医生诊断后剧本"+ 所有设计 + 分配/构图/策略 整合为最终分镜表 JSON 数组。**输出格式必须是 ```json ... ``` 代码块，里面是一个 JSON 数组**，第一个字符是 `[`，最后一个字符是 `]`。不要输出任何解释、思路、Markdown 标题、提纲或自然语言段落。不要先写"好的，我来整合"，不要写"分镜表如下"。直接给代码块。整张表必须满足上文的所有硬约束（每行 2-15s、总时长锁定、单 row 一个 scene + 至多两位 character、字段齐全等）。
