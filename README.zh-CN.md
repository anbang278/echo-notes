<p align="right">
  <a href="./README.md">English</a> | 简体中文
</p>

# Echo Notes

Echo Notes 是一个基于 Obsidian 的个人行动记录与 AI Memory 构建插件。它从录音转写切入，把会议、灵感、学习、访谈和日常思考转化为 Markdown 文本，并通过可配置的 AI 分析模板，将原始语音沉淀为可搜索、可链接、可复盘、可长期复用的个人知识资产。

它希望解决的不只是“录音转文字”，而是让人的行动、思考和决策过程持续进入个人知识管理系统，最终成为 Personal Agent 可以调用的长期上下文。每一次录音，都是一次行动现场；每一份转写，都是一段可被 AI 理解的记忆；每一次结构化分析，都是在为未来的“AI 版本的自己”积累经验。

典型流程很自然：在 Markdown 笔记中插入或链接一段录音，执行转写命令，Echo Notes 会生成 `.transcript.md` 转写稿，并把“查看转写稿”的链接插回原始笔记。如果开启 AI 纪要分析，插件还会根据录音链接附近的关键词自动选择分析模板，并把结构化分析结果写回同一个转写稿。

> 隐私提醒：Echo Notes 只在你触发转写或 AI 分析时发起网络请求。转写会把所选音频上传到你配置的转写服务商；AI 分析会把转写文本上传到你配置的分析服务商。请不要处理不适合发送给外部服务的内容。

## 为什么需要 Echo Notes

### 不同场景下，录音内容需要不同的分析维度

传统转写工具通常只生成一份通用文本，但不同场合下，用户真正关心的信息并不一样。

- 工作会议更关注：结论、待办、责任人、时间点、风险和待确认问题。
- 学习记录更关注：知识点提炼、概念释义、结构化总结、例子和复习清单。
- 产品需求挖掘更关注：用户原话、痛点、需求动机、场景上下文、功能机会和验收标准。

Echo Notes 通过可配置的提示词模板，让同一类录音可以按具体场景生成更贴合需求的分析文档。你可以使用内置的工作纪要、学习纪要、产品需求挖掘和角色化工作模板，也可以配置自己的模板、识别关键词和提示词。

### 会议纪要和转写结果不应该散落在笔记库之外

很多会议纪要或转写产品可以生成内容，但结果通常停留在独立平台里，和用户日常使用的 Obsidian 笔记体系缺少连接。

这会带来几个问题：

- 录音文件、转写文本、会议纪要分散在不同工具中，后续查找成本高。
- 转写结果没有自动关联到今日日记、项目笔记或相关主题笔记，缺少上下文。
- 会议中的待办、结论、需求线索无法自然进入已有的知识管理流程。
- 后续复盘时，很难从一篇笔记追溯到原始录音、完整转写稿和结构化分析结果。

Echo Notes 的思路是让原始录音、完整转写稿和 AI 分析结果都沉淀在当前 Vault 中，并通过 Markdown 链接回到原始笔记。这样，语音内容可以自然接入日记、项目、会议、学习、需求管理等已有笔记体系。

## Echo Notes 的长期思想：记录行动，构建面向未来的 AI 版本的自己

Echo Notes 不只是一个录音转写插件，也不只是一个会议纪要工具。它更底层的思想是：人的思考、行动、判断和复盘，都应该被尽可能低摩擦地记录下来，并沉淀为可被 AI 理解和调用的个人上下文。

传统知识管理里，我们通常记录的是“结论”：一篇笔记、一份文档、一个会议纪要、一个任务清单。但真正决定一个人能力的，往往不是孤立的结论，而是结论背后的过程：为什么做这个判断，当时掌握了哪些信息，如何和别人讨论，提出过哪些假设，哪些行动被执行或放弃，后来结果是否验证了当初的判断。

这些过程过去很难被完整保存，因为它们散落在会议、语音、聊天、临时想法、待办、项目推进和复盘之中。Echo Notes 希望从最自然的输入方式开始：先把语音记录下来，再把语音转成文本，再把文本结构化，最后让这些内容变成个人 AI 可以长期使用的 Memory 与 Context。

从这个角度看，每一段录音都不只是一个文件，而是一次行动的证据；每一份转写稿都不只是文字，而是一次思考现场；每一次 AI 分析都不只是总结，而是在把人的经验压缩成未来可复用的认知资产。

长期来看，Echo Notes 想帮助用户构建一个更完整的“AI 版本的自己”：它知道你做过哪些项目，听过哪些会议，和谁讨论过什么问题；它知道你过去如何判断需求、如何拆解问题、如何做取舍；它知道你的表达习惯、决策偏好、知识结构和工作方法。未来，当某个问题再次出现时，Personal Agent 可以基于你真实的历史行动，而不是泛泛的通用知识，给出更贴近“你”的建议。

因此，Echo Notes 的真正目标不是帮你少写几份会议纪要，而是持续记录真实世界中的行动轨迹，并把这些轨迹转化为未来 AI 可以理解、检索、推理和协作的个人上下文基础设施。这个方向会优先尊重用户对数据的控制权：尽可能让个人记忆保存在自己的 Obsidian Vault 中，只在用户主动配置和触发时调用外部 Provider。

## 功能

- 在 Obsidian 设置页配置转写服务商、API Key、Base URL、模型和默认转写语言。
- 转写当前笔记中选中的音频链接。
- 扫描并转写当前笔记中的全部支持音频链接。
- 生成带 source metadata 的 Markdown 转写稿。
- 后续分段更新或重新转写只替换 Echo Notes 托管区块，保留人工批注、AI 分析和自定义 frontmatter；旧版转写稿首次迁移前会自动创建一次备份。
- 在原始音频引用下方插入转写稿链接。
- 跳过可复用的已存在转写稿，并补充缺失链接；复用要求源音频路径、大小、mtime、转写 Provider、模型和 `status: done` 全部匹配。
- 自定义输出目录下会为 transcript 文件名追加稳定的源路径短 hash，避免不同目录的同名音频互相覆盖。
- 在设置页展示当前转写 Provider 的上传方式、接口形态、文件限制、长音频分段、语言参数、时间戳和说话人分离能力。
- 可在设置页本地自检转写 Provider 配置，检查 API Key、Base URL、模型、HTTP 风险、接口形态和能力限制，不上传音频。
- 标准化转写 Provider 错误，并在展示或写入失败信息前脱敏 API Key、Authorization header、Base64 音频载荷和过长响应。
- 使用共享 AudioChunkPipeline 核心处理长音频准备、分段进度事件、逐段转写、文本合并、trace id 汇总、raw segment 收集，并释放已完成分段的音频 buffer。
- 可从 Ribbon 或命令面板打开内存型任务中心，查看转写和 AI 分析状态、失败原因、耗时、Provider、模型、输出文件，并重试失败任务。
- 可选开启手动上传前确认：上传前预览 Provider、Base URL、模型、文件大小和 HTTP 风险；开启后自动化会跳过需要确认的上传。
- 在设置页控制 Obsidian 核心插件录音机开关，并按需配置核心命令快捷键；插件不预设快捷键。
- 使用独立 AI 分析模型，将转写稿生成通用、学习、产品或角色化工作场景纪要。
- AI 纪要分析在后台异步执行，完成后直接写回对应转写稿。
- 可在发送转写稿前本地检查分析 API Key、Base URL、HTTPS 和模型配置，不调用 Provider。
- 长转写稿可按可配置字符数分块，逐块提取后再进行最终汇总，合并重复结论、行动项、风险和待确认问题。
- 可对当前打开的转写稿手动选择一个已启用 AI 分析模板并生成纪要。
- AI 纪要分析会优先读取来源笔记 frontmatter 指定的模板，其次读取来源笔记 tags，再根据录音链接上下三行的识别关键字自动选择分析模板，未命中时使用默认模板。
- 支持配置分析模板名称、识别关键字、系统提示词和自定义提示词。
- 可选：自动识别新增 Markdown 音频链接。
- 可选：自动识别新创建的音频文件。
- Markdown 音频链接自动化会在当前插件运行会话内按来源笔记、规范化音频路径、原始链接文本和同类出现序号去重，避免普通编辑反复触发同一链接。

## 服务商

转写服务商预设：

- 【免费】硅基流动（SiliconFlow）：默认模型 `FunAudioLLM/SenseVoiceSmall`
- 阿里百炼（Alibaba Bailian）：默认模型 `qwen3-asr-flash`
- OpenAI（OpenAI）：使用 OpenAI-compatible 音频转写接口
- Groq（Groq）：使用 OpenAI-compatible 音频转写接口
- Ollama、Ollama Open WebUI、Google Gemini、OpenRouter、LM Studio、302.AI、Anthropic、Mistral AI、Together AI、Fireworks AI、Perplexity AI、DeepSeek、xAI、Novita AI、DeepInfra、SambaNova、Cerebras、Z.AI：Provider-dependent 的 OpenAI-compatible 预设，仅在所配置服务真实实现 `/audio/transcriptions` 时可用
- 自定义兼容接口（Custom OpenAI-compatible）：用于自定义 `/audio/transcriptions` 端点

服务商的默认 Base URL 和模型都可以在设置页修改。设置页也会展示当前转写 Provider 的能力摘要，包括上传方式、接口形态、大小限制、是否支持长音频分段、语言参数、时间戳和说话人分离。

设置页还提供“检查转写配置”操作，会本地检查 API Key 是否存在、Base URL 格式、示例地址、非本地 HTTP 风险、模型提示、接口形态和已知能力限制。该检查不会上传音频，也不会真实调用服务商接口。

AI 纪要分析使用独立配置，默认是阿里百炼 `deepseek-v4-pro`，调用 OpenAI-compatible `/chat/completions` 接口。分析 Provider 列表与转写 Provider 列表保持一致；可选聊天模型预设需要确认支持 `{Base URL}/chat/completions`。

## 网络与数据使用

Echo Notes 只在触发转写或 AI 纪要分析时发起网络请求。

- 硅基流动默认地址：`https://api.siliconflow.cn`
- 阿里百炼默认地址：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- OpenAI 默认地址：`https://api.openai.com/v1`
- Groq 默认地址：`https://api.groq.com/openai/v1`
- AI 分析默认地址：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 自定义兼容接口：由用户自行配置

转写会把所选音频上传到你配置的转写服务商。AI 纪要分析会把转写稿文本上传到你配置的分析服务商。转写 API Key 和分析 API Key 都会按 Provider 隔离保存到 Obsidian `SecretStorage`，切换 Provider 不会复用其他服务商的密钥。转写稿和写回的 AI 纪要内容会保存在你的 Obsidian Vault。

如果在设置页开启“手动转写前确认上传”，Echo Notes 会在手动转写上传前显示确认弹窗，列出 Provider、Base URL、模型、文件大小和 HTTP 风险提示。开启该模式后，自动化转写会跳过需要确认的上传，避免后台未经确认发送音频。

## 支持的音频格式

- `mp3`
- `mp4`
- `mpeg`
- `mpga`
- `m4a`
- `wav`
- `webm`

服务商限制：

- 硅基流动：不超过 50 MB 的文件直接上传；更大的文件会先在本地解码并转换为约 10 分钟一段的 16 kHz mono WAV，再按顺序逐段转写。
- 阿里百炼 `qwen3-asr-flash`：本地音频会编码为 Base64 Data URL。如果整段音频编码后会超过 10 MB 输入限制，Echo Notes 会先在本地解码，把音频转换成 16 kHz mono WAV 分段，再按顺序逐段转写，并把已完成分段持续写回同一个 transcript 草稿。
- OpenAI-compatible 服务商：超过 25 MB 的文件会在上传前被阻止。

能力矩阵：

| Provider 类型 | 上传方式 | 接口形态 | 限制 | Echo Notes 分段 | 语言参数 | 时间戳 | 说话人分离 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 阿里百炼 `qwen3-asr-flash` | Base64 Data URL | `/chat/completions` + `input_audio` | 编码输入 10 MB | 支持 | 支持 | 暂不支持 | 暂不支持 |
| 硅基流动 `FunAudioLLM/SenseVoiceSmall` | multipart | SiliconFlow 专用端点 | 单段音频 50 MB | 支持 | 暂不支持 | 暂不支持 | 暂不支持 |
| OpenAI-compatible 预设和自定义端点 | multipart | `/audio/transcriptions` | 音频文件 25 MB | 暂不支持 | 支持 | 暂不支持 | 暂不支持 |

长音频分段目前适用于阿里百炼 `qwen3-asr-flash` 和硅基流动 `FunAudioLLM/SenseVoiceSmall`。分段 transcript 会保留类似 `## 分段 01（00:00-03:00）` 的标题，方便回听核对原录音位置。如果本地浏览器音频解码失败，Echo Notes 会写入带失败原因的 transcript。

默认转写语言只会发送给支持语言参数的 Provider，例如阿里百炼和 OpenAI-compatible 接口。SiliconFlow 官方转写接口只声明 `file` 和 `model`，因此 Echo Notes 不会向它发送非标准语言字段，仍由模型自动识别。

## 配置转写服务商

1. 打开 Obsidian 设置。
2. 打开 Echo Notes 设置页。
3. 选择转写服务商。
4. 确认或修改 Base URL 与 Model。
5. 输入该服务商的 API Key。
6. 选择默认转写语言。支持语言参数的 Provider 默认使用 `zh`；SiliconFlow 保持自动识别。
7. 在“文案语言”中选择中文或英文，控制回写链接和生成文稿中的固定文案。

推荐默认值：

| 服务商 | Base URL | Model | 默认语言 |
| --- | --- | --- | --- |
| 【免费】硅基流动（SiliconFlow） | `https://api.siliconflow.cn` | `FunAudioLLM/SenseVoiceSmall` | `auto` |
| 阿里百炼（Alibaba Bailian） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-asr-flash` | `zh` |
| OpenAI（OpenAI） | `https://api.openai.com/v1` | `whisper-1` | `zh` |
| Groq（Groq） | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | `zh` |
| 自定义兼容接口（Custom OpenAI-compatible） | 你的接口地址 | `whisper-1` | `zh` |

## 配置 Obsidian 核心插件录音机

Echo Notes 依赖 Obsidian `Audio recorder` Core plugin 生成录音文件。你可以在 Echo Notes 设置页顶部的“Obsidian 核心插件录音机”区域开启或关闭该 Core plugin。

该区域可以直接保存 Obsidian 核心录音机命令的快捷键。Echo Notes 不预设快捷键，避免覆盖保存、撤销等常用操作：

| 动作 | 命令 | 快捷键 |
| --- | --- | --- |
| 开始 Obsidian 核心插件录音机录音 | `audio-recorder:start` | 用户自行配置 |
| 停止 Obsidian 核心插件录音机录音 | `audio-recorder:stop` | 用户自行配置 |
| 转写当前笔记全部音频 | `Echo Notes: Transcribe all audio files in current note` | 用户自行配置 |

保存录音机快捷键时，Echo Notes 会直接更新 Obsidian 核心插件 `audio-recorder:start`、`audio-recorder:stop` 命令的用户热键配置；如果当前 Obsidian 版本未暴露内部 hotkey manager，请在 Obsidian Hotkeys 中手动配置。

## 配置 AI 纪要分析

1. 在 Echo Notes 设置页打开“启用 AI 纪要分析”。
2. 分析 Provider 默认使用 `阿里百炼`。
3. 分析 Base URL 默认是 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
4. 分析模型默认是 `deepseek-v4-pro`。切换分析 Provider 时，会自动填入该服务商可编辑的默认 Base URL 和模型。
5. 输入独立的分析 API Key。
6. 执行“检查分析配置”，本地验证 API Key、Base URL、HTTPS 和模型。
7. 长会议或访谈建议保持“长文本分块分析”开启。默认每块 24,000 字符，可在 4,000～100,000 之间调整。
8. 设置默认分析模板。录音链接上下三行未命中关键字时，会使用该模板。
9. 在“分析模板”中编辑、启用、禁用、恢复或新增模板。

内置模板：

- 工作纪要：摘要、关键结论、行动项、风险/阻塞、待确认问题。
- 学习纪要：核心概念、知识要点、案例/例子、易混淆点、复习清单。
- 产品需求挖掘纪要：用户/场景、痛点、需求机会、功能建议、优先级、验收标准、开放问题。
- 角色化工作模板：管理者、产品经理、项目经理、研发/技术、销售、客户成功、运营、HR/人力。角色模板默认禁用，可在设置页按需启用，并根据自己的工作流调整识别关键词。

自定义模板支持名称、识别关键字、系统提示词、自定义提示词和启用开关。已启用模板会参与录音链接上下三行的关键字匹配；禁用模板会保留配置但不会自动使用。

## 使用方式

### 转写选中的音频

在当前 Markdown 笔记中选中一条音频引用：

```markdown
![[Recording 20260531001942.m4a]]
```

执行命令 `Echo Notes: Transcribe selected audio`。

Echo Notes 会解析音频文件、调用配置的服务商、创建转写稿，并在音频引用下方插入转写稿链接。

如果已启用 AI 纪要分析，Echo Notes 会先读取来源笔记 frontmatter 中的 `echo_notes_analysis_template`、`echo_notes_template` 或 `analysis_template`。字段值可以是已启用模板的 id 或模板名称。若 frontmatter 没有命中已启用模板，再读取 frontmatter `tags` 和正文 `#tag`，并用它们匹配已启用模板的 id、名称和识别关键字。若 tag 没有命中，再读取该录音链接上下三行文本，根据已启用模板的识别关键字自动选择模板。转写稿链接插入后，AI 纪要会在后台生成；模型返回后，结果会写入同一个 `.transcript.md` 文件内的转写段落前面。未识别到关键字时，会使用默认分析模板。

### 转写当前笔记中的全部音频

在当前笔记中放入一个或多个音频链接：

```markdown
![[Recording 20260531001942.m4a]]
![[Recording 20260531002010.m4a]]
```

执行命令 `Echo Notes: Transcribe all audio files in current note`。

如果已启用 AI 纪要分析，每个录音链接都会独立读取上下三行并匹配分析模板。不同录音可以通过不同关键字生成不同类型的纪要。

### AI 纪要分析生成规则

AI 纪要分析在转写稿创建或复用后自动触发；转写稿链接会先写回原笔记，不会等待大模型返回。开启“跳过已存在 transcript”后，再次执行转写命令只会复用源音频路径、大小、mtime、Provider、模型和 `status: done` 全部匹配的转写稿，并在后台生成或更新 AI 纪要。

如需手动运行分析，可以打开一个 `.transcript.md` 文件，执行 `Echo Notes: Analyze current transcript with selected template`，然后选择任意已启用模板。

Echo Notes 会把 AI 纪要写入转写段落前面的受控区块。相同模板再次生成时会覆盖该模板已有结果，不会重复堆叠；不同模板会追加到同一个 AI 纪要分析区块中。

frontmatter 模板选择对整篇来源笔记生效，优先级高于 tags 和邻近关键字。tags 对整篇来源笔记生效，优先级高于邻近关键字。关键字只匹配来源笔记中录音链接上下三行，不匹配转写稿正文。若同一上下文命中多个模板，会按设置页中的模板顺序使用第一个已启用模板。

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

转写稿内 AI 纪要示例：

```markdown
原始录音：![[Recording 20260531001942.m4a]]
来源笔记：[[2026-06-05]]

<!-- echo-notes-analysis:start -->
# 纪要分析 Recording 20260531001942

<!-- echo-notes-analysis-item:start work-minutes -->
## 工作纪要

_生成时间：2026-06-01T10:00:00.000Z；Provider：aliyun-bailian；模型：deepseek-v4-pro_

### 摘要

这里是模型生成的纪要内容。
<!-- echo-notes-analysis-item:end work-minutes -->
<!-- echo-notes-analysis:end -->

# 转写稿 Recording 20260531001942

这里是完整转写文本。
```

## 自动化

Echo Notes 可以选择性监听 Markdown 音频链接和新创建的音频文件。

- Markdown 音频链接：笔记变更后，插件会短暂等待，扫描 frontmatter、围栏代码块和 HTML 注释之外的支持音频引用，转写缺失的转写稿，并插入缺失的转写稿链接。
- 新音频文件：Obsidian workspace 加载完成后，插件可以转写新创建的音频文件，但不会强行修改来源笔记；没有来源笔记上下文时，AI 纪要分析会使用默认模板。
- 转写时分析：开启 AI 纪要分析后，手动转写命令会根据录音链接上下三行自动选择模板，并在后台把 AI 纪要写回转写稿。

所有自动化选项默认都是关闭的。

## 未来技术方向

Echo Notes 的长期目标，是从录音转写工具逐步演进为个人 AI Memory Layer。未来会重点探索：

- 从纪要中抽取结构化字段，例如任务、需求、风险、决策、行动项、验收标准和复盘结果。
- 支持跨多个转写稿进行批量分析，形成项目级、主题级和时间线级总结。
- 将会议、学习、访谈、灵感和工作沟通沉淀为可检索的个人行动数据库。
- 为 Personal Agent 提供长期上下文，让 AI 能够基于用户真实历史记录进行辅助判断。
- 支持更完善的本地模型能力，尽可能让用户的个人记忆保存在自己的 Vault 中。
- 支持长转写稿自动分块、合并、二次校对和多轮分析。

## 构建

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

开发环境要求 Node.js 22 或更高版本。

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
- 暂不支持所有 Provider 通用的大文件自动切片；共享 AudioChunkPipeline 核心已存在，但 Provider 覆盖目前仍只适用于阿里百炼 `qwen3-asr-flash`。
- 不支持本地 Whisper。
- 长文本分析采用“逐块提取 + 最终汇总”，会增加模型调用次数和成本；Obsidian 重启后暂不支持从已完成分块继续。
- 任务中心目前是内存型状态面板，暂不支持持久化队列、暂停/取消和重启后续跑。
