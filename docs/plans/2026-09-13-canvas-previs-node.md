# 画布「3D 导演台」节点：画布素材 + 视频 prompt → 本地 Claude 调 previs MCP → 低模动画 + session URL

状态：**Phase 0–2 已实施**（Phase 3 内嵌 iframe 节点未做）。实施记录见文末 §8。　涉及仓库：`canvas_timeline`（本仓库）、`/data/repos/storyai-director-studio`

## 1. 目标

在画布上选中若干素材节点（角色 / 场景 / 道具）和一个或多个镜头视频节点，点「生成 3D 预演」：

1. 画布把选中的内容打包成 3D 导演台能吃的 manifest；
2. 服务端起一个**本地 headless Claude Code**，在 director-studio 仓库里调用 `previs` MCP：导入 → 写分镜计划 → 建场 → contact sheet 自检 → 渲染 mp4；
3. 结果回到画布：一个新的视频节点（低模预演 mp4），带一个可在浏览器打开、继续手动编辑的 **session URL**（`http://studio.35.168.148.47.nip.io/?bundle=…`）。

## 2. 已核实的事实（决定了设计）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `studio.35.168.148.47.nip.io` → `127.0.0.1:5173` = **storyai-director-studio** | nginx `sites-enabled/studio-previs` |
| F2 | 旧的 storyai-3d-director-desk（`/director-desk/` → :5199）已**整体下线**：画布工具栏的「3D 导演台」按钮改为打开 `studio.35.168.148.47.nip.io`，vite 的 `/director-desk`、`/apimart` 代理删除，`director-desk.service` 停用，nginx `director.35.168.148.47.nip.io` 站点移除 | `AssetCanvasToolbar.tsx`，`src/lib/previs-export/studio-url.ts` |
| F3 | previs MCP 在本机**默认配置跑不起来**：`.mcp.json` 设 `PREVIS_HEADLESS=0`，机器没有 DISPLAY → 系统 Chrome 起不来 → 退回 Playwright 自带 chromium-1234，未安装 → 失败 | 实测 `previsMcpCall app_status` 报 `Executable doesn't exist …chromium-1234` |
| F4 | `PREVIS_HEADLESS=1` 时正常：系统 Chrome 启动，`previsApi.ready=true`，复用已在跑的 5173 dev server | 实测返回 `ready:true href=http://127.0.0.1:5173/ mode=launch` |
| F5 | **今天不存在「session URL」**。MCP 用 `launchPersistentContext` 独立 profile，且加载的是 `127.0.0.1:5173`；用户浏览器打开的是 `studio.nip.io` —— 不同 profile、不同 origin、不同 IndexedDB。MCP 搭好的场景，用户的浏览器**看不到** | `mcp/previs-mcp/src/browser.ts:66-80`，`config.ts:54` |
| F6 | 场景里模型 / 白模引用是 `asset:<id>`，Blob 存在浏览器 IndexedDB `previs-assets`。裸 `saveScene` JSON 换个浏览器打开会缺模型 | `src/previs-app/assetStore.ts:1-9` |
| F7 | 已有可移植格式：**项目包 `.previs.json`** = 场景 + storyverse 记录（manifest / staging / 锚点）+ 所有 `asset:` Blob 的 base64。`buildProjectBundle` / `applyProjectBundle` 已实现，只挂在 TopBar 的保存/打开上，**没暴露给 previsApi / MCP，也没有 URL 参数入口** | `src/previs-app/io/projectBundle.ts` |
| F8 | `import_project` 只吃 storyverse URL：`runStoryverseImport` 里唯一和 storyverse 绑死的一步是第 288 行 `fetchStoryverseManifest`，之后的参考图入库 / 建项目记录 / 按草稿建场 / 白模都是通用的 | `src/previs-app/storyverse/importStoryverse.ts:284-324` |
| F9 | manifest 的 normalize 很宽松；参考图下载 `fetchStoryverseImageBlob` 在 `storagePath` 为空时退回 `legacyImageUrl`（普通 URL）。所以**画布素材只要给 `legacyImageUrl` 就能走原有入库流程**，refs.ts 零改动 | `storyverse/manifest.ts normalizeAsset`，`storyverse/client.ts:64-68` |
| F10 | `claude` CLI 支持 `-p --output-format stream-json --mcp-config --allowedTools --permission-mode dontAsk --session-id`；`dontAsk` 下没放行的工具直接拒绝而不是卡住等确认 | `claude --help` |
| F11 | `claude-bridge.mjs` 是 hermes/codex 的 LLM 代理，不是 Claude Code，和本需求无关；`canvas-mcp-server.mjs`（WS :3002）目前没在跑，本方案**不依赖它** | `claude-bridge.mjs:6,105`；浏览器 console 的 3002 拒绝连接 |

## 3. 架构

```
画布 (浏览器)                    canvas_timeline vite (Node)                 director-studio
───────────────                  ───────────────────────────                 ─────────────────
选中 素材节点 + 视频节点
  │ 「生成3D预演」
  │ buildPrevisManifest()  ──POST /previs/run──►  1. 复制参考图到
  │  (纯函数, 有单测)                               studio/public/canvas-import/<runId>/
  │                                               2. 写 studio/work/<shortId>/canvas-manifest.json
  │                                               3. spawn claude -p (cwd=studio,
  │                                                  PREVIS_HEADLESS=1, detached)
  │                                                    │  skill canvas2previs
  │                                                    ├─► mcp__previs__import_manifest ─► previsApi.importManifest
  │                                                    ├─► draft_staging / set_staging / build_scene
  │                                                    ├─► contact_sheet 自检
  │                                                    ├─► render_episode {draft} ─► work/<id>/out/episode.mp4
  │                                                    └─► save_project_bundle ─► public/sessions/<id>.previs.json
  │ ◄──GET /previs/status (轮询 claude.jsonl)──     4. 完成后 mp4 复制进 canvas public/uploads/
  ▼
新视频节点 (role beat-video-alternate)
  content = /uploads/previs-<id>.mp4
  description = session URL ──────────────────────────────────►  studio.nip.io/?bundle=/sessions/<id>.previs.json
  连线：各源素材节点、源视频节点 → 新节点                                (applyProjectBundle → 可继续手动编辑)
```

选择「推 manifest」而不是「让 Claude 通过 canvas-mcp 拉画布」：确定性、可单测、不依赖 WS :3002 桥和浏览器页面开着；canvas-mcp 拉取留作后续选项。

选择「生成 manifest 走 previs 的导入/分镜管线」而不是「让 Claude 用 `add_character`/`add_prop` 等原语从零搭」：原语路线丢掉整条 staging 管线（`draft_staging`/`build_scene`/`beat_ranges`/`render_beat`/`write_report`），且 MCP 的默认输出目录按 `getStaging().shortId` 定位，没有项目记录会乱。

## 4. 分阶段实施

### Phase 0 — 让 previs MCP 能在本机无人值守跑（director-studio，半天内）

- canvas_timeline 起 Claude 时用独立的 `--mcp-config`（不改 director-studio 的 `.mcp.json`，那是给人在本地开窗口用的），env：`PREVIS_HEADLESS=1`、`PREVIS_AUTOSTART_DEV=1`、`PREVIS_PROFILE_DIR=<studio>/work/.mcp-profile`。
- 验收：`claude -p --mcp-config <cfg> --allowedTools "mcp__previs" --permission-mode dontAsk "调用 app_status 并原样输出"` 返回 `ready:true`。**这一步同时核实 `--allowedTools mcp__previs` 的通配写法**，写法不对后面全部卡权限。

### Phase 1 — director-studio 补三个能力

1. **`importManifest` 命令 + `import_manifest` MCP 工具**
   - 重构 `runStoryverseImport(store, options)`：`options` 接受 `{ url }` 或 `{ manifest }` 二选一；给了 `manifest` 就跳过第 288 行的 fetch，改成 `normalizeManifest(options.manifest)`，其余步骤原样复用（参考图入库、`createProjectRecord`、`buildProjectScene`、白模）。
   - `contract.ts` 新增 `importManifest: { params: { manifest: unknown, applyToScene?, generateBlockout?, blockoutModel? } }`；handler 与 `importProject` 同构（长任务 + jobId）。
   - MCP 侧 `import_manifest {path}`：从 `work/` 下读 JSON 再透传（避免把几十 KB manifest 塞进工具参数）。
   - 回归测试：用 `__fixtures__` 里一个 storyverse manifest，`{url}` 与 `{manifest}` 两条路径产出的项目记录一致。
2. **`saveProjectBundle` 命令 + `save_project_bundle {dest}` MCP 工具**：包一层现成的 `buildProjectBundle` + `serializeProjectBundle`，落盘到 `public/sessions/<shortId>.previs.json`（MCP 侧写文件，复用 `saveJobFile` 的分块通道，包里有 base64 模型可能几十 MB）。
3. **深链 `?bundle=<same-origin path>`**（`src/main.tsx` 或 TopBar 初始化，约 30 行）：`fetch` → `parseProjectBundle` → 若当前场景非空先 `confirm` → `applyProjectBundle`。只接受同源相对路径（防止任意 URL 注入）。
4. **`canvas2previs` skill**（`.claude/skills/canvas2previs/SKILL.md`，薄封装）：「manifest 在 `work/<id>/canvas-manifest.json`；调 `import_manifest`；然后按 sv2previs 第 2–7 步做（分镜由你写、先看 contact sheet 再渲染）；最后 `save_project_bundle` 并输出一行 JSON `{status, mp4, bundle}`」。引用 sv2previs，不复制它。

### Phase 2 — canvas_timeline 侧

1. **`src/lib/previs-export/build-manifest.ts`（纯函数 + 单测）**：输入 = 选中节点 id、canvas items、nodes、storyboard rows；输出 = StoryverseManifest 形状的 JSON + 需要复制的图片清单。
   - 视频节点 → 通过 `row.beatVideoNodeId` / `keyframeNodeId` 找到分镜行，**分镜行才是信息主源**，裸节点只是兜底：
     - `beats[i].prompt` = 视频 item 的 `prompt` ?? `row.motion_prompts`
     - `beats[i].duration` = `row.duration`；`dialogue` 解析 `row.dialogue`（`Name: line`）
     - `beats[i].imageReferences` = 行的 `characters[]` / `props[]` / `scene` 槽位（`nodeId` → 素材）
     - `beats[i].continuity.environment` = `scene` 槽位素材 id；`storyboardImageUrl` = `row.keyframeUrl`
     - 找不到分镜行（手工拖进来的视频）→ 只用 item.prompt，引用 = 选中的素材节点
   - `assets[]` = 选中的素材节点 ∪ 各行槽位引用到的素材；category：`character`→character、`scene`/`scene-view`→environment、其余→property；`legacyImageUrl` = `/canvas-import/<runId>/<file>`（见下），`storagePath: null`
   - N 个选中视频节点 → N 个 beat，按分镜表顺序。
2. **`vite-previs-plugin.ts`**
   - `POST /previs/run`：校验 manifest → 把参考图从 `public/uploads/` **复制到 director-studio 的 `public/canvas-import/<runId>/`**（两个仓库同盘；这样 5173 里的 Chrome 取图是同源，绕开 CORS、自签证书和 nginx 对服务器自身访问 `/uploads/` 的 403）→ 写 manifest → spawn：
     ```
     claude -p "<canvas2previs 指令 + manifest 路径>" \
       --output-format stream-json --session-id <uuid> \
       --mcp-config <cfg> --strict-mcp-config \
       --allowedTools "mcp__previs" "Read" "Edit(work/**)" "Write(work/**)" \
       --permission-mode dontAsk
     ```
     `cwd=/data/repos/storyai-director-studio`，`detached:true` + `unref()`（vite 重启不杀任务），stdout 写 `work/<id>/claude.jsonl`。
   - **串行**：一台 MCP Chrome 一个场景，已有任务在跑就返回 409 + 正在跑的 runId。
   - `GET /previs/status?runId=`：读 jsonl 尾部 → `{phase, lastToolCall, done, error, mp4, bundle}`；完成时把 `episode.mp4` 复制成 `public/uploads/previs-<runId>.mp4`。
   - `POST /previs/cancel?runId=`：kill 进程组。
3. **UI**
   - 入口：视频节点的 NodeFloatingToolbar / 右键菜单「生成 3D 预演」，同时读取当前多选；可用条件 = 至少 1 个视频节点，且（分镜行槽位 ∪ 选中节点）里至少 1 个角色素材。
   - 点击后立刻在源视频节点右侧放一个**占位视频节点**（`status: generating`，名字「3D预演 · 生成中」），轮询 status 更新进度文案；完成后填 `content`。
   - 结果节点：`kind: 'video'`、`role: 'beat-video-alternate'`（语义就是「挂在主视频旁边供对比的替代版本」，timeline 采用、导出、⭐ 徽章现有代码全部复用）、`prompt` = 源视频 prompt、`description` = session URL；边：各源素材节点 → 新节点，源视频节点 → 新节点。
   - 节点上加「在 3D 导演台打开」按钮 → `window.open(sessionUrl)`。

### Phase 3（可选，前两阶段验证后再做）— 画布内嵌活的 3D 导演台

新增 iframe 节点类型直接嵌 `studio.nip.io/?bundle=…`。这会动 `CanvasItemKind`、`NAMED_*_HANDLES`、节点路由、会话快照、导出，改动面大，所以放在深链被证明可用之后。

## 5. 风险与处理

| 风险 | 处理 |
|---|---|
| 一次完整跑（导入 + 白模 + staging + contact sheet + draft 渲染）要若干分钟到十几分钟 | 占位节点 + 进度轮询；~~默认不开白模~~ → 2026-09-13 改为**默认生成白模布景**（每个 set 实测约 3.5 分钟） |
| 无人值守 Claude 卡在权限上 | `--permission-mode dontAsk` + 明确 allowedTools；Phase 0 先实测 |
| session 深链覆盖查看者本地的当前 3D 项目 | 场景非空时先 confirm；包是按 id 写回，不会删查看者其它项目 |
| `.previs.json` 含 base64 模型可能很大 | 放 `public/sessions/` 静态服务；后续可换成「场景 JSON + 模型文件单独 URL」 |
| MCP Chrome profile 与用户手动开 5173 的窗口抢同一个 dev server | 可以共存（不同 profile）；但同一时刻只允许一个 canvas2previs 任务 |
| 画布素材 role 为 `scene`（360° 全景）| 作为 environment 参考图传入即可；previs 的白模生成本来就吃环境参考图 |

## 6. 验收

1. Phase 0：headless `claude -p` 调通 `app_status`。
2. 单测：`build-manifest` 用 storyverse 导入的真实分镜行（Crawling Back to Betrayal 第 1 行）做 fixture，断言 beat prompt / 时长 / 角色-场景-道具引用 / 图片清单。
3. director-studio 单测：`{url}` 与 `{manifest}` 两条导入路径等价。
4. 端到端（playwright `--no-sandbox`）：在画布导入 Crawling Back to Betrayal → 选 1 个视频节点 → 生成 3D 预演 → 出现可播放的 mp4 节点、边正确 → 打开 session URL，3D 导演台加载出同一场景（对象数 > 0，时间轴时长 ≈ 分镜时长）。

## 7. 需要拍板的点（给了默认值，不拍板就按默认做）

1. **一次选多个视频节点 = 一个多 beat 的连续预演**（默认），还是只支持单个视频节点？
2. **默认要不要渲染 mp4**：默认 `draft` 质量渲染；也可以只建场 + 出 contact sheet（快很多），用户到 3D 导演台里自己录。
3. **白模**：默认关（快）；开了每个场景多 1–2 分钟但环境更像样。
4. Phase 3 内嵌 iframe 节点是否需要，还是「mp4 节点 + 打开链接」就够。

## 8. 实施记录（2026-09-13）

用户按默认值确认（多视频合成一个多 beat 预演 / draft 渲染 / 不开白模 / 暂不做 Phase 3）。

### 落地的代码

director-studio：
- `runStoryverseImport` 接受 `{ manifest }`；新命令 `importManifest`、`saveProjectBundle`；MCP 工具 `import_manifest {path}`、`save_project_bundle {dest}`。
- `?bundle=/sessions/<id>.previs.json` 深链（`src/previs-app/io/bundleDeepLink.ts`，只收同源 `.previs.json`，缓存读完后再加载，场景非空先确认）。
- `.claude/skills/canvas2previs/SKILL.md`（无人值守 + 结果行 `CANVAS2PREVIS_RESULT {...}`）。
- `.gitignore` 加 `public/canvas-import/`、`public/sessions/`。

canvas_timeline：
- `src/lib/previs-export/build-manifest.ts`（纯函数）+ `run.ts`（起任务 / 占位节点 / 轮询 / 刷新后续跑）。
- `vite-previs-plugin.ts`：`POST /previs/run`、`GET /previs/status`、`POST /previs/cancel`。
- 视频节点浮动工具栏「生成 3D 预演」按钮（Box 图标）；结果节点上的进度遮罩、取消、`3D` 打开链接；`CanvasItem.sessionUrl`。

### 实测暴露、已修的 4 个真问题

1. **headed Chrome 起不来**：无 DISPLAY → 必须 `PREVIS_HEADLESS=1`（系统 Chrome headless 自带 SwiftShader WebGL2，够用）。
2. **「视口尚未就绪（没有 WebGL 画布）」不是 WebGL 问题**：`public/xyq/` 没镜像时，`useResolvedAssetUrl` 在 HEAD 探测完成前先把本地 `/xyq/character/pippit-role.glb` 交给 GLTFLoader，Vite 回 index.html → 解析抛错 → 整个 R3F Canvas 卸载、视口控制器注销。改为探测完成前返回 null，`MannequinCharacter` / `MotionPlayer` 拆成「解析 URL 的外壳 + 加载模型的内层」（director-studio `useResolvedAssetUrl.ts`、`MannequinCharacter.tsx`，有回归测试）。
3. **整集渲染「Encoder creation error」**：`pickAvcCodec` 探测不带 `hardwareAcceleration`（总通过），`configure` 却写死 `prefer-hardware`；无 GPU 机器不支持。改为按「先硬件、后 no-preference」探测，并用探测通过的那组配置 configure（`mp4Encoder.ts`，有回归测试）。
4. **contact sheet 300 s 超时、渲染任务被系统杀**：不是代码，是机器内存——旧 cron `monitor_server.sh` 用 lsof 查 nginx 的 3000 端口（ubuntu 用户看不到）误判宕机，每分钟多起一份 `npm run dev`，开机 2 小时堆了 129 份（约 60 GB）。经用户确认已删掉该 cron 行、杀掉副本、重启 systemd `canvas-timeline.service`。内存恢复后 headless：build 1.4 s、3 帧 contact sheet 1.2 s、12 s 草稿整集 125 s，产出 960×540 H.264 mp4。

### 端到端验证

- 画布 UI（playwright）：导入 Crawling Back to Betrayal → 选一个镜头视频节点 → 点「生成 3D 预演」→ 服务端落 manifest（角色按 key、环境按 id、对白 speaker 映射正确、分镜图随行复制）→ headless Claude 调 previs MCP 完成导入 / 分镜 / 建场 / 校验 / 保存项目包。
- session 深链：新浏览器（空 IndexedDB）打开 `http://studio.35.168.148.47.nip.io/?bundle=…`，加载出同一场景（布景图层、Zachary 坐主位、Charlie 走位入场、5 个机位、12 s 时间轴），参数随后从地址栏移除。
- 取消：进程组 SIGTERM（15 s 后 SIGKILL 兜底），Claude / MCP / Chrome 全部退出，状态报「已取消」。
- **完整跑通（任务 3c8c98db）**：画布 UI 触发 → 34 次工具调用、5.3 分钟、$1.75 → contact sheet 自检发现第 1 段自动机位漏拍 Charlie 并换成手摆全景 → `episode.mp4`（960×540、12 s、360 帧）→ 项目包 28 MB。画布结果节点拿到可播放视频（`/uploads/previs-3c8c98db.mp4`）和 `3D` 会话链接，新增 4 条边（源视频 + 3 个素材）。
- Claude 在结果里自报的两点产品注意：手摆机位只在场景 / 项目包里、不在 `staging.json`，重新 build 会丢；不开白模时只有占位地板，坐姿人物像悬空。

### 防复发

- `monitor_server.sh` 重写：systemd `canvas-timeline.service` 活着就什么都不做；只查 :8080；已有 dev server 进程时拒绝再起。
- 预演任务：同时只允许一个；单任务硬上限 45 分钟（`PREVIS_MAX_RUN_MIN` 可调，多集大项目可能需要调高），超时按进程组停掉；任务结束 Chrome / MCP 随之退出。
- 单个任务运行时内存约 1 GB（claude ≈ 0.27 GB + headless Chrome ≈ 0.7 GB）。
- 不会自动清理的是磁盘：每个任务留下 `work/<id>/`、`public/sessions/<id>.previs.json`（约 28 MB）、`public/canvas-import/<id>/`（约 20 MB）。

### 2026-09-13 修订：必须搭 3D 场景 + 下载 .previs.json

用户反馈「视频只有人物动作和镜头，没有构建 3D 场景」，并要求在视频节点上附 `.previs.json` 下载链接。

- **原因**：之前那次运行确实走了 `claude -p` → previs MCP → canvas2previs skill，但 skill 里写死了 `generateBlockout:false`，布景状态是 `none`，场景里只有占位地板。
- **第二个坑**：用户 shell 导出了 `TOKENROUTER_BASE_URL=https://api.tokenrouter.com/v1`，会覆盖 `.env.local`；导演台的 `/api/llm` 代理再拼一次 `/v1`，结果请求 `/v1/v1/chat/completions` 失败，白模的视觉 LLM 步骤根本跑不了。已修 `vite/tokenRouterProxyPlugin.mjs`（`tokenRouterChatUrl`，带测试）和 `api/llm.ts`。
- **直接调用验证**：`generateBlockout {setId:"set1"}`（f5469d6f）用时 209 s，生成 265 个部件（墙、窗、会议桌、椅子排、电视墙……）。
- **canvas2previs skill**：
  - 导入时 `generateBlockout:true`；失败的 set 用 `generate_blockout` 补做一次；
  - 每个 set 看 `list_parts` 和俯视图，再 `set_anchors`，站位要落在白模地面上；
  - contact sheet 要能看到布景；
  - 结果行带 `blockouts`。
- **`.agents/skills/director-3d-asset-generation`**：管的是旧版工作台（`?legacy=1`）Director Agent 的 `generate_site_asset`（APIMart 概念图 → fal.ai 图生 3D GLB）。previsApi / previs MCP 目前没有暴露这条链路；而且该 skill 要求付费生成前先经用户确认，和无人值守运行冲突。previs 这边搭场景用的是 `generate_blockout`。
- **下载**：
  - 状态接口返回 `bundleUrl=/previs/bundle?shortId=<id>`，以 attachment 流式返回 `studio/public/sessions/<id>.previs.json`；
  - 结果节点上多一个绿色「.previs.json」下载链接，在导演台「场景文件 → 从本地加载项目」里打开；
  - 已完成的旧结果在启动时会补上这个链接。
- **时长上限**：单任务上限从 45 分钟调到 60 分钟（白模会增加时长）。

### 2026-09-13 修订二：按 sv2previs skill 对齐

用户提示「看看 sv2previs skill」。对照检查后发现真正的缺口在**分镜解析**，不在画布导出：

- 用导演台自己的 `buildStoryverseManifest`（只读）拉同一个 StoryVerse 项目（Crawling Back to Betrayal，8 beats），结果和画布导出的一样：没有 `[SHOT PLAN]`，`characterPositions` 为空。
- StoryVerse 现在的 prompt 是中文短剧格式的**英文骨架版**：`Reference images: Image1: @X …` / `Character distinction:` / `Shot1: Wide shot; 35-degree side shot; static; …; estimated duration 2.5 seconds.`。
- `detectShotPlanDialect` 对 8 个 beat 全部返回 `none`，草稿就只给每个 beat 一段中景（导入警告「没有解析出分镜段，已用一段中景覆盖」）。b592b106 里 Claude 手摆 5 台机位，就是在补这个缺口。
- **修复**：`src/storyverse/shotPlan.ts` 新增 `normalizeCnScaffold`，把英文骨架词换回中文骨架词，按 `cn` 方言复用 `parseShotPlanCn`；台词说话人去掉 `@`，`No new dialogue` 不再混进动作文本。用该项目真实 prompt 加了回归测试。
- **修复后草稿**：每个 beat 5 段（wide / medium + dolly_in / medium_close / …），真实 StoryVerse manifest 和画布 manifest 结果一致。
- **canvas2previs 对照 sv2previs 的其他规矩**：
  - 规矩 6 report.html 补上了（`write_report`，节点上多「报告」链接，`/previs/report`）；
  - 规矩 9 SendUserFile 用节点上的链接代替；
  - 规矩 5「修库」在无人值守时做不了，改为绕开并写进 notes；
  - 草稿段数和镜头数对不上时，Claude 按 prompt 自己拆段。
