# Changelog

DeepSpeak 变更记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **网页 / APK 纯 JS 导入 RSS 与转写音频**（不再"仅桌面版可用"）：无后端的本地引擎模式（GitHub Pages PWA / 手机 APK / 离线）现可直接导入播客 RSS 与音频，全程浏览器内完成——
  - 新增 `frontend/import-engine.js`（`window.dsImport`）：`fetchFeed`/`parseRss`（DOMParser 解析 channel 标题与每集 title/enclosure/itunes:duration/description/pubDate）、`fetchBlob`（带下载进度）、`transcribe`（transformers.js Whisper，WebGPU 优先、自动回退 WASM，模型经浏览器 Cache API 缓存，首次联网下载后离线可用）、`buildUnits`（移植 `textproc.py` 分句：保护 Mr./U.S./小数点，按词数比例分配时间戳，输出 start_ms/end_ms + 场景/难度/学习价值）
  - `engine.js` 重写三处导入端点：`POST /materials/url`（RSS→draft+集数列表 / 音频直链→处理中并后台转写）、`POST /materials/{id}/podcast-episode`（下载→转写→建单元→ready）、并新增本地音频文件导入 `importLocalFile`、材料删除 `DELETE /materials/{id}`、重新处理 `reprocess`；整段音频 blob 存 IndexedDB（`audio_v1_{mid}`），播放用 `URL.createObjectURL`（`loadState` 重建），单元按 start_ms/end_ms 区间定位（与桌面 full.wav 一致）
  - 跨域抓取：**APK 启用 Capacitor 内置 `CapacitorHttp`**（原生请求天然绕过 CORS，全本地零代理）；**网页**在「设置 → CORS 代理」提供可编辑、可清空的代理输入（预填公共代理，附"链接与音频会经过第三方"提示，APK 端忽略此设置）
  - 导入弹窗本地模式改为真实 UI（URL/RSS 输入 + 6 个推荐源 + 本地音频文件上传区），首次转写显示"下载识别模型 …%"进度；设置页新增「语音识别模型」（tiny.en / base.en）与「CORS 代理」两项
- **全平台统一 Logo**：D+S 蓝色标识落地网页/PWA（favicon + 侧栏 `icons/icon-192.png`）、Electron（`icon.icns`/`icon.ico` + BrowserWindow icon）、Android（15 个 `ic_launcher` mipmap + 前景图 + 背景色改深蓝 `#0e1116`）；母版入库 `frontend/icons/logo-master.png`

### 修复
- ~~导入弹窗在网页 / APK 显示「仅桌面版可用」~~：已被上方"纯 JS 导入"取代——网页与 APK 现可真正导入 RSS/音频；本地引擎的错误信息同步友好化
- **设置导航图标是太阳**（圆 + 8 条放射线的太阳造型）→ 替换为线性「滑杆」设置图标（细线 stroke 风格，与其余 4 个图标统一，选中仍随主题变色）
- **移动端底部导航文字换行**：导航项由「图标+文字横排」改为「图标在上、文字在下」垂直排列，文字 `white-space: nowrap` 保证不换行（窄屏如 320px 也不会折行）
- 移除侧栏底部「本地优先 · 无需 API Key」文案

### 新增
- **LOGO-PROMPT.md v6**：Logo 概念升级为「D = 微张的嘴，S 从嘴里流出并化为声波」（体现 DeepSpeak = 开口说英语），要求画图模型**单图输出 3×3 网格共 9 个候选**（编号 1-9、统一配色），方便对比挑选；附 9 种构图方向（唇线 / 开口圆弧 / 负空间 / 徽章 / 一笔画 / 条纹 / 气泡 / 双色 / 微笑）

### 变更
- service worker 缓存版本 `v10 → v12`（本轮前端发布并预缓存 `import-engine.js`，发布新版本需递增）

### 新增
- **AI 生成材料**：材料页「✨ AI 生成」→ 专属页面（`#/generate`），勾选场景或自定义描述，调整难度/轮数/时长，或勾选「🎲 随机生成」一键生成当天学习内容。流程：LLM 生成对话（需在设置配置 AI Provider）→ 本机 Kokoro 按角色音色逐句合成 → 自动建训练单元与整段音频，生成过程实时显示进度（`POST /api/materials/generate` + 后台线程 + 占位材料 error 兜底）
- **白天/黑夜主题**：侧栏底部一键切换（☀️/🌙），CSS 变量全量浅色主题，localStorage 记忆 + 首帧防闪烁；`data-theme` 属性控制
- **上一句左箭头**：逐句强化页左右对称悬浮大箭头（◀ 回到上一句 / ➤ 跳过该句进入下一句），hover 提示
- 逐句强化：页面右侧新增**大右箭头**，随时跳转下一句（鼠标悬停提示「跳过该句进入下一句」）
- 每句完成时弹出 **Bingo!** 庆祝反馈（逐句强化完成页 / 复习完成页）
- 听写检查支持**原文纠错**：ASR 转录可能有误，在「对照理解 / 复习对照」面板点击「✏️ 原文有误？纠正」即可修改句子文本并保存，后续听写判定与复习对照均以新文本为准（`PUT /api/units/:id` 新增 `text` 字段）
- 退出学习确认弹窗新增**「今后不再提醒」**选项（写入 `settings.exit_confirm`，勾选后切出学习自动保存进度，不再打扰）

### 修复
- **逐句强化按钮逻辑（桌面实测反馈）**：
  - 听写通过后按钮一直是 disabled（文字变了但点不了）→ 用户只能点"听不出"跳步。修复：通过后恢复可点、移除"听不出"按钮、文案改为明确的「进入对照理解 →」
  - 跟读/主动回忆提交通过后，绿色提交按钮变"继续 →/完成 →"但功能仍是提交（误点=重复提交无反应）。修复：通过后禁用并显示「✅ 已通过」，前进统一用结果区的明确按钮
  - 主动回忆不再出现两个"完成"（绿色残留 + 蓝色主按钮）
- **整段精听一直转圈（根因）**：`material_full_audio_ready` 检查 `full.wav`，而合成产物是 `full_{音色}_{语速}.wav`（换音色功能引入的路径指纹）——路径不一致导致 audio_ready 永远 False，前端反复触发合成并显示"正在生成整段音频"。修复：ready 判断与产物路径保持一致
- **整段音频合成静默失败**：focus.py 合成循环无异常捕获，单句 TTS 失败会导致后台线程静默死亡、进度卡死。修复：逐句 try/catch + traceback 输出 + 材料置 error
- **词典增强**：wordbank 未命中时自动查询免费在线词典（dictionaryapi.dev，免 key、离线自动跳过），返回音标/词性/英文释义/例句，桌面与 PWA 双端一致
- **APK / Capacitor 环境页面全部打不开（根因）**：Capacitor 本地服务器对未知路径返回 **200 + index.html**（SPA fallback），而 `api()` 只在 `404 + 非 JSON` 时才降级本地引擎，200+HTML 被当作成功响应返回 `null`，导致各处 `cannot read properties of null (reading 'settings')` 等报错。修复：**任何非 JSON 响应都降级本地引擎**（覆盖 GitHub Pages 404、Capacitor 200+HTML、离线三种形态），APK 模拟环境全页面实测通过

### 新增
- **高价值表达收藏**：对照理解面板的每个表达卡片新增「⭐ 收藏到生词本」，一键存入该材料的生词本，之后可在材料页生词面板回顾
- **精听 · 整段背诵对照**：背诵脱稿步骤新增可选区块——不看文字整段背诵，录音自动转写或直接打字，提交后显示整段准确率与逐词 diff（绿=对/红=漏/黄=多背），并记录到精听统计（`POST /api/materials/:id/focus/recite`）
- **按钮去重**：删除逐句强化页头部「上一句/下一句」链接（与两侧悬浮大箭头重复）；步骤导航只保留「← 上一步」回退（前进由各面板主按钮承担，此前「下一步 →」与「听清了/明白了/提交」等主按钮重复）；「跳过，完成本句」仅保留在主动回忆步骤
- **句子切换按钮**：按用户反馈移除两侧悬浮大箭头（视觉干扰），上一句/下一句改回页面**右上角**按钮（「← 上一句」「下一句 →」）
- **体积分析**：DMG 大头为模型（277MB：whisper base.en 141MB + kokoro 142MB）+ 运行时（onnxruntime 75MB / PyAV 43MB / ffmpeg 47MB）。PyAV 是 faster-whisper 解码音频的硬依赖不可移除；可行优化为 whisper base.en → tiny.en（省约 100MB，转写精度略降），待用户拍板
- **句子切换链接从未显示**（根因）：`viewUnit` 读取 `mat.units`，但接口返回结构为 `mat.material.units`，导致相邻句（上一句/下一句）恒为空——逐句强化页头部的切换链接与本次新增的大右箭头均受影响，已修复
- **浏览器/开发缓存**：静态资源响应加 `Cache-Control: no-cache`（HTML/JS/CSS/JSON）；service worker 缓存升级 `deepspeak-v2 → v3`（发布新版本需递增）
- 退出学习弹窗逻辑：仅在**中间步骤（句子未完成）**切出时提醒；句子已完成（完成页）切出不再弹窗
- 旧版 `confirm()` 弹窗无法携带选项，已改为应用内自定义弹窗（桌面端一致）

### 变更
- 分句逻辑按句号/问号/感叹号切分（whisper ASR 片段先按标点拆分，时间按词数比例分配）
- 逐句强化 range 播放：进度条以句首为 0 基准，只显示本句时长；播放到句尾自动截断
- 材料处理新增实时进度显示（下载/转写/构建/合成各阶段百分比，导入弹窗、材料详情、整段精听页三处）

## [0.1.0] - 2026-08-23

### 新增
- DeepSpeak v0.1.0 首发：全离线 ASR（faster-whisper）+ TTS（Kokoro）本地服务
- 材料导入：YouTube 链接 / 音频视频文件 / 字幕（srt/vtt）/ 纯文本
- 逐句强化五步法：盲听 → 听写 → 对照理解 → 跟读 → 主动回忆
- 整段精听（尚雯婕法）：通听 → 逐句听写 → 红笔校对 → 模仿 → 脱稿复述，间隔复习
- 点词释义（双击查词 / 句子翻译）、生词本、SRS 间隔复习、薄弱场景统计
- 桌面壳（Electron + PyInstaller 侧车，macOS dmg）、Android 壳（Capacitor APK）、PWA
- 设置页署名：由 marsggbo 独立开发制作

### 修复
- 录音「缺少音频数据」：Promise 未 await 导致 base64 未生成
- 音色设置不生效：设置未写入缓存 key，切换音色后缓存自动失效重建
- 内置材料音频全部改用 Kokoro 引擎重新生成

### 已知问题
- Windows exe 由 GitHub Actions 构建（mac 无法交叉编译 PyInstaller）
- 内置材料音频为 Kokoro 生成，个别句首/句尾可能有轻微截断
