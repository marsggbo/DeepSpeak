# 🎧 DeepSpeak — English Deep Learning App

把真实世界的英语内容，变成可以反复训练的深度学习材料。

> 不是背单词、不是刷课程、不是 AI 陪聊。是 **尚雯婕整段精听法** 的产品化：
> 导入整段真实英语（新闻/采访/播客）→ 通听（从零星单词到全部听清）→ 逐句听写 → 红笔校对 → 跟读模仿 → 背诵脱稿 → 间隔回炉。

**本地优先 · 零 API Key · 数据不出本机 · 装好就能学（内置 3 段材料：餐厅对话 / 看医生 / 慢速新闻稿）**

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
| 内置材料 | 餐厅 / 看医生对话 + 慢速新闻稿（约 2.5 分钟），系统语音离线生成音频（macOS say / Windows SAPI / Linux espeak-ng），整段音频自动拼接 |
| 整段精听 | 通听（可暂停/回退）→ 逐句听写（语音输入可选 + 草稿保存）→ 红笔校对（简单/困难模式，不显示原文）→ 跟读模仿 → 背诵脱稿 → 间隔回炉；4 步可在设置中开启「自由导航」按需跳转 |
| 生词词组 | 校对时自动推荐听错的词（可删可留）+ 自写添加，按词条去重保存；内置 1768 词离线英汉释义（零网络），查不到可手动补释义/笔记；材料页生词本可 🔊 听原句、编辑、删除；逐句强化与复习时同句生词自动展示 |
| 逐句强化 | 盲听 → 听写 → 对照 → 跟读 → 主动回忆（中文意图提示，想不起看原文；可选 LLM 中文回译提示），完成后可「下一句 →」连续训练 |
| 材料归类 | 列表自动分组（全部/未开始/进行中/已掌握）+ 搜索 + 场景/来源/标签筛选；材料可自定义标签 |
| 打卡统计 | 每日打卡（连续天数）；今日明细（听写/开口/复习/精听）、近 7 天柱状图、近 30 天热力图；选一段材料查看历次听写准确率对比曲线 |
| 本地文件导入 | MP3/M4A/WAV/MP4/MOV/MKV + SRT/VTT/TXT，视频自动抽音频 |
| URL 导入 | YouTube 公开字幕、Podcast RSS（选一集下载）、网页文章、音频直链；内置推荐学习源（科学 60 秒系列 / Science Quickly / BBC 6 Minute English / VOA） |
| 本地 ASR | faster-whisper（可选安装），录音自动转写，数据不出本机 |
| 规则引擎 | 无 AI 也能：切句、表达提取、场景分类、难度、学习价值 |
| LLM 增强（可选） | OpenAI / Anthropic / Gemini / Ollama / 任意 OpenAI 兼容端点 |
| API Key 安全 | macOS Keychain / 其他平台 0600 密钥文件，不写数据库；发送前明确询问 + 范围控制 |
| 数据隐私 | 全部 SQLite 本地存储；没有服务器，不收集任何数据 |

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
│   ├── engine-data.js   # 内置材料静态数据（export_builtin.py 生成）
│   ├── recorder.js      # PCM 录音
│   ├── sw.js            # Service Worker（离线缓存）
│   ├── manifest.webmanifest / icons/  # PWA 清单与图标
│   └── assets/audio/    # 内置材料离线音频（45 个 wav）
├── .github/workflows/pages.yml  # GitHub Pages 自动发布
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
2. **Windows**：在 Windows 机器上跑 `packaging\build_win.bat`，然后 `cd electron && set CSC_IDENTITY_AUTO_DISCOVERY=false && npx electron-builder --win`（会下载 NSIS，产物在 `electron\release\`）。

打包版的数据（数据库/导入材料/生词）存放在用户目录：macOS `~/Library/Application Support/DeepSpeak`，Windows `%APPDATA%\DeepSpeak`；首次启动自动从开发目录复制一次历史数据。可用 `DEEPSPEAK_DATA_DIR` 环境变量覆盖。开发模式（`run.sh`）行为不变，仍在项目内 `data/ materials/ models/`。

## 常见问题

**为什么是网页版而不是手机 App？**
这是跑通学习闭环最快的形态：零安装、零 API、跨平台、随时可验证。整套架构（Provider 接口、SQLite schema、状态机、调度器）按移动端可移植设计，下一步可平移到 Flutter（Share Sheet、后台处理等移动能力见 `docs/PRODUCT.md` 的迁移说明）。

**没有网络能用吗？**
能。内置材料 + 全部训练功能离线可用。仅「首次安装 ASR」「导入 YouTube/网页」需要网络。

**我想用更好的 AI 评估？**
设置 → AI Providers 添加任意 OpenAI 兼容端点（Ollama 本地模型也行），发送前 App 会先征求你的同意。

## Roadmap

见 `docs/PRODUCT.md` 第 20 节（MVP 三阶段规划）。
