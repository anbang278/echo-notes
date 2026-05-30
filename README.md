# Echo Notes

Echo Notes 是一个 Obsidian 音频转写与知识沉淀插件。它可以识别 Vault 中笔记引用的音频文件，调用配置的转写 Provider 生成 Markdown 转写稿，并在原始音频引用下方插入转写稿链接。

> 注意：MVP 版本会把被转写的音频文件上传到你配置的 SiliconFlow API 地址。请确认音频内容适合发送到外部服务。

## 功能列表

- 在设置页配置 Provider、API Key、Base URL、模型和语言。
- 支持 SiliconFlow `TeleAI/TeleSpeechASR`。
- 支持阿里百炼 `qwen3-asr-flash`。
- 支持选中音频链接后转写。
- 支持扫描当前笔记全部音频链接并逐个转写。
- 支持生成 transcript Markdown 文件。
- 支持将 transcript 链接插入原音频引用下方。
- 支持跳过已存在 transcript，并补充缺失链接。
- 支持监听 Markdown 新增音频链接。
- 支持监听 Vault 新增音频文件。

## 配置 SiliconFlow API Key

1. 打开 Obsidian 设置。
2. 进入 Community plugins 中的 Echo Notes 设置页。
3. 设置：
   - Provider：`SiliconFlow`
   - API Key：你的 SiliconFlow API Key
   - Base URL：`https://api.siliconflow.cn`
   - Model：`TeleAI/TeleSpeechASR`
   - Language：`auto`

## 配置阿里百炼 qwen3-asr-flash

1. 打开 Obsidian 设置。
2. 进入 Echo Notes 设置页。
3. 设置：
   - Provider：`阿里百炼`
   - API Key：你的 DashScope API Key
   - Base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`
   - Model：`qwen3-asr-flash`
   - Language：`auto`

阿里百炼 Provider 使用 OpenAI 兼容模式的 `/chat/completions` 接口，并将本地音频编码为 Data URL 发送。Base64 编码后超过 10MB 的音频会被阻止上传。

## 使用 Transcribe selected audio

在当前 Markdown 笔记中选中一条音频链接：

```markdown
![[Recording 20260531001942.m4a]]
```

执行命令 `Transcribe selected audio`。插件会解析选中的音频、调用 Provider 转写、生成 transcript，并在音频下方插入链接。

## 使用 Transcribe all audio files in current note

在当前笔记中放入一个或多个音频链接：

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

执行命令 `Transcribe all audio files in current note`。插件会扫描当前笔记中的所有支持音频引用并逐个处理。

## 自动化触发

- 自动识别 Markdown 音频链接：开启后，插件监听 Markdown 文件变化，延迟 1000ms 扫描新增音频链接，自动生成 transcript 并补充链接。
- 自动识别新音频文件：开启后，插件监听 Vault 新增音频文件，自动生成 transcript，但不会强行插入来源笔记链接。

## 支持的音频格式

- `mp3`
- `mp4`
- `mpeg`
- `mpga`
- `m4a`
- `wav`
- `webm`

SiliconFlow Provider MVP 上传前会检查文件大小，超过 50MB 会阻止上传并提示：

```text
Audio file exceeds SiliconFlow 50MB limit.
```

阿里百炼 `qwen3-asr-flash` 使用 Base64 Data URL，编码后超过 10MB 会阻止上传。

## 示例

输入：

```markdown
![[Recording 20260531001942.m4a]]
```

输出：

```markdown
![[Recording 20260531001942.m4a]]
[[Recording 20260531001942/Recording 20260531001942.transcript|查看转写稿]]
```

生成文件：

```text
Recording 20260531001942/Recording 20260531001942.transcript.md
```

## 构建

```bash
npm install
npm run build
```

## 在 Obsidian 中测试

1. 建议使用独立测试 Vault，不要直接在主 Vault 中开发测试插件。
2. 将本目录放到测试 Vault 的 `.obsidian/plugins/echo-notes/`。
3. 执行 `npm install` 和 `npm run build`。
4. 在 Obsidian 设置中关闭安全模式或启用 Community plugins。
5. 启用 Echo Notes。
6. 配置 SiliconFlow API Key。
7. 在笔记中插入音频链接并执行命令。

## 当前限制

- 已实现 SiliconFlow 和阿里百炼 Provider；其他 Provider 尚未实现。
- 不支持说话人分离。
- 不支持时间戳切片。
- 不支持大文件自动切片。
- 不支持本地 Whisper。
- 不包含复杂任务队列 UI。
