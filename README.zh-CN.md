<p align="right">
  <a href="./README.md">English</a> | 简体中文
</p>

# Echo Notes

Echo Notes 是一个 Obsidian 音频转写与知识沉淀插件。它可以把 Vault 中笔记引用的音频文件转成可阅读、可搜索、可链接的 Markdown 转写稿。

典型流程很简单：在 Markdown 笔记中插入或链接音频文件，执行转写命令，Echo Notes 会生成转写稿文件，并把转写稿链接插入回原始笔记。

> 隐私提醒：Echo Notes 会把所选音频上传到你配置的转写服务商。请不要转写不适合发送给外部服务的音频。

## 功能

- 在 Obsidian 设置页配置转写服务商、API Key、Base URL、模型和语言。
- 转写当前笔记中选中的音频链接。
- 扫描并转写当前笔记中的全部支持音频链接。
- 生成带 source metadata 的 Markdown 转写稿。
- 在原始音频引用下方插入转写稿链接。
- 跳过已存在的转写稿，并补充缺失链接。
- 使用独立 AI 分析模型，将转写稿生成工作纪要、学习纪要或产品需求挖掘纪要。
- 生成独立分析文档，并在转写稿中补充分析链接。
- AI 纪要分析会根据录音链接上下三行的识别关键字自动选择分析方案，未命中时使用默认方案。
- 支持配置分析方案名称、识别关键字、系统提示词和自定义提示词。
- 可选：自动识别新增 Markdown 音频链接。
- 可选：自动识别新创建的音频文件。

## 服务商

已实现的服务商：

- 硅基流动（SiliconFlow）：默认模型 `TeleAI/TeleSpeechASR`
- 阿里百炼（Alibaba Bailian）：默认模型 `qwen3-asr-flash`
- OpenAI（OpenAI）：使用 OpenAI-compatible 音频转写接口
- Groq（Groq）：使用 OpenAI-compatible 音频转写接口
- Ollama、Ollama Open WebUI、Google Gemini、OpenRouter、LM Studio、302.AI、Anthropic、Mistral AI、Together AI、Fireworks AI、Perplexity AI、DeepSeek、xAI、Novita AI、DeepInfra、SambaNova、Cerebras、Z.AI：按 OpenAI-compatible 音频转写接口预设
- 自定义兼容接口（Custom OpenAI-compatible）：用于自定义 `/audio/transcriptions` 端点

服务商的默认 Base URL 和模型都可以在设置页修改。

AI 纪要分析使用独立配置，默认是 DeepSeek `deepseek-chat`，调用 OpenAI-compatible `/chat/completions` 接口。

## 网络与数据使用

Echo Notes 只在触发转写或 AI 纪要分析时发起网络请求。

- 硅基流动默认地址：`https://api.siliconflow.cn`
- 阿里百炼默认地址：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- OpenAI 默认地址：`https://api.openai.com/v1`
- Groq 默认地址：`https://api.groq.com/openai/v1`
- AI 分析默认地址：`https://api.deepseek.com/v1`
- 自定义兼容接口：由用户自行配置

转写会把所选音频上传到你配置的转写服务商。AI 纪要分析会把转写稿文本上传到你配置的分析服务商。转写 API Key 和分析 API Key 都使用 Obsidian `SecretStorage` 独立保存。转写稿和分析文档会写入你的 Obsidian Vault。

## 支持的音频格式

- `mp3`
- `mp4`
- `mpeg`
- `mpga`
- `m4a`
- `wav`
- `webm`

服务商限制：

- 硅基流动：超过 50 MB 的文件会在上传前被阻止。
- 阿里百炼 `qwen3-asr-flash`：本地音频会编码为 Base64 Data URL，编码后超过 10 MB 会被阻止。
- OpenAI-compatible 服务商：超过 25 MB 的文件会在上传前被阻止。

## 配置服务商

1. 打开 Obsidian 设置。
2. 打开 Echo Notes 设置页。
3. 选择服务商。
4. 确认或修改 Base URL 与 Model。
5. 输入该服务商的 API Key。
6. Language 可以保持 `auto`，也可以填写服务商支持的语言代码。
7. 在“文案语言”中选择中文或英文，控制回写链接和生成文稿中的固定文案。

推荐默认值：

| 服务商 | Base URL | Model |
| --- | --- | --- |
| 硅基流动（SiliconFlow） | `https://api.siliconflow.cn` | `TeleAI/TeleSpeechASR` |
| 阿里百炼（Alibaba Bailian） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` |
| OpenAI（OpenAI） | `https://api.openai.com/v1` | `whisper-1` |
| Groq（Groq） | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` |
| 自定义兼容接口（Custom OpenAI-compatible） | 你的接口地址 | `whisper-1` |

## 配置 AI 纪要分析

1. 在 Echo Notes 设置页打开“启用 AI 纪要分析”。
2. 分析 Provider 默认使用 `DeepSeek`。
3. 分析 Base URL 默认是 `https://api.deepseek.com/v1`。
4. 分析模型默认是 `deepseek-chat`。
5. 输入独立的分析 API Key。
6. 设置默认分析方案。录音链接上下三行未命中关键字时，会使用该方案。
7. 在“分析方案”中编辑、启用、禁用、恢复或新增方案。

内置模板：

- 工作纪要：摘要、关键结论、行动项、风险/阻塞、待确认问题。
- 学习纪要：核心概念、知识要点、案例/例子、易混淆点、复习清单。
- 产品需求挖掘纪要：用户/场景、痛点、需求机会、功能建议、优先级、验收标准、开放问题。

自定义方案支持名称、识别关键字、系统提示词、自定义提示词和启用开关。已启用方案会参与录音链接上下三行的关键字匹配；禁用方案会保留配置但不会自动使用。

## 使用方式

### 转写选中的音频

在当前 Markdown 笔记中选中一条音频引用：

```markdown
![[Recording 20260531001942.m4a]]
```

执行命令 `Echo Notes: Transcribe selected audio`。

Echo Notes 会解析音频文件、调用配置的服务商、创建转写稿，并在音频引用下方插入转写稿链接。

如果已启用 AI 纪要分析，Echo Notes 会读取该录音链接上下三行文本，根据已启用方案的识别关键字自动选择方案并生成分析文档。未识别到关键字时，会使用默认分析方案。

### 转写当前笔记中的全部音频

在当前笔记中放入一个或多个音频链接：

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

执行命令 `Echo Notes: Transcribe all audio files in current note`。

如果已启用 AI 纪要分析，每个录音链接都会独立读取上下三行并匹配分析方案。不同录音可以通过不同关键字生成不同类型的纪要。

### AI 纪要分析生成规则

AI 纪要分析在转写完成后自动触发；如果转写稿已存在且开启“跳过已存在 transcript”，再次执行转写命令也会复用转写稿并生成或更新分析文档。

Echo Notes 会创建独立的分析文档，并在转写稿末尾插入分析链接区块。若同名分析文档已存在，会覆盖更新。

关键字只匹配来源笔记中录音链接上下三行，不匹配转写稿正文。若同一上下文命中多个方案，会按设置页中的方案顺序使用第一个已启用方案。

## 输出示例

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

分析链接示例：

```markdown
<!-- echo-notes-analysis-links:start -->
## AI 纪要分析

- [[Recording 20260531001942.transcript.analysis.work-minutes|工作纪要]]
<!-- echo-notes-analysis-links:end -->
```

分析文件示例：

```text
Recording 20260531001942/Recording 20260531001942.transcript.analysis.work-minutes.md
```

## 自动化

Echo Notes 可以选择性监听 Markdown 音频链接和新创建的音频文件。

- Markdown 音频链接：笔记变更后，插件会短暂等待，扫描支持的音频引用，转写缺失的转写稿，并插入缺失的转写稿链接。
- 新音频文件：Obsidian workspace 加载完成后，插件可以转写新创建的音频文件，但不会强行修改来源笔记；没有来源笔记上下文时，AI 纪要分析会使用默认方案。
- 转写时分析：开启 AI 纪要分析后，手动转写命令会根据录音链接上下三行自动选择方案并生成 AI 纪要分析文档。

所有自动化选项默认都是关闭的。

## 未来技术方向

- 批量分析多个转写稿。
- 从纪要中抽取结构化字段，例如任务、需求、风险和验收标准。
- 长转写稿自动分块、合并和二次校对。
- 更完善的本地模型支持。

## 构建

```bash
npm install
npm run build
```

运行 smoke tests：

```bash
npm test
```

## 本地测试安装

1. 使用独立测试 Vault。
2. 将本目录复制或软链接到 `.obsidian/plugins/echo-notes/`。
3. 执行 `npm install` 和 `npm run build`。
4. 在 Obsidian 中启用第三方插件。
5. 启用 Echo Notes。
6. 配置服务商 API Key。
7. 在笔记中插入音频链接并执行 Echo Notes 命令。

## 当前限制

- 不支持说话人分离。
- 不支持带时间戳的分段转写。
- 不支持大文件自动切片。
- 不支持本地 Whisper。
- AI 纪要分析暂不支持长文本分块。
- 暂无复杂任务队列 UI。
