# 🎧 DeepSpeak — English Deep Learning App

把真实世界的英语内容，变成可以反复训练的深度学习材料。

> 不是背单词、不是刷课程、不是 AI 陪聊。是 **尚雯婕整段精听法** 的产品化：
> 导入整段真实英语（新闻/采访/播客）→ 通听（从零星单词到全部听清）→ 逐句听写 → 红笔校对 → 跟读模仿 → 背诵脱稿 → 间隔回炉。

**本地优先 · 零 API Key · 数据不出本机 · 装好就能学（内置 3 段材料：餐厅对话 / 看医生 / 慢速新闻稿）**

## 下载安装包（开箱即用，识别/语音模型全内置）

不想装 Python 环境？直接下载打包版，双击即用、完全离线（模型已打进包，首次使用不下载任何东西）：

| 平台 | 产物（GitHub Releases） | 说明 |
|---|---|---|
| macOS（Apple 芯片） | `DeepSpeak-0.2.3.dmg` | 双击安装；自用不签名，首次打开右键 → 打开 |
| Windows | `DeepSpeak.Setup.0.2.3.exe`（CI 自动构建） | 安装器，双击安装 |
| Android | `DeepSpeak-0.2.3.apk` | 识别模型（whisper tiny+base）、库与推理内核全部打进包，导入音频转写全程离线 |
| 网页（PWA） | `https://marsggbo.github.io/DeepSpeak` | 浏览器打开 → 「添加到主屏幕」即可当 App 用 |

> 网页版没有内置模型，首次转写需联网下载一次（~40MB，之后浏览器缓存、离线可用）；APK/桌面版完全不需要。

## 快速开始

**macOS / Linux**

```bash
./run.sh
```

**Windows**

```bat
run.bat
```

首次运行会自动：创建虚拟环境 → 安装本地语音识别 faster-whisper（可选）→ 生成内置材料音频 → 打开浏览器 `http://127.0.0.1:8531`。

> 需要 Python 3.10+（Windows 从 python.org 安装时勾选 "Add Python to PATH"）。TTS 跨平台：macOS 用系统 `say`（音质最佳）、Windows 用系统 SAPI 语音、Linux 用 espeak-ng（`apt install espeak-ng`），都没有时前端自动降级浏览器合成——**纯打字学习全程可用，零网络零 API**。

打开后直接点「开始精听」就能开始：三段内置材料已带人工精选表达和离线语音，无需任何网络或 API。

### 不用 Python 也能用（纯前端 PWA）

前端自带 **本地引擎**（`engine.js` + IndexedDB）：把静态目录往任意静态服务器（或 GitHub Pages）一放，App 自动进入离线模式——同样的精听/复习/打卡/统计全部可用，数据存在浏览器本地。

```bash
python3 -m http.server 8531 --directory frontend
# 浏览器打开 http://127.0.0.1:8531
```

## 核心学习闭环（尚雯婕整段精听法）

```
整段通听 → 逐句听写 → 红笔校对 → 跟读模仿 → 背诵脱稿 → 间隔回炉（重听 + 脱稿复述）
```

- **通听**：不看文字，把整段反复听——刚开始只能听出零星单词是正常的，多听几遍直到每个词都清晰；播放器支持暂停/回退 10 秒。
- **逐句听写**：逐句播放、如实写下；听不出的先空着，别卡壳；支持 🎤 语音输入（本地 ASR，可选）与草稿自动保存（中途退出不丢）。
- **红笔校对**：不显示完整原文——听对的词绿色标出，漏写/多写/写错显示为空白（简单模式用方块提示漏了几个词，困难模式只留空白），可展开原文对照；听错的词自动汇总为生词推荐，可勾选保留或自写添加。
- **跟读模仿**：先逐句「听一句 → 模仿一句」，再跟着原声整段同步说。
- **背诵脱稿**：合上文本，按原声的节奏自己念出来。
- **间隔回炉**：完成后 1/2/4/7/14/30 天回炉——重听整段 + 脱稿复述，自评通过推进间隔，2 次通过即「已练透」。
- **全程自评驱动，零 AI 依赖**；录音转写（本地 ASR）与 LLM 讲解均为可选增强、默认关闭。

## 功能

| 能力 | 说明 |
|---|---|
| 内置材料 | 餐厅 / 看医生对话 + 慢速新闻稿（约 2.5 分钟），系统语音离线生成音频（macOS say / Windows SAPI / Linux espeak-ng），整段音频自动拼接；内置材料在桌面/网页/APK 三端一致 |
| 整段精听 | 通听（可暂停/回退 10s）→ 逐句听写（语音输入可选 + 草稿自动保存）→ 红笔校对（不显示原文，听对的绿色 / 漏写错写留白）→ 跟读模仿 → 背诵脱稿 → 间隔回炉（1/2/4/7/14/30 天）；4 步可在设置开启「自由导航」按需跳转 |
| 逐句强化 | 盲听 → 听写 → 对照 → 跟读 → 主动回忆（中文场景提示，想不起来展原文；可选 LLM 中文回译提示），完成后「下一句 →」连续训练；句子边界为跨窗口词级缝合，时间戳按词对齐，不再出现半句/逗号断句 |
| 生词词组 | 每句校对自动推荐听错的词（可删可留）+ 手动添加，按词条去重保存；内置 1768 词离线英汉释义（零网络），查不到可手动补；材料页生词本可听原句、编辑、删除；逐句强化与复习时同句生词自动展示 |
| 处理队列 | 所有导入/转写任务（下载 → 转写 / 重新处理）统一进单线程队列、自动去重；侧栏「任务」页实时显示排队/处理中/失败 + 步骤 + 百分比，角标显示当前任务数；材料列表处理中自动刷新 |
| 材料归类 | 列表分类（全部/未开始/进行中/已掌握）+ 搜索 + 场景/来源/标签 chips 筛选；材料可打标签 |
| 打卡统计 | 每日打卡（连续天数）；今日明细 / 近 7 天柱状图 / 近 30 天热力图 / 听写准确率对比曲线；一键生成学习画像 + 可选 AI 分析 |
| 本地文件导入 | 音频 MP3/M4A/WAV/AAC/OGG/FLAC + 视频 MP4/MOV（自动抽音）+ 字幕 SRT/VTT + 纯文本；网页/APK 端转写直接用内置 Whisper（WASM/WebGPU），全程本地 |
| URL / RSS 导入 | Podcast RSS（选单集转写）、音频直链、YouTube 公开字幕、网页文章；内置推荐源（科学 60 秒系列 / Science Quickly / BBC 6 Minute English / VOA）；APK 原生网络绕 CORS，网页用可配置代理 |
| 语音识别 | 桌面 faster-whisper（base.en，内置模型）；网页/APK transformers.js Whisper（tiny/base.en 两档：APK 模型已打进安装包零下载，网页首次联网缓存几十 MB 后离线可用） |
| 语音合成 | 内置 Kokoro 神经 TTS（28 音色 × en-US/en-GB），桌面/网页/APK 同一音色同一音质，文本课文整段合成 |
| AI 生成材料 | 10 场景 chips + 自定义描述 + 难度/轮数（2-12）/时长（30-300s）滑块随机生成整段对话（逐句配音 + 评分），可选按学习画像定制 |
| 点词释义 | 双击任意单词/句子：离线词典 → 免费在线词典 → 可选 LLM 深度翻译/例句，四级降级零配置 |
| 规则引擎 | 无 AI 也能：切句、表达粘贴提取、场景分类、难度、学习价值 |
| LLM 增强（可选） | OpenAI / DeepSeek / Moonshot / 智谱 / Ollama 平台预设一键填充 base_url，任何 OpenAI 兼容端点 |
| API Key 安全 | macOS Keychain / 其他平台 0600 密钥文件，不落库；API 使用前明确确认 + 范围控制 |
| 数据隐私 | 全部本地存储（SQLite / IndexedDB 双实现）；没有服务器，不收集任何数据 |

## 技术架构

- **后端**：Python 3 标准库（http.server + sqlite3），零硬性第三方依赖
- **前端**：原生 HTML/CSS/JS（无构建步骤），PCM 录音 → 16kHz WAV
- **双引擎**：后端模式（fetch + SQLite）；无后端时自动降级到 `engine.js` 本地引擎（IndexedDB 存储 + 同一套状态机/WER 判定），静态部署零后端也能完整学习
- **PWA**：`manifest.webmanifest` + Service Worker（应用壳预缓存 + 音频渐进缓存），安装到桌面/主屏后完全离线可用；响应式布局（桌面侧边栏 / 手机底部导航）
- **数据库**：SQLite（WAL），17 张表覆盖材料/单元/会话/掌握度/复习历史/生词/听写历史/打卡/AI Provider
- **可选依赖**：faster-whisper（ASR）、youtube-transcript-api（YouTube 字幕）、ffmpeg（视频抽音）

目录结构见 `docs/PRODUCT.md`。

## 在 GitHub Pages 发布（移动端免费托管）

项目已带部署工作流（`.github/workflows/pages.yml`），推送到 GitHub 后自动构建并发布：

1. 初始化仓库并推送：
   ```bash
   git init && git add -A && git commit -m "DeepSpeak"
   gh repo create deepspeak --public --source=. --push   # 或用 GitHub 网页创建后 push
   ```
2. 仓库 Settings → Pages → **Source: GitHub Actions**（工作流会自动构建 `frontend/` 为站点）。
3. 发布地址为 `https://<用户名>.github.io/deepspeak/`，用手机浏览器打开 → 「添加到主屏幕」即可当 App 用（已支持离线）。

> 桌面端分发走 GitHub Releases：打包 `backend/ + frontend/ + run.sh/run.bat`，用户下载后一键运行（Windows 双击 `run.bat`）。

## 项目结构

```
DeepSpeak/
├── run.sh / run.bat    # 一键启动（macOS/Linux / Windows）
├── backend/
│   ├── server.py        # HTTP + REST API
│   ├── db.py            # SQLite schema / 种子数据
│   ├── pipeline.py      # 内容管线（导入→转写→切句→单元）
│   ├── textproc.py      # 归一化 / 切句 / 时间对齐
│   ├── diffing.py       # WER/CER/词对齐/模糊匹配
│   ├── extract.py       # 表达提取 / 场景 / 难度 / 学习价值
│   ├── review.py        # 间隔复习调度 / 掌握度状态机
│   ├── builtin.py       # 内置材料（含人工精选表达）
│   ├── tts.py           # 跨平台离线语音合成（say / SAPI / espeak-ng → wav）
│   ├── asr.py           # faster-whisper 封装（可选）
│   ├── importers.py     # YouTube / RSS / 网页提取
│   ├── ai.py            # AI Provider + Keychain
│   ├── wordbank.py      # 离线英汉释义查询（1768 词）
│   └── data/            # 高频词表 / 表达模式 / 场景关键词 / wordbank.json
├── frontend/            # 单页应用（无构建）
│   ├── index.html       # SPA 入口（manifest / SW 注册）
│   ├── app.js           # 前端逻辑（api() 自动降级本地引擎）
│   ├── engine.js        # 本地引擎（IndexedDB + 状态机 + 判定，纯 JS 零依赖）
│   ├── import-engine.js # 网页/APK 导入引擎（RSS/URL 抓取 + JS Whisper 转写 + 切句）
│   ├── transcribe-worker.js  # 后台转写 worker（transformers.js 同一套模型）
│   ├── tts-engine.js    # 网页 TTS（Kokoro 同款模型）
│   ├── explainer.js     # 点词释义（离线词库 → 在线词典降级）
│   ├── engine-data.js   # 内置材料静态数据（export_builtin.py 生成）
│   ├── recorder.js      # PCM 录音
│   ├── sw.js            # Service Worker（离线缓存）
│   ├── vendor/          # 本地化推理内核（transformers.js + onnxruntime wasm，离线零 CDN）
│   ├── manifest.webmanifest / icons/  # PWA 清单与图标
│   └── assets/audio/    # 内置材料离线音频（45 个 wav）
├── scripts/
│   └── fetch_js_models.py  # 下载网页端 whisper 模型到 models-js/（随 APK/桌面打包分发）
├── android/             # Android APK 壳（Capacitor：WebView 加载 frontend/ + 内置 models/）
├── .github/workflows/pages.yml  # GitHub Pages 自动发布
├── .github/workflows/build-win.yml  # tag v* 时自动构建 Windows exe 并上传 Release
├── docs/PRODUCT.md      # 完整产品与技术设计文档
├── data/                # 运行时：app.db + 密钥文件（自动创建）
├── materials/           # 运行时：导入音频 + TTS 缓存
└── models/              # 运行时：whisper 模型缓存
```

## 打包为桌面应用（Electron + PyInstaller 侧车）

不需要 Python 环境也能用：把后端（whisper ASR + Kokoro TTS + ffmpeg）和前端一起打进一个 App（macOS `.app/.dmg`，Windows `Setup.exe`），双击即用、完全离线。自用不签名（首次打开右键 → 打开）。

```
├── packaging/            # 后端侧车打包（PyInstaller）
│   ├── backend.spec      # onedir；内置 models/、frontend/、backend/data/
│   ├── entry_server.py   # 侧车入口
│   ├── build_mac.sh      # macOS：构建 packaging/dist/deepspeak-server/
│   └── build_win.bat     # Windows：同上（PyInstaller 不能交叉编译，需在 Windows 机器跑）
├── electron/             # 桌面壳
│   ├── main.js           # 选空闲端口 → 拉起侧车 → 等健康 → 开窗口 → 退出杀侧车
│   ├── package.json      # electron + electron-builder
│   └── electron-builder.yml  # 产物 DeepSpeak.app/.dmg（mac）、DeepSpeak Setup.exe（win）
```

构建步骤：

1. **macOS**：`./packaging/build_mac.sh`（建侧车）→ `cd electron && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac`（产物在 `electron/release/`）。
2. **Windows**：在 Windows 机器本地构建，或直接打 tag（`v*`）由 GitHub Actions 自动出 `Setup.exe` 并上传到 Release。

## 打包为 Android APK（Capacitor + WebView）

APK 是 WebView 壳：把 `frontend/` 塞进 App 资源，与桌面/网页同一套前端。识别模型（whisper tiny.en + base.en 量化版）与推理内核（transformers.js + onnxruntime wasm）全部打进安装包——**首次转写零下载，完全离线**。

```bash
python3 scripts/fetch_js_models.py        # 下载模型到 models-js/（一次性，~280MB）
cd android && npx cap sync               # 同步 frontend/ 与 models-js/ → src/main/assets/public/
cd android && ./gradlew assembleDebug    # 产物在 android/app/build/outputs/apk/debug/
```

> `cap sync` 会覆盖 `assets/public/`，因此必须在 gradle 构建**之后**执行模型拷贝（或重新跑一次 `cap sync` 后再手动放模型）；APK 里网络走 Capacitor 原生 Http（天然绕过网页 CORS）。

打包版的数据（数据库/导入材料/生词）存放在用户目录：macOS `~/Library/Application Support/DeepSpeak`，Windows `%APPDATA%\DeepSpeak`；首次启动自动从开发目录复制一次历史数据。可用 `DEEPSPEAK_DATA_DIR` 环境变量覆盖。开发模式（`run.sh`）行为不变，仍在项目内 `data/ materials/ models/`。

## 常见问题

**为什么是网页版而不是手机 App？**
这是跑通学习闭环最快的形态：零安装、零 API、跨平台、随时可验证。现在也有 Android APK（WebView 壳，识别模型内置、离线可用），需要移动端本地文件导入/后台处理时比裸 PWA 更顺手；iOS 暂无安装包，用 PWA「添加到主屏幕」即可。

**没有网络能用吗？**
能。内置材料 + 全部训练功能离线可用；APK/桌面版识别模型已内置，导入音频转写也完全离线。仅「网页版首次下载识别模型」「导入 YouTube/网页文章」需要网络。（APK 完全没有首次下载这一环。）

**我想用更好的 AI 评估？**
设置 → AI Providers 添加任意 OpenAI 兼容端点（Ollama 本地模型也行），发送前 App 会先征求你的同意。

## Roadmap

见 `docs/PRODUCT.md` 第 20 节（MVP 三阶段规划）。
