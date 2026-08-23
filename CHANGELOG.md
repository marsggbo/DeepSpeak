# Changelog

DeepSpeak 变更记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **AI 生成材料**：材料页「✨ AI 生成」→ 专属页面（`#/generate`），勾选场景或自定义描述，调整难度/轮数/时长，或勾选「🎲 随机生成」一键生成当天学习内容。流程：LLM 生成对话（需在设置配置 AI Provider）→ 本机 Kokoro 按角色音色逐句合成 → 自动建训练单元与整段音频，生成过程实时显示进度（`POST /api/materials/generate` + 后台线程 + 占位材料 error 兜底）
- **白天/黑夜主题**：侧栏底部一键切换（☀️/🌙），CSS 变量全量浅色主题，localStorage 记忆 + 首帧防闪烁；`data-theme` 属性控制
- **上一句左箭头**：逐句强化页左右对称悬浮大箭头（◀ 回到上一句 / ➤ 跳过该句进入下一句），hover 提示
- 逐句强化：页面右侧新增**大右箭头**，随时跳转下一句（鼠标悬停提示「跳过该句进入下一句」）
- 每句完成时弹出 **Bingo!** 庆祝反馈（逐句强化完成页 / 复习完成页）
- 听写检查支持**原文纠错**：ASR 转录可能有误，在「对照理解 / 复习对照」面板点击「✏️ 原文有误？纠正」即可修改句子文本并保存，后续听写判定与复习对照均以新文本为准（`PUT /api/units/:id` 新增 `text` 字段）
- 退出学习确认弹窗新增**「今后不再提醒」**选项（写入 `settings.exit_confirm`，勾选后切出学习自动保存进度，不再打扰）

### 修复
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
