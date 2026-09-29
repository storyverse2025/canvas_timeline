# StoryVerse 项目导入（只读）

把 https://storyverse-monorepo-web.vercel.app/admin/projects 背后的线上项目，
一键导入到本地画布 / 分镜表 / 时间轴。

入口：顶栏 **项目库** tab（`src/components/projects/StoryverseProjectsPage.tsx`）。

## 只读保证

服务端只有一个出口：`vite-storyverse-plugin.ts`。它对 Supabase 只发 `GET`
——PostgREST (`/rest/v1/...`) 与 Storage (`/storage/v1/object/...`)，代码里
没有任何 POST / PATCH / PUT / DELETE 上游调用；两个中间件本身也只接受 `GET`
（其它方法返回 405），所以浏览器端即使误发请求也变不成写操作。
`SUPABASE_SERVICE_ROLE_KEY` 只在 Node 侧读取，不会下发到浏览器。

## 端点

| 端点 | 说明 |
| --- | --- |
| `GET /storyverse/projects?limit=&offset=&q=` | 项目列表，按 `updated_at desc`（活跃时间）排序，附带集数 / 分镜 / 镜头 / 素材计数 |
| `GET /storyverse/project?id=<uuid>&localizeVideos=0\|1` | 单个项目的完整 bundle |

计数刻意不用 PostgREST 的内嵌聚合（`episodes(count)` 之类）：在这个库上
四张表一起聚合会直接 `57014 statement timeout`。改成只对当前这一页的项目 id
做四次 id-only 批量读，然后在 Node 里累加。

**坑：Supabase 的 `db-max-rows` 默认 1000，而且是静默截断**——`limit=2000`
只会拿到 1000 行，没有任何报错。所以所有可能超过 1000 行的读取（一页 40 个
项目的计数、10 集项目的分镜）都走 `restGetAll()` 按 offset 翻页。曾经的
`limit=2000` 写法会让翻到后面的项目计数偏小、「导入」按钮被误判成禁用。

## 素材落地

`assets` bucket 是**私有**的，所以图片在服务端用 service-role 下载后写进
`public/uploads/`，文件名是 storage path 的 sha1（`sv-<hash>.<ext>`）——
重复导入同一个项目不会重复下载。这样导入的参考图和生成出来的图走完全同一条
路径：同源、无 CORS 问题、能再次上传给 Seedance / FAL。

视频默认**保留线上签名链接**（签到 2031 年），因为一个项目的镜头视频动辄几百 MB。
列表页的「视频也下载到本地」勾选后才会一并落盘。两种情况下
`vite-asset-proxy-plugin.ts` 的白名单都已包含 `supabase.co`，所以时间轴合成导出
都能读到。

## 字段映射

`src/lib/storyverse-import/mapper.ts` 是纯函数（有单测），负责 bundle → 画布 + 分镜行。

- `assets.category` → canvas item role：`character` / `property`→`prop` /
  `environment`→**`scene-view`**。不能用 `scene`：那个 role 会让
  ImageCanvasNode 走 `PanoramaViewer`（360° 全景），而这些是平面图。
- 角色 / 道具 / 场景槽位来自 frame prompt 顶部的 `[REFERENCES]` 块：

  ```
  [REFERENCES]
  (image1) <char1> @Maya Reyes - East Asian woman, rust-orange dress
  (image2) <scene> @Contemporary luxury private study - walnut study
  ```

  `(imageN)` 对应 `reference_image_urls[N-1]`，`<char1>` / `<scene>` / `<prop1>`
  决定落到哪个槽。没有这个块时退化成「按素材 category 分桶」。

  **坑：参考图经常指向素材的历史版本。** 全库 16759 条引用里有 2229 条（13%）
  的 storage path 不等于该素材当前 `active_version_id` 的 path——分镜是拿当时那一版
  合成的，之后素材又重生成过。只按 active version 建索引会让这些槽位直接空掉
  （最极端的项目 36 条引用全是历史版本，整张表的角色/道具/场景格子都是空的）。
  所以服务端按 `asset_id` 拉**全部** version 建 path→asset 索引，并且把**每一条**
  引用图都落地；mapper 对素材库里已经看不到的那一版，会额外生成一个
  `<素材名> · 旧版` 的画布节点（按 url 去重，一般每个项目 <5 个）。
- `storyboard_frames.prompt` → `storyboard_prompts`，`shots.prompt` → `motion_prompts`，
  `shots.dialogue` → `dialogue`，`shots.video_url` → `beatVideoUrl`，
  `storyboard_frames.image_url` → `keyframeUrl` + `reference_image`。
- 多集项目的镜号带集号前缀（`E1-01`），单集项目就是 `1`、`2`…
- 每集的剧本（`scripts.content`）会落成一个 `role: 'script'` 的文本节点。

## 为什么有些项目导入后没有分镜图 / 没有视频

因为线上就没有。全库 4582 个分镜行里只有 3779 个有 `image_url`，3201 个镜头里
只有 2725 个有 `video_url`——很多项目是直接拿参考图出视频的，从没渲染过分镜图
（例：GBTM EP32 有 13 个分镜行，数据库里只有 1 张分镜图）。这类空缺**不是导入丢了**：
`storyboard_frame_versions` / `shot_versions` 里也查不到任何可用的兜底（实测
`image_url is null` 且存在带图 version 的行数为 0），frame_id 为空或指向已删分镜的
镜头视频同样是 0 条，一个分镜也不会对应多个镜头。

所以列表页的「分镜」「镜头」两列显示的是 `有图数 / 总行数`、`有视频数 / 总行数`，
不足时标黄，确认弹窗也会明说「X 个分镜在线上没有分镜图」。

## 时间轴

导入不直接写 timeline-store：`initStoryboardTimelineLink` 订阅分镜行，
`syncStoryboardToTimeline` 重建场景 / Keyframe / Beat Video 三条轨。
applier 只是额外同步调用一次，让整个导入是原子的，并且先把
`timeline.duration` 归零——否则上一次会话残留的标尺长度会让新导入的内容
挂在一大段空轨里。
