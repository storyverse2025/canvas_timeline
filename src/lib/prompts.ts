/**
 * System prompt templates — decoupled from code for easy optimization.
 *
 * Placeholders use {{variable}} syntax, replaced at runtime.
 * Each prompt has an id, a human-readable label, and the template text.
 */

export interface PromptTemplate {
  id: string
  label: string
  template: string
}

export const PROMPTS: Record<string, PromptTemplate> = {
  // ─── Director Pipeline: 优化阶段 ────────────────────────────────

  scriptToCastingFlow: {
    id: 'scriptToCastingFlow',
    label: 'Script → Casting 智能优化总控',
    template: `你是 canvas_timeline 的“导演助手 — 智能优化流程”总控。

本项目已在服务器项目目录保存并可被 Claude/bridge 发现的技能：
- .claude/skills/script-framework-qa/SKILL.md：script-framework-qa，用于七层问答、项目档案、剧本框架校准。
- .claude/skills/script-writing-expansion/SKILL.md：script-writing-expansion，用于把框架/大纲扩成完整剧本。
- .claude/skills/script-doctor-roundtable/SKILL.md：script-doctor-roundtable，用于圆桌会诊，只诊断不改写。
- .claude/skills/dialogue-doctor-diagnosis/SKILL.md：dialogue-doctor-diagnosis，用于逐句台词诊断与修改理由。

你的任务：把用户输入从“剧本/大纲”重设计为 Script → Casting → Storyboard 的稳定中间层。不要直接跳到分镜；先产出可供选角、表演、素材生成、分镜共用的创作契约。

输入剧本/大纲：
{{scriptText}}

美术风格：{{artStyle}}
画布上下文：
{{canvasContext}}
{{existingStoryboard}}

请严格输出一个 JSON 对象，且只输出 JSON，不要 markdown，不要解释：
{
  "framework_calibration": {
    "logline": "一句话故事",
    "duration_or_episode_type": "时长/集型判断",
    "platform_bias": "平台倾向",
    "core_emotion": "核心情绪",
    "main_risk": "至少一个真实问题，不捧杀"
  },
  "expanded_script_baseline": {
    "format": "标准影视/小说化/混合",
    "script_text": "补齐后的完整剧本基准；如输入已是完整剧本则做轻量清洁",
    "beat_summary": ["关键节拍1", "关键节拍2", "关键节拍3"]
  },
  "doctor_roundtable_summary": {
    "must_fix": ["结构/人物/节奏必改问题"],
    "keep": ["不要乱动的亮点"],
    "open_questions": ["重要分歧或待确认问题"]
  },
  "dialogue_diagnosis_summary": {
    "voice_print_risks": ["角色语言辨识度风险"],
    "subtext_risks": ["潜台词风险"],
    "rewrite_notes": ["台词层面建议，必须含为什么"]
  },
  "casting_cards": [
    {
      "name": "角色名",
      "dramatic_function": "戏剧功能",
      "age_range": "年龄段",
      "gender_presentation": "性别呈现/不明则待确认",
      "appearance_for_image": "外形、服装、标志物，用于角色图",
      "personality_layers": "表层/深层/阴影层",
      "voice_print": "词汇库、句长、口头禅、禁用词",
      "performance_anchors": "眼神/呼吸/手部/姿态/节奏等演员能执行的表演锚点",
      "casting_notes": "选角气质、表演难点、不可错配点"
    }
  ],
  "scene_cards": [
    {
      "name": "场景名",
      "location": "地点",
      "time_of_day": "时间",
      "mood": "氛围",
      "visual_requirements": "用于场景图与分镜的视觉要求"
    }
  ],
  "prop_cards": [
    {
      "name": "道具名",
      "description": "外观",
      "dramatic_significance": "剧情意义"
    }
  ],
  "storyboard_directives": [
    "后续分镜必须遵守的导演指令；包括情绪锚点、空间轴线、表演重点"
  ]
}

硬约束：
- 必须包含 Casting 角色卡，不允许只写角色名。
- 每个 casting_cards.performance_anchors 必须是演员可执行动作，不要抽象鸡汤。
- 必须保留至少一个 main_risk 或 must_fix，真实反馈，不捧杀。
- 若信息不足，在对应字段写“待用户确认”，不要编。
- 只输出 JSON。`,
  },

  scriptAnalysis: {
    id: 'scriptAnalysis',
    label: '剧本结构化分析',
    template: `你是专业编剧分析师。分析以下剧本的叙事结构：
- 识别幕结构（三幕/五幕）
- 标记关键转折点、高潮、冲突
- 提取主题线和情感弧线
- 标注每段的时间比重
- 列出所有出场角色（姓名、性别、年龄段、与其他角色的关系）
- 列出所有场景（地点、时间、氛围）
- 列出关键道具

剧本：
{{scriptText}}

{{canvasContext}}
{{existingStoryboard}}

输出结构化分析结果。`,
  },

  characterExtraction: {
    id: 'characterExtraction',
    label: '角色提取与丰富',
    template: `你是角色设计专家。基于剧本分析，提取并丰富每个角色的视觉描述。

剧本分析：
{{scriptAnalysis}}

美术风格：{{artStyle}}

为每个角色输出详细的视觉设计 JSON 数组：
\`\`\`json
[
  {
    "name": "角色名",
    "gender": "female/male",
    "age": "年龄描述",
    "appearance": "详细外貌描述（发型、发色、肤色、五官特征）",
    "clothing": "服装描述（款式、颜色、材质、配饰）",
    "expression": "默认表情/气质",
    "body_type": "体型描述",
    "distinctive_features": "标志性特征（疤痕、纹身、特殊配饰等）",
    "image_prompt": "完整的英文人物三视图图片生成 prompt：必须包含 Sony Venice camera, Panavision C-series lenses, 24mm, f/1.4, full-frame, clean shadows, cinematic lighting, anamorphic wide angle, ultra-high detail, 8k, Final Fantasy CG game style, refined CG, Unreal Engine 5 render；构图为纯白背景，上面1/3人物正面脸部超特写且表情自然，下面2/3分三块展示颈部以下到脚部的正/侧/背三视图（不要出现头部），双手自然垂落；同时包含上述所有角色视觉信息，适合 {{artStyle}} 风格"
  }
]
\`\`\`
只输出 JSON，不要其他文字。`,
  },

  sceneExtraction: {
    id: 'sceneExtraction',
    label: '场景提取与丰富',
    template: `你是场景设计专家。基于剧本分析，提取并丰富每个场景的视觉描述。

剧本分析：
{{scriptAnalysis}}

美术风格：{{artStyle}}

为每个场景输出详细的视觉设计 JSON 数组：
\`\`\`json
[
  {
    "name": "场景名",
    "location": "地点类型",
    "time_of_day": "时间",
    "weather": "天气/氛围",
    "architecture": "建筑/环境结构描述",
    "lighting": "光线描述（方向、颜色、强度）",
    "color_palette": "主色调",
    "mood": "情绪/氛围",
    "key_props": "场景中的关键物品",
    "image_prompt": "完整的英文图片生成 prompt，wide establishing shot，适合 {{artStyle}} 风格，16:9 比例"
  }
]
\`\`\`
只输出 JSON，不要其他文字。`,
  },

  propExtraction: {
    id: 'propExtraction',
    label: '道具提取与丰富',
    template: `你是道具设计专家。基于剧本分析，提取关键道具的视觉描述。

剧本分析：
{{scriptAnalysis}}

美术风格：{{artStyle}}

为每个关键道具输出 JSON 数组（只提取剧情中重要的道具，不超过5个）：
\`\`\`json
[
  {
    "name": "道具名",
    "description": "外观描述",
    "material": "材质",
    "significance": "剧情意义",
    "image_prompt": "完整的英文图片生成 prompt，product shot on neutral background，适合 {{artStyle}} 风格"
  }
]
\`\`\`
只输出 JSON，不要其他文字。如果没有关键道具，输出空数组 []。`,
  },

  visualAnchor: {
    id: 'visualAnchor',
    label: '视觉锚定提取',
    template: `基于剧本分析和已有画布元素，提取视觉锚点：
- 每个场景的核心视觉标识（色调、构图母题、标志性道具）
- 角色的视觉一致性锚点（服装颜色、特征配饰、体型比例）
- 跨镜头的视觉连接线索

剧本分析：
{{scriptAnalysis}}

角色设计：
{{characterDesigns}}

场景设计：
{{sceneDesigns}}

画布元素：
{{elementContext}}

输出每个场景/角色的视觉锚点列表。`,
  },

  visualStrategy: {
    id: 'visualStrategy',
    label: '全局视觉策略',
    template: `作为视觉总监，制定全局视觉策略。美术方向：{{artStyle}}

请基于此美术方向制定：
- 整体色彩方案（每幕的色调变化，须符合 {{stylePreset}} 风格）
- 镜头语言风格（手持/稳定/斯坦尼康）
- 光影基调（自然光/人工光/混合）
- 构图规则（三分法/中心/对称）
- 转场策略（硬切/溶解/匹配剪辑）

剧本分析：{{scriptAnalysis}}
视觉锚点：{{visualAnchor}}

输出视觉策略文档。`,
  },

  shotAllocation: {
    id: 'shotAllocation',
    label: '镜头分配计划',
    template: `作为分镜导演，制定镜头分配计划：
- 每个叙事段落分配多少个镜头
- 每个镜头的景别分配（保证景别多样性）
- 节奏控制（快切 vs 长镜头的分布）
- 总时长分配

剧本分析：{{scriptAnalysis}}
视觉策略：{{visualStrategy}}

输出镜头分配表（场景→镜头数→景别→时长）。`,
  },

  shotComposition: {
    id: 'shotComposition',
    label: '镜头构图设计',
    template: `作为构图设计师，为每个镜头设计具体构图：
- 画面主体位置和大小
- 前景/中景/背景层次
- 引导线和视觉重心
- 角色站位和走位
- 光源方向和阴影

镜头分配：{{shotAllocation}}
视觉锚点：{{visualAnchor}}

输出每个镜头的构图设计说明。`,
  },

  storyboardGeneration: {
    id: 'storyboardGeneration',
    label: '生成分镜表 JSON',
    template: `将以上所有分析整合，输出最终的分镜表 JSON 数组。

【小蔡剧本转分镜 Skill 基准】
你不是单纯拆 shot list，而是把剧本先当作分镜前的创作基准：
- 先依据剧本动作建立情绪锚点，再生成每个镜头；禁止为切而切。
- 把抽象心理转成可拍/可演/可听的具象视听语言。
- 每个镜头必须说明情绪与氛围感如何指导后续焦段、光圈、机位、构图、运镜。
- 表格必须补充角色动机、心理状态、表演指导：演员为什么这样演、此刻面对什么处境、内在纠结是什么。
- 角色心理描写要来自剧本上下文，但输出要能指导表演和镜头，不能只写空泛文学句。

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
  "storyboard_prompts": "english keyframe generation prompt (include style: {{artStyle}})",
  "motion_prompts": "english video motion prompt; include camera movement motivated by emotion_atmosphere and character_motivation",
  "character1": { "image": "", "description": "从角色提取结果复制完整描述" },
  "character2": { "image": "", "description": "从角色提取结果复制完整描述" },
  "prop1": { "image": "", "description": "道具描述" },
  "prop2": { "image": "", "description": "" },
  "scene": { "image": "", "description": "从场景提取结果复制完整描述" }
}

字段硬约束：
- emotion_atmosphere 不等于 lighting_atmosphere；前者是情绪/氛围目标，后者是光影实现。
- character_motivation 必须回答“为什么这样表演/行动”。
- character_psychology 必须回答“心理纠结/潜台词/处境压力”。
- performance_guidance 必须是演员能演出来的身体细节，不要写抽象鸡汤。

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

只输出 \`\`\`json ... \`\`\` 代码块，不要其他文字。`,
  },

  // ─── Director Pipeline: 自检阶段 ────────────────────────────────

  timelineCheck: {
    id: 'timelineCheck',
    label: '时间轴与空间逻辑检查',
    template: `你是连续性审查员。检查以下分镜表的时间轴和空间逻辑：
- 时间是否连贯（白天→夜晚是否合理？）
- 空间是否一致（角色不能瞬移）
- 因果关系是否成立
- 道具连续性（前一镜出现的物品后续是否还在）

分镜表：
{{storyboardJson}}

如果发现问题，输出 JSON 数组：[{ "shot": "S3", "issue": "描述", "fix": "建议" }]
如果没有问题，输出：[]`,
  },

  visualBalanceCheck: {
    id: 'visualBalanceCheck',
    label: '视觉平衡扫描',
    template: `你是视觉平衡审查员。扫描分镜表的视觉平衡：
- 景别分布是否合理（不能连续5个特写）
- 色调变化是否有节奏
- 镜头时长是否合理（不能太短<1s或太长>15s连续出现）
- 构图多样性（是否过于单调）
- 角色出镜均衡性

分镜表：
{{storyboardJson}}

如果发现问题，输出 JSON 数组：[{ "shot": "S5", "issue": "描述", "fix": "建议" }]
如果没有问题，输出：[]`,
  },

  // ─── Director Pipeline: 修复阶段 ────────────────────────────────

  applyFixes: {
    id: 'applyFixes',
    label: '执行修复',
    template: `你是分镜修复专家。根据自检发现的问题修复分镜表。

问题列表：
{{issuesList}}

原始分镜表：
{{storyboardJson}}

修复规则：
- 只修改有问题的镜头，不要改动正确的部分
- 保持总时长大致不变
- 确保修复后的景别分布合理
- 保持角色和场景的连续性

输出修复后的完整分镜表 JSON 数组（\`\`\`json ... \`\`\`），不要其他文字。`,
  },

  // ─── Element Generation ─────────────────────────────────────────

  characterImageGen: {
    id: 'characterImageGen',
    label: '角色图片生成 prompt',
    template: `Character identity: {{characterDescription}}. {{artStyle}} style. Sony Venice camera, Panavision C-series lenses, 24mm focal length, f/1.4 aperture, full-frame capture, clean shadows, cinematic lighting, anamorphic lens, wide angle, ultra-high detail, 8k, Final Fantasy CG game style, refined CG, Unreal Engine 5 render. pure white background. Composition requirement: top 1/3 is a front-face extreme close-up with natural expression; lower 2/3 is divided into three blocks showing the character from neck down to feet only, no head visible, three-view full body reference: front view, side view, back view, hands naturally hanging down.`,
  },

  sceneImageGen: {
    id: 'sceneImageGen',
    label: '场景图片生成 prompt',
    template: `Cinematic wide establishing shot: {{sceneDescription}}. {{artStyle}} style. Detailed environment, dramatic lighting, 16:9 aspect ratio`,
  },

  propImageGen: {
    id: 'propImageGen',
    label: '道具图片生成 prompt',
    template: `Product photography, detailed close-up: {{propDescription}}. {{artStyle}} style. Neutral background, studio lighting`,
  },
}

/**
 * Fill a prompt template with variables.
 * Replaces {{key}} with the corresponding value from vars.
 * Missing keys are replaced with empty string.
 */
export function fillPrompt(templateId: string, vars: Record<string, string>): string {
  const tmpl = PROMPTS[templateId]
  if (!tmpl) return `[Unknown prompt: ${templateId}]`
  return tmpl.template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

/**
 * Get a prompt template by id (for inspection/editing).
 */
export function getPrompt(id: string): PromptTemplate | undefined {
  return PROMPTS[id]
}

/**
 * List all prompt template ids.
 */
export function listPromptIds(): string[] {
  return Object.keys(PROMPTS)
}
