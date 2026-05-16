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
  //
  // The legacy `scriptToCastingFlow` prompt is gone — script-agent
  // (src/lib/agents/script-agent) owns the framework → casting → storyboard
  // contract now. director-assistant.ts calls scriptAgent.run() via the agent
  // runtime in place of the old fillPrompt('scriptToCastingFlow', ...) line.

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

  // Element extraction (characterExtraction / sceneExtraction / propExtraction),
  // visual anchor / visual strategy, and visual balance check were all migrated
  // into art-director-agent (src/lib/agents/art-director-agent/prompts/). The
  // agent's verbs replace the legacy fillPrompt() calls in canvas-elements.ts
  // and director-assistant.ts.

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

【总时长硬约束（不可违反）】
- 用户已指定本片总时长为 **{{totalDurationSeconds}} 秒**。
- 所有分镜 row 的 duration 字段之和必须严格等于 {{totalDurationSeconds}} 秒（允许 0.5 秒以内的舍入误差）。
- 在编辑每个 row 的 duration 之前先做整体规划：按节拍权重分配各 row 时长，最后核对总和。
- 不准超时也不准欠时。如果剧本内容塞不下 {{totalDurationSeconds}} 秒，先压缩动作密度或合并 row；如果塞得太满，先扩长情绪 row 或加入情绪缓冲 row。
- 输出最后请在心里复核一遍：Σ duration == {{totalDurationSeconds}}。

【小蔡剧本转分镜 Skill 基准】
你不是单纯拆 shot list，而是把剧本先当作分镜前的创作基准：
- 先依据剧本动作建立情绪锚点，再生成每个镜头；禁止为切而切。
- 把抽象心理转成可拍/可演/可听的具象视听语言。
- 每个镜头必须说明情绪与氛围感如何指导后续焦段、光圈、机位、构图、运镜。
- 表格必须补充角色动机、心理状态、表演指导：演员为什么这样演、此刻面对什么处境、内在纠结是什么。
- 角色心理描写要来自剧本上下文，但输出要能指导表演和镜头，不能只写空泛文学句。

【多格导演分镜图与长视频 row 规则】
- 不要把连续动作机械拆成一堆 2-3 秒碎镜；对同一地点、同一动作链、同一情绪推进的内容，尽量合并为单个 10-15秒 长视频 row。
- 每个 row 的 storyboard_prompts 必须生成一张“多格导演分镜图 / multi-panel director storyboard sheet/grid”，而不是单张电影 still。
- 多格数量必须根据时长和节奏自动决定：短镜头可少格，10-15秒 或动作/情绪信息密集的 row 需要更多格，覆盖完整起承转合。
- 每格必须写清 timing slice、构图、机位/焦段/光圈、运镜、角色调度、视线/轴线、景深、转场，以及这一格新增的视觉信息或情绪信息。
- 允许轻微重复：为了保持连续性，角色姿态、空间方向、道具位置可以轻微重复；不要把这种连续性误判为单调。
- 合并后的 row 必须保持强一致动作情节：动作因果、角色目标、视线方向、空间轴线和情绪递进要连续，不得跳戏。
- 生成 keyframe 时把多格图当作“导演分镜板”；生成视频时要按格子顺序理解为时间推进，不要理解为最终视频的分屏。

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
- 所有 row 的 duration 字段之和必须等于 {{totalDurationSeconds}} 秒（容差 ±0.5s）。这是 hard constraint，违反则整张表作废。
- emotion_atmosphere 不等于 lighting_atmosphere；前者是情绪/氛围目标，后者是光影实现。
- character_motivation 必须回答“为什么这样表演/行动”。
- character_psychology 必须回答“心理纠结/潜台词/处境压力”。
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
- 是否把本该合并多个分镜的连续动作拆得过碎；同一地点/同一动作链/同一情绪推进应倾向合并为 10-15秒 长视频 row。
- 允许轻微重复：连续动作中的姿态、空间方向、道具位置轻微重复不是问题，前提是强一致动作情节、因果与情绪递进成立。

分镜表：
{{storyboardJson}}

如果发现问题，输出 JSON 数组：[{ "shot": "S3", "issue": "描述", "fix": "建议" }]
如果没有问题，输出：[]`,
  },

  // visualBalanceCheck migrated to art-director-agent/prompts/critique-composition.md;
  // director-assistant.runSelfCheck now calls art-director-agent.critiqueComposition.

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
- **总时长锁定为 {{totalDurationSeconds}} 秒**。修复后所有 row 的 duration 字段之和必须等于 {{totalDurationSeconds}} 秒（容差 ±0.5s）。若问题列表中包含总时长偏差项，必须重新分配每行 duration。
- 确保修复后的景别分布合理
- 保持角色和场景的连续性
- 优先把同一地点、同一动作链、同一情绪推进的碎镜合并多个分镜到单个 10-15秒 row，并在 storyboard_prompts 中写成多格导演分镜图。
- 允许轻微重复；不要为了避免重复而破坏强一致动作情节、空间轴线、视线方向和情绪递进。

输出修复后的完整分镜表 JSON 数组（\`\`\`json ... \`\`\`），不要其他文字。`,
  },

  // Element-image generation prompts (characterImageGen / sceneImageGen /
  // propImageGen) moved to art-director-agent/prompts/{character,scene,prop}-image.md.
  // The agent's generateAssetImages verb consumes them.
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
