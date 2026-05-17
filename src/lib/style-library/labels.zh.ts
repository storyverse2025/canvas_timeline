/**
 * Chinese display labels for the storyverse_skills_v2 style presets.
 *
 * Kept separate from `data.ts` so the upstream JSON stays a pristine mirror —
 * the canvas_timeline UI applies these as an override at render time. If a
 * preset is missing here, the UI falls back to the upstream English label.
 *
 * Translation guideline: keep the "X 风" / "X 风格" / "X 灵感" cadence so the
 * grid reads as a coherent menu and not a mix of literal and idiomatic
 * renderings. Director-canon names (诺兰 / 王家卫 / 黑泽明) stay in their
 * Chinese-canonical form.
 */

export const STYLE_LABELS_ZH: Record<string, string> = {
  // 2D — anime / donghua
  anime_psych_thriller_motion_comic: '心理悬疑动漫（死亡笔记 × Re:Zero × 心理测量者）',
  anime_apothecary_refined_comedic: '宫廷雅趣（药师少女的独语 灵感）',
  anime_solo_leveling_dark_power: '黑暗力量幻想（我独自升级 灵感）',
  anime_demon_slayer_painterly_breath: '画意刀剑节奏（鬼灭之刃 灵感）',
  anime_jujutsu_urban_occult: '都市灵异战斗（咒术回战 灵感）',
  anime_chainsaw_raw_chaotic: '粗粝混乱恐怖动作（链锯人 灵感）',
  donghua_mortal_journey_realist_xianxia: '写实仙侠国漫（凡人修仙传 灵感）',
  donghua_renegade_immortal_grim_grand: '冷峻宏大仙侠（仙逆 灵感）',
  anime_ghibli_lyrical_wonder: '吉卜力抒情奇境',
  anime_attack_on_titan_brutal_scale: '残酷尺度史诗（进击的巨人 灵感）',
  anime_akira_cyberpunk_megacity: '新东京赛博朋克（阿基拉 灵感）',
  anime_ghost_in_shell_philosophical_cyber: '哲思赛博黑色（攻壳机动队 灵感）',
  anime_satoshi_kon_psychological_editing: '心理现实切换（今敏 灵感）',
  anime_violet_evergarden_luminous_drama: '细腻光感情感剧（紫罗兰永恒花园 灵感）',
  anime_fate_ufotable_spectral_combat: 'ufotable 灵光战斗（Fate 灵感）',

  // 3D
  '3d_pixar_emotional_realism': '皮克斯情感写实 3D',
  '3d_dreamworks_kinetic_character_comedy': '梦工厂动感角色喜剧 3D',
  '3d_disney_fairytale_musical_scope': '迪士尼童话歌舞史诗 3D',
  '3d_spiderverse_graphic_hybrid': '蜘蛛侠平行宇宙图形混合 3D',
  '3d_arcane_painterly_hybrid': '《奥术》画意混合 3D',
  '3d_weta_performance_capture_epic': '维塔表演捕捉史诗 3D',
  '3d_chinese_mythic_epic': '中式神话史诗 3D（哪吒/封神 风）',
  '3d_illumination_bright_pop': '光照娱乐明亮流行喜剧 3D',

  // Live-action
  liveaction_nolan_filmic: '诺兰式好莱坞胶片巨制',
  liveaction_japanese_film_look: '日式电影胶片质感',
  liveaction_madmax_kinetic_desert: '疯狂麦克斯沙漠动力',
  liveaction_dune_epic_scale: '《沙丘》纪念碑式科幻',
  liveaction_matrix_neo_noir: '《黑客帝国》新黑色动作',
  liveaction_crouching_tiger_poetic_wuxia: '《卧虎藏龙》诗意武侠',
  liveaction_sin_city_high_contrast_noir: '《罪恶之城》图形化黑色',
  liveaction_wong_kar_wai_neon_romance: '王家卫霓虹忧郁',
  liveaction_fincher_precision_noir: '芬奇精密悬疑黑色',
  liveaction_deakins_naturalist_epic: '迪金斯自然主义史诗',
  liveaction_michael_mann_urban_night: '迈克尔·曼都市夜色张力',
  liveaction_kurosawa_weather_drama: '黑泽明天气史诗剧',
  liveaction_park_chan_wook_baroque_tension: '朴赞郁巴洛克张力',
  liveaction_malick_magic_hour_poetry: '马利克黄金时光诗意',
  liveaction_del_toro_gothic_fable: '德尔托罗哥特黑暗寓言',
}
