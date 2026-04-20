import type { CapabilitySpec } from './types'

export const CAPABILITIES: CapabilitySpec[] = [
  // ─── 短片Agent ──────────────────────────────────────────────────────
  {
    id: 'script-rewrite',
    category: 'agent',
    label: '剧本二创',
    description: '基于原始剧本进行风格化改写',
    inputKinds: ['text'],
    outputKind: 'text',
    nodeTypes: ['text'],
    params: [
      { key: 'style', label: '风格', type: 'select', options: [
        { value: 'cinematic', label: '电影感' },
        { value: 'anime', label: '动漫风' },
        { value: 'documentary', label: '纪录片' },
        { value: 'comedy', label: '喜剧' },
        { value: 'horror', label: '恐怖' },
      ]},
    ],
  },
  {
    id: 'script-breakdown',
    category: 'agent',
    label: '剧本拆分',
    description: '将完整剧本拆分为场景、角色、道具等结构化数据',
    inputKinds: ['text'],
    outputKind: 'text',
    nodeTypes: ['text'],
  },
  {
    id: 'element-extraction',
    category: 'agent',
    label: '元素提取',
    description: '从剧本或图片中提取角色、场景、道具、情绪等关键元素',
    inputKinds: ['text', 'image'],
    outputKind: 'text',
    nodeTypes: ['text', 'image'],
  },
  {
    id: 'shot-extraction',
    category: 'agent',
    label: '分镜提取',
    description: '从剧本文本自动生成分镜表（镜头号、景别、描述、时长）',
    inputKinds: ['text'],
    outputKind: 'text',
    nodeTypes: ['text'],
  },
  {
    id: 'consistency-check',
    category: 'agent',
    label: '一致性检查',
    description: '检查多张图片/分镜之间的角色、场景、风格一致性',
    inputKinds: ['image', 'text'],
    outputKind: 'text',
    nodeTypes: ['image', 'text'],
  },
  {
    id: 'storyboard-qc',
    category: 'agent',
    label: '分镜质量检查',
    description: '用 Gemini Vision 自动检查关键帧图片是否符合分镜描述（角色、场景、情绪）',
    inputKinds: ['image', 'text'],
    outputKind: 'text',
    nodeTypes: ['image', 'text'],
  },

  // ─── 图片能力 ──────────────────────────────────────────────────────
  {
    id: 'text-to-image',
    category: 'image',
    label: '文/图生图',
    description: '根据文本描述或参考图生成图片',
    inputKinds: ['text', 'image'],
    outputKind: 'image',
    nodeTypes: ['text', 'image'],
    params: [
      { key: 'aspect', label: '比例', type: 'select', default: '16:9', options: [
        { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
        { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' },
      ]},
      { key: 'enhance_prompt', label: '增强提示词', type: 'select', default: 'false', options: [
        { value: 'false', label: '关' }, { value: 'true', label: '开' },
      ]},
    ],
  },
  {
    id: 'batch-image',
    category: 'image',
    label: '批量生图(x4)',
    description: '一次生成4张图片变体，使用 FLUX 模型',
    inputKinds: ['text', 'image'],
    outputKind: 'image',
    nodeTypes: ['text', 'image'],
    params: [
      { key: 'aspect', label: '比例', type: 'select', default: '16:9', options: [
        { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
        { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' },
      ]},
      { key: 'enhance_prompt', label: '增强提示词', type: 'select', default: 'false', options: [
        { value: 'false', label: '关' }, { value: 'true', label: '开' },
      ]},
    ],
  },
  {
    id: 'smart-edit',
    category: 'image',
    label: '智能修图',
    description: '用自然语言描述修改意图，AI 自动编辑图片',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
  },
  {
    id: 'inpaint',
    category: 'image',
    label: '标记修图',
    description: '在图片上标记区域，AI 按指令填充或修改',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
    params: [
      { key: 'mask_url', label: '遮罩图', type: 'string' },
    ],
  },
  {
    id: 'upscale-image',
    category: 'image',
    label: '高清放大',
    description: '将图片分辨率提升 2-4 倍，保持细节',
    inputKinds: ['image'],
    outputKind: 'image',
    nodeTypes: ['image'],
    params: [
      { key: 'scale', label: '放大倍数', type: 'select', default: '2', options: [
        { value: '2', label: '2x' }, { value: '4', label: '4x' },
      ]},
    ],
  },
  {
    id: 'outpaint',
    category: 'image',
    label: '图片扩图',
    description: '向外扩展图片边界，AI 自动补全',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
    params: [
      { key: 'direction', label: '方向', type: 'select', default: 'all', options: [
        { value: 'all', label: '四周' }, { value: 'left', label: '左' },
        { value: 'right', label: '右' }, { value: 'up', label: '上' }, { value: 'down', label: '下' },
      ]},
    ],
  },
  {
    id: 'crop-image',
    category: 'image',
    label: '图片裁剪',
    description: 'AI 智能裁剪图片到指定比例',
    inputKinds: ['image'],
    outputKind: 'image',
    nodeTypes: ['image'],
    params: [
      { key: 'aspect', label: '目标比例', type: 'select', default: '16:9', options: [
        { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' },
        { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' },
      ]},
    ],
  },
  {
    id: 'shot-association',
    category: 'image',
    label: '分镜联想',
    description: '基于当前分镜图联想生成相关镜头变体',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
  },
  {
    id: 'multi-angle',
    category: 'image',
    label: '分镜多角度',
    description: '基于同一场景生成不同拍摄角度的分镜',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
    params: [
      { key: 'angle', label: '角度', type: 'select', options: [
        { value: 'front', label: '正面' }, { value: 'side', label: '侧面' },
        { value: 'back', label: '背面' }, { value: 'top', label: '俯视' },
        { value: 'low', label: '仰视' }, { value: 'bird', label: '鸟瞰' },
      ]},
    ],
  },
  {
    id: 'angle-adjust',
    category: 'image',
    label: '分镜角度调整',
    description: '微调分镜的拍摄角度和构图',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
    params: [
      { key: 'shot_type', label: '景别', type: 'select', options: [
        { value: 'extreme-close', label: '特写' }, { value: 'close', label: '近景' },
        { value: 'medium', label: '中景' }, { value: 'full', label: '全景' },
        { value: 'wide', label: '远景' }, { value: 'establishing', label: '大远景' },
      ]},
    ],
  },
  {
    id: 'pose-edit',
    category: 'image',
    label: '姿势编辑',
    description: '调整图片中人物的姿势和动作',
    inputKinds: ['image', 'text'],
    outputKind: 'image',
    nodeTypes: ['image'],
  },

  // ─── 视频能力 ──────────────────────────────────────────────────────
  {
    id: 'text-to-video',
    category: 'video',
    label: '文生视频',
    description: '根据文本描述生成视频',
    inputKinds: ['text'],
    outputKind: 'video',
    nodeTypes: ['text', 'image'],
    params: [
      { key: 'duration', label: '时长(秒)', type: 'select', default: '5', options: [
        { value: '5', label: '5s' }, { value: '10', label: '10s' },
      ]},
      { key: 'aspect', label: '比例', type: 'select', default: '16:9', options: [
        { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' },
      ]},
      { key: 'enhance_prompt', label: '增强提示词', type: 'select', default: 'false', options: [
        { value: 'false', label: '关' }, { value: 'true', label: '开' },
      ]},
    ],
  },
  {
    id: 'first-last-frame',
    category: 'video',
    label: '首尾帧生视频',
    description: '提供首帧和尾帧图片，生成过渡视频',
    inputKinds: ['image'],
    outputKind: 'video',
    nodeTypes: ['image'],
    params: [
      { key: 'duration', label: '时长(秒)', type: 'select', default: '5', options: [
        { value: '5', label: '5s' }, { value: '10', label: '10s' },
      ]},
    ],
  },
  {
    id: 'multi-ref-video',
    category: 'video',
    label: '多图参考生视频',
    description: '多张参考图融合生成视频',
    inputKinds: ['image', 'text'],
    outputKind: 'video',
    nodeTypes: ['image'],
    params: [
      { key: 'duration', label: '时长(秒)', type: 'select', default: '5', options: [
        { value: '5', label: '5s' }, { value: '10', label: '10s' },
      ]},
    ],
  },
  {
    id: 'universal-video',
    category: 'video',
    label: '全能参考生视频',
    description: '图片+视频+音频组合生成视频',
    inputKinds: ['image', 'video', 'audio', 'text'],
    outputKind: 'video',
    nodeTypes: ['image'],
    params: [
      { key: 'duration', label: '时长(秒)', type: 'select', default: '5', options: [
        { value: '5', label: '5s' }, { value: '8', label: '8s' }, { value: '10', label: '10s' }, { value: '15', label: '15s' },
      ]},
      { key: 'resolution', label: '分辨率', type: 'select', default: '480p', options: [
        { value: '480p', label: '480p' }, { value: '720p', label: '720p' },
      ]},
      { key: 'aspect', label: '比例', type: 'select', default: '16:9', options: [
        { value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' },
      ]},
    ],
  },
  {
    id: 'upscale-video',
    category: 'video',
    label: '视频超分',
    description: '提升视频分辨率和画质',
    inputKinds: ['video'],
    outputKind: 'video',
    nodeTypes: ['image'],
    params: [
      { key: 'scale', label: '放大倍数', type: 'select', default: '2', options: [
        { value: '2', label: '2x' }, { value: '4', label: '4x' },
      ]},
    ],
  },
  {
    id: 'lip-sync',
    category: 'video',
    label: '多人对口型',
    description: '让视频中的人物口型匹配音频',
    inputKinds: ['video', 'audio'],
    outputKind: 'video',
    nodeTypes: ['image'],
  },
  {
    id: 'motion-imitation',
    category: 'video',
    label: '动作模仿',
    description: '让目标人物模仿参考视频中的动作（需要参考视频 + 目标人物图）',
    inputKinds: ['video', 'image'],
    outputKind: 'video',
    nodeTypes: ['image'],
    params: [
      { key: 'mode', label: '质量模式', type: 'select', default: 'std', options: [
        { value: 'std', label: '标准' }, { value: 'pro', label: '高质量' },
      ]},
    ],
  },
  {
    id: 'video-split',
    category: 'video',
    label: '视频切分',
    description: '按场景或时间切分视频为多个片段',
    inputKinds: ['video'],
    outputKind: 'video',
    nodeTypes: ['image'],
  },
  {
    id: 'video-style-transfer',
    category: 'video',
    label: '视频转绘',
    description: '将视频风格转换为指定艺术风格',
    inputKinds: ['video', 'text'],
    outputKind: 'video',
    nodeTypes: ['image'],
    params: [
      { key: 'style', label: '风格', type: 'select', options: [
        { value: 'anime', label: '动漫' }, { value: 'oil-painting', label: '油画' },
        { value: 'watercolor', label: '水彩' }, { value: 'sketch', label: '素描' },
        { value: 'pixel-art', label: '像素' }, { value: '3d-render', label: '3D渲染' },
      ]},
    ],
  },

  // ─── 音频能力 ──────────────────────────────────────────────────────
  {
    id: 'preset-voice',
    category: 'audio',
    label: '预设音色',
    description: '使用预设音色进行文本转语音',
    inputKinds: ['text'],
    outputKind: 'audio',
    nodeTypes: ['text'],
    params: [
      { key: 'voice_id', label: '音色', type: 'select', options: [
        { value: 'alloy', label: 'Alloy (中性)' },
        { value: 'echo', label: 'Echo (男声)' },
        { value: 'fable', label: 'Fable (叙事)' },
        { value: 'onyx', label: 'Onyx (深沉)' },
        { value: 'nova', label: 'Nova (女声)' },
        { value: 'shimmer', label: 'Shimmer (柔和)' },
      ]},
    ],
  },
  {
    id: 'voice-clone',
    category: 'audio',
    label: '声音定制',
    description: '克隆参考音频的声音特征，合成新语音',
    inputKinds: ['audio', 'text'],
    outputKind: 'audio',
    nodeTypes: ['text'],
  },
  {
    id: 'polyphonic',
    category: 'audio',
    label: '多音字设定',
    description: '标注文本中多音字的正确读音',
    inputKinds: ['text'],
    outputKind: 'text',
    nodeTypes: ['text'],
  },
  {
    id: 'sound-effects',
    category: 'audio',
    label: 'AI 音效',
    description: '根据文本描述生成音效',
    inputKinds: ['text'],
    outputKind: 'audio',
    nodeTypes: ['text'],
    params: [
      { key: 'duration', label: '时长(秒)', type: 'number', default: 5 },
    ],
  },
]

export function getCapability(id: string): CapabilitySpec | undefined {
  return CAPABILITIES.find((c) => c.id === id)
}

export function getCapabilitiesByCategory(category: CapabilitySpec['category']): CapabilitySpec[] {
  return CAPABILITIES.filter((c) => c.category === category)
}

export function getCapabilitiesForNodeType(nodeType: string): CapabilitySpec[] {
  return CAPABILITIES.filter((c) => c.nodeTypes.includes(nodeType as 'image' | 'text'))
}
