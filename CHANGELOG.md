# Changelog

DeepSpeak 变更记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.3] - 2026-08-23

### 新增
- **APK 内置识别模型与推理内核（识别全程离线，不再下载）**：whisper tiny.en + base.en 两个量化模型（~280MB）连同 transformers.js 库、onnxruntime 的 WASM 内核一起打进安装包，存于 `/models/` + `/vendor/`，APK 导入音频转写不再联网、不再「下载识别模型卡 25%」（此前模型从 huggingface.co/镜像下载，大陆网络经常长时间卡进度条）；网页版（无内置模型）行为不变，仍自动回退远程下载 + Cache API 缓存。桌面版不受影响（用的是后端 faster-whisper）
- **onnxruntime wasm 路径本地化**：库加载顺序改为 本地 vendor → jsdelivr → unpkg，APK 内连 WASM 内核都自带（此前内核也要从 jsdelivr 拉）
- `scripts/fetch_js_models.py`：一键下载内置模型（`--check` 校验完整性；`--host hf-mirror.com` 走镜像），模型文件不入 git（`models-js/` 已 gitignore）；APK 构建时 `cap sync` 后拷入 assets

### 测试
- `tests/e2e_offline_models.py`：headless 冒烟——本地 `/models/` 可达、真实 pipeline 构建 + 推理成功、**断言全程零外网请求**（huggingface/jsdelivr/unpkg/hf-mirror 全部为零），验证的就是 APK 的离线链路

## [0.2.2] - 2026-08-23

### 新增
- **「任务」页面（#/tasks）**：侧栏新增「任务」导航项（带角标），实时列出正在处理的所有任务（排队中/处理中 + 步骤 + 百分比），点任务卡可直接跳到对应材料；处理进度由队列事件驱动推送（本地引擎），桌面版由材料列表轮询兜底；角标数字 = 当前排队 + 处理中任务数，全部完成后自动消失。长转写（几分钟）不再担心"卡死"——打开任务页就能看到进度
- **长任务轮询上限放宽**：导入弹窗的等待轮询从 300 次×1s 放宽到 7200 次、材料详情页从 240 次×2s 放宽到 3600 次；材料列表页在处理期间每 3s 自动刷新并显示「处理中 x%（步骤）」chip，完成后自动还原——快 7 分钟的转写在界面上不再"无提示"
- **语音识别分句准确化（按标点而非按窗口）**：转写切分从「whisper 30 秒窗口各自切句」改为「跨窗口词级缝合」——窗口边界不再在句子中间硬切；若识别结果不带词级时间戳则回退为跨窗口残余片段合并 + 按词数比例分配时间，两种路径都能保证句子按 `.?!` 断句，不再出现"以逗号结尾的半句"
- **词级时间戳**：识别结果中的每个词都保留起止时间（词在窗口内的相对时间 + 窗口偏移锚定），句子时间 = 首词起 / 末词止，句子内停顿、前导语气词（um/uh/well）会被清洗，句子边界更准

### 测试
- `tests/split_units_check.js`：分句/时间戳逻辑的 Node 沙箱回归（缩写、小数、噪声词、跨窗口合并、无词级时间戳降级路径），27 项断言
- `tests/e2e_tasks_page.py`：headless 冒烟——任务页空态、真实队列任务进任务页、角标增减、完成后页面回空态、材料页显示新导入材料

## [0.2.1] - 2026-08-23

### 修复
- **网页版「无法解码」根因修复 + 友好报错**：抓回来的"音频"经常是代理偷换的错误页/HTML——下载阶段新增音频魔数校验（ID3/MPEG 帧同步/RIFF/ftyp/OggS/fLaC/matroska），内容不是音频的会立即拦下并报「返回内容不是音频（text/html，可能拿到了错误页/被代理替换）」，不再拿错误页去解码导致裸英文 `Unable to decode audio data`；确属解码失败时也改为中文说明（格式不支持/下载不完整/被代理替换）。同时给每个候选源请求加了连接超时（12s）——之前代理挂起/断网会卡几分钟才报错
- **处理队列重构（后台续传的基础设施）**：所有导入/转写任务（下载→转写 / 仅转写 / 重新处理）统一进单线程处理队列，同一材料自动去重（用户连点、恢复触发与手动注册也不叠任务），失败由队列统一置 error
- **转写自动续跑**：锁屏、切后台、闪退导致转写中断时，音频 blob 已留在 IndexedDB——回到前台/重新打开页面自动把未完成材料重新入队续跑（已有音频只重跑转写、模型在浏览器缓存不重复下载），队列去重保证不重复执行
- **转写期间防锁屏冻结**：下载/转写全程请求 Screen Wake Lock（APK / 支持的浏览器），结束后自动释放
- **转写加速：首尾静音裁剪**：识别前先裁掉头尾静音（50ms 窗 RMS 阈值），Whisper 不用在静音帧上浪费推理，平均提速约 10-20%（水分越多的长音频越明显）；时间戳按裁剪偏移回补，句子对齐不受影响

### 新增
- **负向 E2E 回归**：`tests/e2e_bad_audio_error.py` headless 验证「代理返回 HTML」「声明 mp3 实为文本」两类坏内容都走中文友好报错，绝不出现英文 `Unable to decode audio data`

## [0.2.0] - 2026-08-25

### 修复
- **逐句音频三端一致（双引擎契约化）**：导入材料（RSS / 音频文件）的逐句播放此前在 APK / 网页上会"一句播完不收、直接播到下一句"——本地引擎对导入素材始终下发 `kind:"file"`（start/end 被忽略，播放整段）；桌面端一直是 `kind:"range"`。现统一走双端共享契约 `backend/audio_contract.py` ↔ `frontend/audio-contract.js`（`resolve_unit_range`：end 缺失→截到下一句起点，仍没有→按词数 `max(1500, n×420)` 估时长），两端永远算出同一个区间；`tests/audio_contract_check.py` 对 Python 与 Node 两侧跑同一用例矩阵（13 例全绿）作为回归闸门，改一端必须同步另一端
- **切换步骤音频立即停止**：单元强化步骤切换（下一步 / 跳步骤 / 红笔校对）与整段精听阶段推进现在会先停掉正在播放的音频（此前只有切换页面才停）；同一步内的"再听一遍"等操作不受影响
- **网页版导入更可靠 + 可诊断**：抓取 RSS / 音频改为失败回退链——直连（源站开了 CORS / 同源）→ 设置里填的代理 → 内置公共代理（allorigins / corsproxy.io / codetabs），失败原因按每一条路径逐条列出（如"直连 网络/CORS 失败；内置代理 2 HTTP 413"），不再是无从下手的笼统报错；Whisper 识别模型官方源（huggingface.co）下载失败自动切换 hf-mirror.com 镜像。说明：免费公共代理不稳定，跨域素材在网页端是尽力而为；APK（原生请求无 CORS）与桌面版无此限制

### 新增
- **双引擎一致性测试工具**：`tests/audio_contract_check.py`（Python ↔ Node 契约回归）、`tests/e2e_import_audio.py`（headless 浏览器完整跑 RSS 导入→下载→转写→逐句音频断言，转写打桩避免拉模型）

## [Unreleased]

### 新增
- **AI Provider 常见平台一键填充**：设置页新增「常用平台」chips（OpenAI / DeepSeek / OpenRouter / Moonshot Kimi / 智谱 GLM / 通义千问 / Groq / Ollama），点击自动填好类型、Base URL、模型，只需再粘 API Key（网页/APK 与桌面版一致）
- **通俗解释 🤖 按钮**：整段精听红笔校对（展开原文）、逐句强化的对照理解 / 复习对照 / 跟读 / 主动回忆（看原文）旁新增「🤖 通俗解释」，点击即让 LLM 给出中文翻译 + 通俗有趣的讲解 + 同类例句；提示词可在「设置 → AI 解释提示词」自定义（{text} 占位原句，留空用内置模板）
- **学习画像（历史学习记录沉淀 + LLM 定制化）**：
  - 系统自动从历史记录聚合结构化画像：听写/跟读/回忆通过率与词错率、反复听错的弱句（错误类型）、弱场景、生词量、复习与打卡节奏——桌面与本地模式双实现（`GET /api/learner/profile`）
  - 统计页新增「学习画像」卡：画像摘要 + 「🤖 让 AI 分析我的薄弱点」一键诊断（`POST /api/ai/analysis`，中文建议）
  - AI 生成材料页新增「🧠 参考我的学习画像生成」开关：让 AI 围绕你的薄弱句 / 弱场景写对话，把 LLM 用到点子上
- **材料按导入时间排序**：材料列表新增排序下拉（时间新→旧 / 旧→新 / 导入顺序），每张卡片显示「📥 导入时间」（今天 / 昨天 / N 天前 / 月-日）
- **设置页信息架构优化（移动端不挤不乱）**：
  - 冗长解释改为「ⓘ」小问号点击展开（语音识别、WER 阈值、CORS、AI Provider、解释提示词），默认收起，窄屏标签与控件自动换行堆叠
  - CORS 项改为通俗文案：「跨域抓取代理（仅网页版）」+ 一句话说明 + ⓘ 讲清"浏览器跨域限制"与第三方代理的隐私提示；AI Key 存储说明按平台区分（桌面钥匙串 / 网页手机仅本机浏览器）

### 修复
- 网页/APK（本地引擎模式）此前 AI 相关端点全是 stub：现在支持 Provider 的增删改查与连接测试、回忆中文提示、通俗解释、AI 分析（`/api/ai/*`、`/learner/profile` 全部本地实现，配置仍存 IndexedDB、不落任何服务器）
- service worker 缓存版本 `v15 → v16`

### 新增
- **手机端 Whisper 转写加速：多 Worker 并行**（浏览器/APK 内转写 3-4x，文本与单线程完全一致）：
  - 新增 `frontend/transcribe-worker.js`：音频按 30s 窗口 / 20s 步长切块（与 transformers v2 内部 chunked 的 hop = chunk − 2×stride 完全同构），分发给最多 4 个 Worker 并行推理（数量按 `navigator.deviceMemory` 分级防低端机 OOM），合并时按每块左右 5s stride 区间去重（首块左 0、末块右 0），输出与单线程逐句一致（实测 157s 音频归一化文本完全相同）；worker 失败自动回退单线程
  - 设置页（本地模式）新增「推理后端」实时探测：WebGPU（GPU 加速）/ WASM（CPU 单线程）——真机 WebView 若支持 WebGPU 可获数倍以上收益
  - 转写读取设置的兜底值统一为 `tiny.en`（原为 `base.en`，设置未初始化时会落到慢 3 倍的模型）
- **网页 / APK 内置 Kokoro 神经 TTS**（不再"没有内置 TTS"）：无后端的本地引擎模式（GitHub Pages PWA / 手机 APK）现在有和桌面版完全同款的语音合成——同一个 Kokoro v1.0 模型与 28 个音色（af_/am_ 美音、bf_/bm_ 英音，与桌面 `tts_engine_kokoro.py` 音色表一致）——
  - 新增 `frontend/tts-engine.js`（`window.dsTts`）：用 kokoro-js（官方 ONNX 模型的 JS 移植，espeak-ng 音素器 + onnxruntime-web 全部 WASM，不碰 WebGPU、安卓 WebView 可用）按句合成 24kHz 16bit WAV；q8 量化模型 ~114MB 首次使用时从 HF CDN 下载（HTTP 缓存命中后再次加载约 3s），合成结果按 (voice, rate, text) 缓存 IndexedDB（对齐桌面文件缓存语义）；`listVoices` 返回 28 音色
  - `engine.js`：`GET /tts/voices` 返回真实音色列表（设置页 TTS 区块自动启用）；新增 `GET /tts` 与 `ttsSynthesize`（文本单元播放 / 音色试听走本地合成，voice/rate 缺省取设置）；新增 `POST /materials` 文本导入（对齐桌面 `create_from_text`：SRT/VTT 按块取文本、纯文本分句，立即建单元）；文本材料单元音频 `kind:"tts"`（无静态音频，播放时按句合成）
  - `app.js`：导入弹窗「粘贴文本」本地模式可用（不再提示"仅桌面版可用"）；`playUnit` 支持 `kind:"tts"` 单元（合成后播放，首次显示"正在合成语音…"）；设置页音色试听本地合成；语速（词/分钟）沿用桌面默认 175、`speed = clamp(rate/175, 0.5, 2.0)` 与桌面一致
  - 验证：桌面 Chrome 7/7、APK 模拟器 7/7（28 音色 / 文本导入 / 合成 3.5s / 播放 2.1s 进行中）
- **网页 / APK 纯 JS 导入 RSS 与转写音频**（不再"仅桌面版可用"）：无后端的本地引擎模式（GitHub Pages PWA / 手机 APK / 离线）现可直接导入播客 RSS 与音频，全程浏览器内完成——
  - 新增 `frontend/import-engine.js`（`window.dsImport`）：`fetchFeed`/`parseRss`（DOMParser 解析 channel 标题与每集 title/enclosure/itunes:duration/description/pubDate）、`fetchBlob`（带下载进度）、`transcribe`（transformers.js Whisper，WebGPU 优先、自动回退 WASM，模型经浏览器 Cache API 缓存，首次联网下载后离线可用）、`buildUnits`（移植 `textproc.py` 分句：保护 Mr./U.S./小数点，按词数比例分配时间戳，输出 start_ms/end_ms + 场景/难度/学习价值）
  - `engine.js` 重写三处导入端点：`POST /materials/url`（RSS→draft+集数列表 / 音频直链→处理中并后台转写）、`POST /materials/{id}/podcast-episode`（下载→转写→建单元→ready）、并新增本地音频文件导入 `importLocalFile`、材料删除 `DELETE /materials/{id}`、重新处理 `reprocess`；整段音频 blob 存 IndexedDB（`audio_v1_{mid}`），播放用 `URL.createObjectURL`（`loadState` 重建），单元按 start_ms/end_ms 区间定位（与桌面 full.wav 一致）
  - 跨域抓取：**APK 启用 Capacitor 内置 `CapacitorHttp`**（原生请求天然绕过 CORS，全本地零代理）；**网页**在「设置 → CORS 代理」提供可编辑、可清空的代理输入（预填公共代理，附"链接与音频会经过第三方"提示，APK 端忽略此设置）
  - 导入弹窗本地模式改为真实 UI（URL/RSS 输入 + 6 个推荐源 + 本地音频文件上传区），首次转写显示"下载识别模型 …%"进度；设置页新增「语音识别模型」（tiny.en / base.en）与「CORS 代理」两项
- **全平台统一 Logo**：D+S 蓝色标识落地网页/PWA（favicon + 侧栏 `icons/icon-192.png`）、Electron（`icon.icns`/`icon.ico` + BrowserWindow icon）、Android（15 个 `ic_launcher` mipmap + 前景图 + 背景色改深蓝 `#0e1116`）；母版入库 `frontend/icons/logo-master.png`

### 修复
- **APK 导入 RSS 不工作（三个根因，模拟器实测修复）**：
  1. `capHttp()` 取错命名空间：Capacitor 8 把插件挂在 `Capacitor.Plugins.CapacitorHttp`（而非 `Capacitor.CapacitorHttp`），导致 APK 永远走浏览器 fetch、被跨域 CORS 拦截 → 修正后走原生网络（实测 `X-Android-Response-Source: NETWORK 200`）
  2. Android 明文流量被禁：BBC 等播客音频直链是 `http://`，原生请求报 `Cleartext HTTP traffic not permitted` → manifest 加 `android:usesCleartextTraffic="true"`
  3. transformers.js v3.0.2 在安卓 WebView 必崩：`navigator.gpu` 存在但 adapter 获取失败时无干净回退（报 `no available backend found [webgpu]`）→ 改用 `@xenova/transformers@2.17.2`（v2 系列，纯 WASM，WebGPU 仅显式请求；WebView 实测管道创建+推理正常）
- service worker 缓存版本 `v11 → v13`（import-engine.js 变更必须随版本号发布，否则老缓存继续发旧文件）

### 变更
- 本地引擎默认识别模型 `base.en → tiny.en`（APK/WASM 转写更快，设置页可切回）
- **设置导航图标是太阳**（圆 + 8 条放射线的太阳造型）→ 替换为线性「滑杆」设置图标（细线 stroke 风格，与其余 4 个图标统一，选中仍随主题变色）
- **移动端底部导航文字换行**：导航项由「图标+文字横排」改为「图标在上、文字在下」垂直排列，文字 `white-space: nowrap` 保证不换行（窄屏如 320px 也不会折行）
- 移除侧栏底部「本地优先 · 无需 API Key」文案

### 新增
- **LOGO-PROMPT.md v6**：Logo 概念升级为「D = 微张的嘴，S 从嘴里流出并化为声波」（体现 DeepSpeak = 开口说英语），要求画图模型**单图输出 3×3 网格共 9 个候选**（编号 1-9、统一配色），方便对比挑选；附 9 种构图方向（唇线 / 开口圆弧 / 负空间 / 徽章 / 一笔画 / 条纹 / 气泡 / 双色 / 微笑）

### 变更
- service worker 缓存版本 `v10 → v13`（两轮前端发布并预缓存 `import-engine.js`，发布新版本需递增）

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
