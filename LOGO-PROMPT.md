# DeepSpeak Logo 生成 Prompt

> 用法：把「核心 Prompt」直接粘贴到 Midjourney / DALL-E / 即梦 / Flux 等图像生成工具，
> 不满意可在「可调参数」里微调后重新生成。

## 一、品牌调性（先想清楚再生成）

- **名字**：DeepSpeak = Deep（深度学习 / 深海意象）+ Speak（开口说英语）
- **产品**：AI 英语深度学习工具，核心学习法是「整段精听」——听写 → 红笔校对 → 跟读 → 脱稿复述
- **气质**：专注、沉静、有深度的学习伙伴；全离线、本地优先、可信赖
- **主色**：深海蓝（#0e1116 背景下的 #6c8cff 主色）+ 珊瑚橙（#ffb454 点缀，象征开口发声的活力）

## 二、核心 Prompt（首选，推荐先试这个）

```
App logo, flat vector style, a rounded speech bubble that forms the shape of
an open book viewed from above, with a sound wave (voice waveform) flowing
through the center of the bubble, deep ocean blue gradient background
(#0e1116 to #1a2029), bright blue (#6c8cff) speech bubble with glowing
coral-orange (#ffb454) waveform accent, minimal geometric design, subtle
depth shadow, centered composition, clean edges, no text, no letters,
suitable for app icon at 512x512, professional, modern, calm and focused mood
```

要点：**对话气泡 × 打开的书 × 声波** 三个意象合一，没有文字（图标级）。

## 三、备选方向（换一种风格试）

**B 方案 · 耳机海洋**
```
Minimalist app icon, headphones formed like a deep sea wave, ocean blue
gradient (#0e1116 → #6c8cff), waveform line inside the headband, flat design,
negative space, no text, 512x512 app icon, calm and modern
```

**C 方案 · 字母标（D 与声波）**
```
App logo, capital letter D integrated with a sound waveform, the vertical
stroke of D becomes a rising waveform, deep blue gradient background,
bright accent line (#6c8cff and #ffb454), flat minimal vector, no other text,
512x512 icon, professional tech education style
```

## 四、可调参数

| 参数 | 建议值 | 说明 |
|---|---|---|
| 风格 | flat vector / minimal / geometric | 不要拟真 3D，扁平图标最耐看 |
| 配色 | 深蓝底 + #6c8cff 蓝 + #ffb454 橙点缀 | 和软件界面一致（暗色主题） |
| 文字 | 无 | 图标内不放字，软件名放图标下方 |
| 比例 | 1:1，512×512 | 应用图标标准 |
| 情绪 | calm, focused, depth | 对应"深度学习"的沉静感 |

## 五、生成后处理

1. 若气泡/书本形态不够明显，把对应关键词提前（如 `open book speech bubble` 放最前面）
2. 生成满意后让工具放大到 1024×1024，再裁出 512×512
3. 替换位置：`frontend/index.html` 的 favicon（当前是 🎧 emoji）、`frontend/icons/`、Electron 打包图标、Capacitor 的 `android/android/app/src/main/res/mipmap-*`

## 六、Prompt 设计思路（为什么这样写）

- **意象三层**：气泡=开口说（Speak）、翻开的书=深度学习（Deep）、声波=语音与听力训练（精听法核心）
- **深海蓝**：呼应 "Deep"，也是软件现有暗色主题的底色，logo 与界面天然统一
- **珊瑚橙点缀**：与主蓝互补，表示"开口发声"的活力，同时是界面里「主动回忆/重点」的强调色
- **无文字**：现代应用图标趋势，避免在小尺寸下糊成一团
