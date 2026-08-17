<p align="right">
  <a href="./README.md">English</a> | 简体中文
</p>

# Echo Notes

Echo Notes 是一个基于 Obsidian 的个人行动记录与 AI Memory 构建插件。它从录音转写切入，把会议、灵感、学习、访谈和日常思考转化为 Markdown 文本，并通过可配置的 AI 分析模板，将原始语音沉淀为可搜索、可链接、可复盘、可长期复用的个人知识资产。

它希望解决的不只是“录音转文字”，而是让人的行动、思考和决策过程持续进入个人知识管理系统，最终成为 Personal Agent 可以调用的长期上下文。每一次录音，都是一次行动现场；每一份转写，都是一段可被 AI 理解的记忆；每一次结构化分析，都是在为未来的“AI 版本的自己”积累经验。

Echo Notes 提供两条独立转写流程：实时模式直接采集麦克风，一边录音一边把 AgentPlan 识别结果写入 `.transcript.md`；离线模式则转写 Vault 中已有的录音文件。两种模式都会把“查看转写稿”的链接写回来源笔记。完成转写后，如果开启 AI 纪要分析，插件还会根据录音链接附近的关键词自动选择分析模板，并把结构化分析结果写回同一个转写稿。实验性的 Echo Memory 流程可以继续把转写正文和本批成功纪要沉淀为可追溯的会议页、候选包与长期画像。

> 隐私提醒：Echo Notes 只在你主动开始实时转写、转写已有音频、触发 AI 分析或启用 Echo Memory 自动提取时发起网络请求。实时模式会把麦克风 PCM 持续发送给火山引擎 AgentPlan；离线模式会把所选音频发送给你配置的离线 Provider；AI 分析会把最终转写文本发送给分析 Provider；记忆提取会把转写正文和本批成功纪要发送给独立配置的记忆 Provider。请不要处理不适合发送给外部服务的内容。

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

- 在设置页选择“实时转写”或“离线转写”，两种模式使用相互隔离的 Provider 配置。
- 实时模式由 Echo Notes 独立采集麦克风，立即创建 WebM 录音附件和 `.transcript.md`，并持续写入临时文字、确定分句、说话人和时间范围。
- AgentPlan 连接失败时继续保存本地录音和已经确定的正文，停止后可在任务中心手动选择“使用离线 Provider 重试”，不会自动产生第二次调用费用。
- 离线模式支持阿里百炼、硅基流动、MOSI、Ollama 和 LM Studio，用于转写 Vault 中已有音频。
- 转写当前笔记中选中的音频链接。
- 扫描并转写当前笔记中的全部支持音频链接。
- 生成带 source metadata 的 Markdown 转写稿。
- 后续分段更新或重新转写只替换 Echo Notes 托管区块，保留人工批注、AI 分析和自定义 frontmatter；旧版转写稿首次迁移前会自动创建一次备份。
- 在原始音频引用下方插入转写稿链接。
- 跳过可复用的已存在转写稿，并补充缺失链接；复用要求源音频路径、大小、mtime、转写 Provider、模型和 `status: done` 全部匹配。
- 自定义输出目录下会为 transcript 文件名追加稳定的源路径短 hash，避免不同目录的同名音频互相覆盖。
- 在设置页“能力增强”中展示当前转写 Provider 与模型，并按“识别与结构、术语增强、上下文增强、快捷录音”组织能力；整组不支持时显示紧凑说明和可执行入口。
- 可在设置页本地自检转写 Provider 配置，检查 API Key、Base URL、模型、HTTP 风险、接口形态和能力限制，不上传音频。
- 标准化转写 Provider 错误，并在展示或写入失败信息前脱敏 API Key、Authorization header、Base64 音频载荷和过长响应。
- 使用共享 AudioChunkPipeline 核心处理长音频准备、分段进度事件、逐段转写、文本合并、trace id 汇总、raw segment 收集，并释放已完成分段的音频 buffer。旧版阿里百炼 `qwen3-asr-flash`、SiliconFlow 和 MOSI 的成功分段会在 transcript 托管区块内建立检查点；失败或重启后，源音频与 Provider 配置仍匹配时只处理剩余分段。
- 可从 Ribbon 或命令面板打开任务中心，查看转写、AI 分析和记忆任务的状态、失败原因、耗时、Provider、模型与输出。最多 100 条安全任务摘要会跨重启保留；普通运行中任务在重启后恢复重试入口，已提交的百炼异步任务则自动使用原 `task_id` 继续轮询。任务摘要不保存正文、临时上传凭证、签名结果地址或 API Key。
- 任务中心每张任务卡可导出同一链路的诊断 ZIP；设置页“自动化与日志”和命令 `Echo Notes: 导出诊断日志包` 可导出近期记录。诊断默认开启，最多保留最近 20 次、最长 7 天，始终只在本地保存。
- 可选开启手动上传前确认：上传前预览 Provider、Base URL、模型、文件大小和 HTTP 风险；开启后自动化会跳过需要确认的上传。
- 离线模式会按需启用 Obsidian 核心插件录音机，并在“快捷录音”卡片中记录、清除开始录音、停止录音和转写当前笔记全部音频的快捷键；不预设默认快捷键，也不提供关闭录音机入口。
- 使用独立 AI 分析模型，将转写稿生成通用、学习、产品或角色化工作场景纪要。
- AI 纪要分析在后台异步执行，完成后直接写回对应转写稿。
- 可在发送转写稿前本地检查分析 API Key、Base URL、HTTPS 和模型配置，不调用 Provider。
- 长转写稿可按可配置字符数分块，每个成功分块会写入 transcript 检查点，再进行一次最终汇总，去重结论、行动项、风险和待确认问题。重试只复用 transcript 正文、模板、Provider 配置、模型与分块边界仍匹配的连续成功前缀。
- 可对当前打开的转写稿手动选择一个已启用 AI 分析模板并生成纪要。
- AI 纪要分析会优先读取来源笔记 frontmatter 指定的模板，其次读取来源笔记 tags，再根据录音链接上下三行的识别关键字自动选择分析模板，未命中时使用默认模板。
- 支持配置分析模板角色分类、名称、识别关键字、系统提示词和模板任务。
- 可选初始化 Echo Memory 工作区，把转写正文和本批成功纪要提取为带原文证据、置信度和稳定 ID 的候选记忆。
- Echo Memory 的 Provider、API Key、Base URL、模型和长文本分块配置与 AI 分析阶段完全隔离，功能默认关闭。
- Echo Memory 长文本提取会把每个已通过证据校验的成功分块写入系统目录检查点；重试只复用 transcript、纳入分析、初始化用户、Schema/Prompt/Pipeline、Provider 配置、模型、语言和分块边界仍严格匹配的连续前缀。
- Echo Memory 的“转写增强”页签统一管理原生热词、固定提示词和已批准记忆上下文。只有已批准且命中全局或来源笔记作用域的内容会进入请求；功能默认关闭，待审核、拒绝或禁用内容不会外发。
- 每个候选包都有同目录 `.review.md` 审核 sidecar，可逐条批准、修正、拒绝或重置为待审核，并保存完整事件历史。
- 可在同一主体、不同候选的已批准断言之间人工确认冲突、补充、替代或作废关系；关系独立于不可变候选保存，只记录结构化端点元数据、回链与确认/撤销历史，撤销后可恢复此前画像。原文证据仅从当前已批准候选包读取供即时对比，不会在关系 JSON 中重复持久化。
- 支持“只保存审核”和“保存审核后自动编译画像与跨记录视图”两种沉淀模式；只有已批准且未被替代/作废的断言进入 User、人物、组织和项目画像。
- 可从候选包、审核 sidecar 和已批准关系完整重建画像，以及项目、人物、时间线三类聚合视图；每条聚合记录保留 transcript、候选、审核和关系回链，拒绝、重置、替代、作废或撤销后会同步更新，且不扫描整个 Vault、不覆盖人工正文。
- 可选：自动识别新增 Markdown 音频链接。
- 可选：自动识别新创建的音频文件。
- Markdown 音频链接自动化会在当前插件运行会话内按来源笔记、规范化音频路径、原始链接文本和同类出现序号去重，避免普通编辑反复触发同一链接。

## 服务商

实时转写：

- 火山引擎 AgentPlan：固定使用 `doubao-seed-asr-2.0` 和官方 `bigmodel_async` 端点，支持说话人分离与 utterance 时间范围，仅支持本地文件系统 Vault 的 Obsidian 桌面端

离线转写 Provider：

- 阿里百炼（Alibaba Bailian）：新安装默认异步模型 `qwen-audio-3.0-asr-flash-filetrans`；现有用户继续保留原模型，可在下拉框切换到 `qwen3-asr-flash`
- 【免费】硅基流动（SiliconFlow）：官方模型可选 `FunAudioLLM/SenseVoiceSmall`、`TeleAI/TeleSpeechASR`，也可填写自定义模型 ID
- MOSI（可选说话人分离）：可在普通转写 `moss-transcribe` 与多说话人转写 `moss-transcribe-diarize` 之间切换
- Ollama：通过本地 OpenAI-compatible `/audio/transcriptions` 端点转写
- LM Studio：通过本地 OpenAI-compatible `/audio/transcriptions` 端点转写

AgentPlan 实时转写的官方 `bigmodel_async` Base URL 和模型保持只读。MOSI 的官方 Base URL 也保持只读，模型由“说话人分离”开关自动派生：开启时使用 `moss-transcribe-diarize`，关闭时使用 `moss-transcribe`。其他离线 Provider 的默认值仍可修改。设置页会根据当前模式展示相应语言、麦克风或离线 Provider 配置，以及接口形态、大小限制、分段、时间戳和说话人分离能力。

设置页“转写服务”仍提供“检查转写配置”操作，会本地检查 API Key 是否存在、Base URL 格式、示例地址、非本地 HTTP 风险、模型提示、接口形态和已知能力限制。该检查不会上传音频，也不会真实调用服务商接口。

AI 纪要分析按顺序支持硅基流动、**OpenCode Go**、阿里百炼、DeepSeek、火山引擎 AgentPlan、Ollama、LM Studio 和自定义兼容接口。全局默认仍是阿里百炼 `deepseek-v4-pro`；切换到 OpenCode Go 时默认使用 `deepseek-v4-flash`，硅基流动默认模型为 `Qwen/Qwen3.5-4B`。OpenCode Go 仅用于 AI 分析，固定使用官方 Base URL `https://opencode.ai/zen/go/v1`，模型选择器采用当前对接文档快照：Grok 4.5、GLM-5.2/5.1、GPT 5.6 Luna、Kimi K3/K2.7 Code/K2.6、MiMo-V2.5/Pro、MiniMax M3/M2.7、Qwen3.8 Max/Qwen3.7 Max/Plus/Qwen3.6 Plus、DeepSeek V4 Pro/Flash、Hy3。插件会按模型自动路由到文档规定的 Chat Completions、Responses 或 Messages 接口。可用模型、订阅额度和数据留存政策可能变化，发送内容前请查阅 [OpenCode Go 对接文档](https://opencode.ai/docs/zh-cn/go)。选择 AgentPlan 后固定使用套餐专属 Base URL `https://ark.cn-beijing.volces.com/api/plan/v3`，并可从套餐当前支持的文本模型中选择豆包 Seed 2.0 Mini/Lite/Pro、豆包 Seed Evolving、DeepSeek V4、MiniMax M2.7/M3、GLM-5.2、Kimi K2.6/K2.7 Code/K3 等型号。Kimi K3 需要 Medium 及以上套餐，尝鲜模型在高峰期可能出现限流。AgentPlan 分析与 AgentPlan ASR 的配置和密钥仍按用途隔离。

AgentPlan 套餐官方限定文本生成与向量化能力用于 AI 工具场景。使用 Echo Notes 接入前，请确认你的使用方式符合当前套餐规则；在非 AI 工具或不符合规则的场景中使用专属 Base URL 和 API Key，可能触发订阅停用或账号限制。

## 网络与数据使用

Echo Notes 只在触发转写、AI 纪要分析或 Echo Memory 记忆提取时发起网络请求。

- 硅基流动默认地址：`https://api.siliconflow.cn`
- 阿里百炼异步转写默认地址：`https://dashscope.aliyuncs.com`；旧兼容转写与文本分析继续使用 `/compatible-mode/v1`
- MOSI 转写地址：`https://api.mosi.cn/v1/audio/transcriptions`
- 火山引擎 AgentPlan 实时 ASR 地址：`wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async`
- 火山引擎 AgentPlan 文本分析地址：`https://ark.cn-beijing.volces.com/api/plan/v3`
- OpenCode Go 文本分析地址：`https://opencode.ai/zen/go/v1`（具体 API 路径由所选模型决定）
- Ollama 转写默认地址：`http://localhost:11434/v1`
- LM Studio 转写默认地址：`http://localhost:1234/v1`
- AI 分析默认地址：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 其他 AI 分析地址使用所选分析 Provider 配置的 Base URL；OpenCode Go 与 AgentPlan 的专属地址保持只读。
- Echo Memory 使用独立选择的记忆 Provider Base URL，并调用其 OpenAI-compatible `/chat/completions` 端点。

离线转写会把所选音频发送到当前离线 Provider。百炼新模型先获取短期 OSS 表单凭证，把本地文件上传到百炼临时存储，再用 `oss://` 地址提交异步任务；临时凭证仅存在于内存，不写入设置、任务或日志。开启说话人分离时，Echo Notes 会先生成整段 16 千赫兹单声道 WAV；超过 2 小时、解码失败或内存不足会阻止提交，不会静默降级。选择 MOSI 时，Echo Notes 会以 multipart 方式把音频上传到 `api.mosi.cn`，使用同步非流式请求。Vault 中不会生成临时分段文件。

实时模式不会先生成或转换整段 WAV：Echo Notes 在本地同时执行两条链路，一条使用 `MediaRecorder` 将 WebM Opus 分片约每秒顺序追加到 Vault 附件，另一条把麦克风音频连续降混并重采样为 16 kHz、16-bit、mono PCM，再通过同一条鉴权优化双流 WebSocket 以 200 ms 音频包发送给 AgentPlan。录音附件、转写稿、音频嵌入和“查看转写稿”链接会在开始时立即创建。服务端确认的二遍高精度分句会持续写入转写稿，未确定文字只显示在临时区域；AgentPlan 中断不会停止本地录音，已经落盘的录音和正文会保留。

实时 AgentPlan 和开启说话人分离后的 MOSI 返回的说话人编号只能区分声音，不能识别真实姓名。MOSI 的说话人编号只在每个独立分段内有效。AI 纪要分析只读取完成后的最终正文，并把文本发送给分析 Provider；选择 AgentPlan 时使用其专属 Chat API，选择 OpenCode Go 时则发送到所选模型的官方接口。Echo Memory 会把转写正文和纳入本批次的成功纪要发送给记忆 Provider。转写、分析和记忆 API Key 会按 Provider 与用途隔离保存到 Obsidian `SecretStorage`；密钥不会写入插件设置、转写稿、候选包或日志。转写稿、录音、AI 纪要和记忆文件保存在你的 Obsidian Vault。

## 诊断日志包

当转写、分析或 Echo Memory 出现难以复述的问题时，可在任务中心任务卡选择“导出诊断包”，或在“自动化与日志”中导出近期记录。ZIP 仅生成在当前 Vault 的 `Echo Notes/诊断包/`，由你自行发送；插件不会自动上传。桌面端本地文件系统 Vault 的导出完成弹窗可在 macOS 访达或 Windows 文件资源管理器中定位该 ZIP。清空诊断记录不会删除已经生成的 ZIP。

固定内容包括脱敏配置快照、任务索引、请求/分块/重试/恢复的生命周期事件、HTTP 或 WebSocket 状态、错误分类与 Trace ID。默认不会保存或导出音频、转写正文、提示词、成功响应正文、AI 分析结果、Memory 候选、Vault 名称、文件名、原始路径、用户名、设备名、API Key、鉴权头或 SecretStorage 标识。Base URL 会移除用户名、密码、查询参数和片段，局域网主机也会脱敏。

导出窗口可单独勾选“转写正文”“AI 分析结果”“Memory 候选”；这三项默认关闭，只在导出时读取，不写入自动诊断留存。可选内容未压缩前合计上限 10 MB，超过后需要减少选择，绝不会静默截断。音频永远不会被包含。对于升级前生成的旧任务，仍可导出配置与任务快照；请升级后重现一次以取得请求级日志。

如果在设置页开启“手动转写前确认上传”，Echo Notes 会在手动转写上传前显示确认弹窗，列出 Provider、Base URL、模型、文件大小和 HTTP 风险提示。开启该模式后，自动化转写会跳过需要确认的上传，避免后台未经确认发送音频。

## 支持的音频格式

- `mp3`
- `mp4`
- `mpeg`
- `mpga`
- `m4a`
- `ogg`
- `wav`
- `webm`

服务商限制：

- 火山引擎 AgentPlan `doubao-seed-asr-2.0`：实时模式固定使用 `bigmodel_async`，要求 Obsidian 桌面端和本地文件系统 Vault，并始终开启说话人聚类与 utterance 时间范围；普通方舟 API Key 不可混用。
- 硅基流动：单次音频必须同时不超过 50 MB 和 1 小时；超过任一限制时，会先在本地解码并转换为约 10 分钟一段的 16 kHz mono WAV，再按顺序逐段转写。读取不到媒体时长时仍会先按文件大小判断并尝试正常请求。
- 小音频遇到 HTTP `500/502/503/504` 时会按 1 秒、3 秒退避重试；仍失败则自动进入分段。单个分段持续失败时只二分该段，`413` 会直接触发二分，最短 60 秒、最多四层；鉴权、额度、限流和模型错误不会拆分。
- 自动重试和缩段会产生额外 Provider 请求，但不会自动切换 Provider、API Key 或模型。已经成功的分段不会重传，失败时会保留已写入正文、Trace ID 和失败时间范围。
- 限制与模型列表以[硅基流动转写接口文档](https://docs.siliconflow.cn/cn/api-reference/audio/create-audio-transcriptions)为准。
- 阿里百炼 `qwen-audio-3.0-asr-flash-filetrans`：使用临时上传、异步提交、轮询和结果下载链路。当前临时上传模式按 1 GB 上限设计，不宣称支持用户自有 OSS 场景的完整 2 GB；结果地址默认 24 小时有效。说话人分离默认开启、人数默认自动识别，可选填 2～100。关闭分离后仍使用整段异步任务。
- 阿里百炼旧模型 `qwen3-asr-flash`：继续使用 Base64 Data URL；编码后超过 10 MB 时在本地转换为 16 千赫兹单声道 WAV 分段，并持续回写已完成分段。
- MOSI：开启“说话人分离”时使用 `moss-transcribe-diarize`、版本 `moss-transcribe-diarize-20260325` 并传入 `diarize=true`；关闭时使用普通模型 `moss-transcribe` 和版本 `moss-transcribe-v1`，不发送 `diarize`。两种模式都使用官方同步非流式 multipart 请求。超过 3 分钟时在本地切成约 3 分钟的 WAV 分段并逐段回写；HTTP `500/502/503/504` 按 1 秒、3 秒重试，仍失败、收到 `413` 或明确过长/过大响应时，只缩小当前失败段，最短 30 秒、最多四层。MOSI 未公布稳定的文件大小上限；详见 [MOSI 转写接口文档](https://platform.mosi.cn/docs/reference/transcriptions)。
- Ollama 和 LM Studio：超过 25 MB 的文件会在上传前被阻止。

能力矩阵：

| Provider 类型 | 上传方式 | 接口形态 | 限制 | Echo Notes 分段 | 语言参数 | 时间戳 | 说话人分离 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 火山引擎 AgentPlan 实时 `doubao-seed-asr-2.0` | 麦克风 PCM 鉴权优化双流 WebSocket | `/api/v3/plan/sauc/bigmodel_async` | 仅桌面端、本地文件系统 Vault | 不分段，单实时会话 | 中文或 auto | utterance 级支持 | 支持 |
| 阿里百炼 `qwen-audio-3.0-asr-flash-filetrans` | 百炼临时 OSS | `/api/v1/services/audio/asr/transcription` + Task API | 临时上传 1 GB；模型最长 12 小时 | 不分段，整段异步任务 | 支持 | 句子与词级支持 | 默认开启 |
| 阿里百炼 `qwen3-asr-flash` | Base64 Data URL | `/chat/completions` + `input_audio` | 编码输入 10 MB | 支持 | 支持 | 暂不支持 | 暂不支持 |
| 硅基流动 `FunAudioLLM/SenseVoiceSmall` / `TeleAI/TeleSpeechASR` / 自定义模型 | multipart | SiliconFlow 专用端点 | 单次 50 MB 且 1 小时 | 支持；约 10 分钟切分并可缩段恢复 | 暂不支持 | 暂不支持 | 暂不支持 |
| MOSI `moss-transcribe` / `moss-transcribe-diarize` | multipart | `/v1/audio/transcriptions` | 由 MOSI 服务端决定 | 支持；约 3 分钟切分并可缩段恢复 | 暂不支持 | 仅分离模式支持 segment 级时间 | 可选 |
| Ollama 和 LM Studio | multipart | `/audio/transcriptions` | 音频文件 25 MB | 暂不支持 | 支持 | 暂不支持 | 暂不支持 |

长音频分段只属于离线流程，目前适用于阿里百炼 `qwen3-asr-flash`、硅基流动的官方或自定义转写模型，以及 MOSI。每个成功分段都会写入 transcript 托管区块内可读的检查点，记录源音频路径/大小/mtime、Provider、模型、无密钥配置指纹、时间范围、正文、Trace ID，以及可用时的说话人分句。重试只复用身份与边界仍匹配、从音频开头连续完成的分段；音频或配置变化、检查点损坏时会安全地重新开始。M4A、MP4、WebM 仍需由 Web Audio 在本地完整解码，可能受设备可用内存限制；Echo Notes 不会安装或调用 FFmpeg。实时 AgentPlan 会话直接消费麦克风 PCM：约每 500 ms 合并刷新临时文字，新增确定分句、停止、完成或失败时强制落盘。AgentPlan 中断后本地录音继续；停止时任务中心会提供离线重试，但不会自动上传。MOSI 分段稿继续保留类似 `## 分段 01（00:00-03:00）` 的标题；开启说话人分离时编号会在每个分段内重新开始，时间范围仍对应原音频的绝对时间，普通模式不输出说话人标签。

默认转写语言只会发送给支持语言参数的 Provider，例如阿里百炼、Ollama 和 LM Studio。AgentPlan 说话人分离只使用中文或省略 language；选择其他语言时会自动切换为 `auto`。Echo Notes 不会向 SiliconFlow 或 MOSI 发送 language 字段，由服务端自动识别音频语言。

AgentPlan 与开启说话人分离后的 MOSI 转写稿会显示说话人标签。MOSI 另有“说话人分离”开关；关闭后会隐藏“说话人标签样式”并只输出普通正文。开启标签时，可选择仅显示说话人，或使用默认的“说话人＋时间”：

```markdown
**说话人 1（00:00-00:12）**

转写正文。
```

## 配置转写模式

1. 打开 Obsidian 设置中的 Echo Notes。
2. 在 Provider 上方选择“实时转写”或“离线转写”。新安装默认离线模式和阿里百炼。
3. 实时模式：填写 AgentPlan 专属 API Key，在“高级能力”中选择语言、说话人标签样式和麦克风；官方 Base URL 与模型只读。只有刷新麦克风或开始录音时才会申请权限。
4. 离线模式：选择阿里百炼、硅基流动、MOSI、Ollama 或 LM Studio，填写 API Key 并确认可用配置；在“高级能力”中配置说话人分离、热词增强、上下文增强和核心录音机。MOSI 的官方 Base URL 只读，通过“说话人分离”开关切换自动派生的只读模型。
5. 在“文案语言”中选择中文或英文，控制回写链接和生成文稿中的固定文案。

实时命令：

- `Echo Notes: Start realtime transcription`
- `Echo Notes: Stop realtime transcription`
- `Echo Notes: Open active realtime transcript`

实时模式下会显示麦克风 Ribbon；录音时点击同一 Ribbon 即停止。切换活动笔记不会改变会话归属，录音和转写稿始终绑定启动时的来源笔记。

推荐默认值：

| 服务商 | Base URL | Model | 默认语言 |
| --- | --- | --- | --- |
| 火山引擎 AgentPlan（实时） | `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async` | `doubao-seed-asr-2.0` | `zh` |
| 阿里百炼（Alibaba Bailian） | `https://dashscope.aliyuncs.com` | `qwen-audio-3.0-asr-flash-filetrans` | `zh` |
| 【免费】硅基流动（SiliconFlow） | `https://api.siliconflow.cn` | `FunAudioLLM/SenseVoiceSmall` | `auto` |
| MOSI（可选说话人分离） | `https://api.mosi.cn/v1` | 默认 `moss-transcribe-diarize`；关闭后 `moss-transcribe` | `auto` |
| Ollama | `http://localhost:11434/v1` | `whisper-1` | `zh` |
| LM Studio | `http://localhost:1234/v1` | `whisper-1` | `zh` |

## 配置 Obsidian 核心插件录音机

Obsidian `Audio recorder` Core plugin 仅用于离线流程：它停止录音后保存完整文件，再由 Echo Notes 的离线 Provider 转写。实时转写使用 Echo Notes 自己的录音器，因为核心录音机没有稳定公开的实时音频分片接口。你可以在离线模式设置区开启或关闭该 Core plugin。

该区域可以直接保存 Obsidian 核心录音机命令的快捷键。Echo Notes 不预设快捷键，避免覆盖保存、撤销等常用操作：

| 动作 | 命令 | 快捷键 |
| --- | --- | --- |
| 开始 Obsidian 核心插件录音机录音 | `audio-recorder:start` | 用户自行配置 |
| 停止 Obsidian 核心插件录音机录音 | `audio-recorder:stop` | 用户自行配置 |
| 转写当前笔记全部音频 | `Echo Notes: Transcribe all audio files in current note` | 用户自行配置 |

保存录音机快捷键时，Echo Notes 会直接更新 Obsidian 核心插件 `audio-recorder:start`、`audio-recorder:stop` 命令的用户热键配置；如果当前 Obsidian 版本未暴露内部 hotkey manager，请在 Obsidian Hotkeys 中手动配置。

## 配置 AI 纪要分析

1. 在 Echo Notes 设置页打开“启用 AI 纪要分析”。
2. 分析 Provider 可选硅基流动、阿里百炼、DeepSeek、火山引擎 AgentPlan、Ollama、LM Studio 或自定义兼容接口；全局默认仍为阿里百炼。
3. 阿里百炼分析 Base URL 默认是 `https://dashscope.aliyuncs.com/compatible-mode/v1`，硅基流动默认是 `https://api.siliconflow.cn/v1`。选择 AgentPlan 后，专属 Base URL `https://ark.cn-beijing.volces.com/api/plan/v3` 为只读，避免误走普通方舟按量接口。
4. 阿里百炼默认模型是 `deepseek-v4-pro`，硅基流动默认模型是 `Qwen/Qwen3.5-4B`。选择 AgentPlan 后，从设置页列出的套餐文本模型中选择，默认 `doubao-seed-2.0-lite`。
5. 输入独立的分析 API Key。AgentPlan 必须使用其控制台创建的专属 API Key；分析密钥不会复用或覆盖实时转写密钥。
6. 执行“检查分析配置”，本地验证 API Key、Base URL、HTTPS 和模型。
7. 长会议或访谈建议保持“长文本分块分析”开启。默认每块 24,000 字符，可在 4,000～100,000 之间调整。
8. 设置默认分析模板。录音链接上下三行未命中关键字时，会使用该模板。
9. 在“分析模板”中编辑、启用、禁用、恢复或新增模板。

内置模板按角色分为 6 类：

- 通用场景：工作纪要、学习纪要。
- 管理与组织：管理者纪要、HR/人力纪要。
- 产品与交付：产品需求挖掘纪要、产品经理纪要、项目经理纪要。
- 技术研发：研发/技术纪要。
- 客户与增长：销售纪要、客户成功纪要、运营纪要。
- 自定义：新建模板默认归入此类，也可以在编辑器中改到其他角色分类。

模板管理页使用固定分类切换器，一次只显示当前分类；可点击切换，也可用左右方向键、Home 和 End 键快速定位。分类切换和模板启停导致设置页刷新后，当前分类会继续保留。

v2 内置提示词使用各角色专属的 Markdown 输出结构，并共享中立的证据规则：区分事实、决策、建议和推断，不补造负责人、日期、预算、指标、优先级或商机阶段，把转写正文视为不可信数据而非指令。包含行动项的模板统一使用“事项、负责人、截止时间、验收信号/下一步”表格。

自定义模板支持角色分类、名称、识别关键字、系统提示词、模板任务和启用开关。已启用模板会参与录音链接上下三行的关键字匹配；禁用模板会保留配置但不会自动使用。升级时，仅仍与旧预设完全一致的 v1 内置模板会自动升级到 v2，并保留启用状态；改过名称、描述、关键词或提示词的内置模板不会被覆盖，可通过“恢复默认”主动切换到 v2。

## 配置 Echo Memory MVP

Echo Memory 默认关闭。进入设置页“记忆提取”阶段后，先从“概览”按推荐操作开始：

1. 初始化记忆库，只填写称呼、当前角色和近期目标。初始化完成后会自动启用记忆提取，目录语言按当时的界面文案语言固定。
2. 在“提取设置”中选择独立的记忆服务商、模型和 API Key；记忆密钥按服务商保存在 Obsidian `SecretStorage`，不会复用分析密钥。长文本分块等低频参数默认折叠。
3. 从当前转写稿或“概览”的推荐操作开始提取。结果先进入“审核与应用”的“记忆审核中心”，AI 只提出候选，不会自动批准；审核时可以修正实际生效内容。
4. 在“审核与应用”中管理候选、记忆关系、术语与上下文增强，以及按项目/人物/日期生成 Personal agent 上下文包。关系不会自动建立，原始转写也不会被静默覆盖。
5. 在“高级维护”中处理根目录、配置自检、画像重建和教学示例。候选包和审核 sidecar 始终保留为事实源；自动编译模式会在保存审核后更新画像、项目/人物/时间线聚合。

默认中文目录如下：

```text
Echo Memory/
├── 00 首页.md
├── 01 会议/
├── 02 记忆候选/（候选 `.md` 与审核 `.review.md`）
├── 03 实体/人物、组织、项目/
├── 04 User/SOUL.md、01～08 个人画像文档
├── 05 聚合/项目.md、人物.md、时间线.md
├── 06 上下文包/（Personal Agent 预览 Markdown）
├── 07 转写增强/术语与上下文.md
└── 99 系统/echo-memory.json、echo-memory-checkpoints.json、echo-memory-relations.json、运行日志/
```

每个候选包同时包含便于阅读的 Markdown 表格和插件托管的 JSON 数据。候选包保持模型提取时的内容，不因审核而改写。新候选使用 Schema v2，并把每条断言分类为六种记忆类型之一（`fact`、`decision`、`preference`、`belief`、`experience`、`goal`）和 `working`/`long_term` 两种时效之一，可选附带简短的准入理由与有证据支撑的有效时间范围。旧 Schema v1 候选无需迁移即可继续读取和审核；其断言不猜测类型，画像兼容时按长期处理。同目录审核 sidecar 使用 `echo-memory-review:managed` 托管区块记录逐条状态、生效内容、备注、审核时间和完整事件历史，区块外人工正文会保留。输入指纹由转写正文、纳入的成功纪要、Schema、提示词版本、流水线版本、输出语言、初始化用户、Provider 和模型共同生成；相同输入会复用已有候选，不会重复调用模型。旧候选首次审核或重建时会创建全为 `pending` 的 sidecar，不会静默批准。画像只消费已批准的长期断言（或没有时效字段的旧断言），并只替换 `echo-memory:managed` 标记之间的内容，标记外的人工正文会保留；工作记忆保留在时间线、跨记录视图和上下文包中。

单个记忆提取任务最长运行 15 分钟，所有分块共享这一时限。任务中心会为运行中和失败的记忆任务提供“重试记忆提取”；重试会先结束当前等待，确认旧尝试退出后再重新开始，迟到响应不会写入候选包。超时、其他失败和主动重试都会写入 `99 系统/运行日志`，失败日志同时保留来源转写稿与重试指引。

分块提取的每个成功响应都要先通过原文证据校验，随后才把结构化断言写入 `99 系统/echo-memory-checkpoints.json`（英文工作区对应 `99 System`）。每块最多保存 24,000 字符的结构化结果，共享存储最多 25,000,000 字符和 100 个未完成 transcript；其中不包含 API Key、认证头、完整请求或 Provider 原始响应。失败会保留当前 transcript 的条目供显式重试；候选包、审核 sidecar、清单记录、会议页和可选画像编译全部成功后，只清理当前 transcript 的条目，不删除共享文件。检查点属于敏感派生记忆；不需要恢复时可由用户手动移走或归档。续跑生成的结果仍是待审核候选，未经批准不会进入画像。

已批准记忆关系以可读 JSON 保存在 `99 系统/echo-memory-relations.json`（英文工作区对应 `99 System`）。打开候选包或审核 sidecar 后执行“管理当前记忆关系”，只能关联同一规范化主体、不同候选中的已批准断言。确认冲突或补充时，两条断言都保留在画像中，并显示关系 ID 与候选/审核回链；确认替代或作废时，目标断言不再作为画像事实出现，但来源断言仍保留其审计回链；撤销后重新编译会恢复目标。任一断言不再批准或生效内容发生变化时，关系自动变为不适用，不会继续压制记忆，需用户重新确认。关系存储最多 5,000 条、每条最多 100 个事件、总计最多 10,000,000 字符，只保留结构化端点元数据、生效值、ID、时间、候选/审核回链和事件历史，不再重复保存 `evidenceQuote` 原文。关系编辑器从当前已批准候选包读取证据；证据缺失时安全降级为回链提示。带可选证据字段的旧关系文件仍可读取，并会在读取时惰性清理且不升级 Schema 版本；原始候选包不会被关系操作改写。

每次画像重建还会同步生成 `05 聚合` 下的三份关系感知 Markdown：项目视图按规范化项目分组，人物视图按规范化人物分组，时间线按观察时间稳定排序全部当前已批准断言。替代或作废目标不会进入聚合，冲突和补充两端都保留；每条记录包含 transcript、候选、审核和适用关系回链。聚合文件与首页导航使用独立托管区块，区块外人工内容会保留。旧版 v1 Manifest 在首次重建时平滑补齐新增路径，不改变 Schema 版本。

执行“Create personal agent context package”会先打开生成前预览。用户可以按项目、人物、起止日期筛选当前已批准且关系解析后的记忆，并可进一步按记忆类型和时效筛选（不选表示不限；没有时效字段的旧断言按长期处理）；同时设置 4,000～100,000 字符预算（默认 12,000），项目和人物筛选使用 OR 语义，结果按最新观察时间优先排列，超出预算的条目会明确显示省略数量。确认后文件写入 `06 上下文包`，每条事实保留证据、transcript、候选、审核和关系回链，重复生成只更新 `echo-memory-context:managed` 区块并保留区块外人工正文。该流程默认完全本地，不会发送笔记或调用外部 Agent。

可用命令：

- `Echo Notes: Initialize Echo Memory`
- `Echo Notes: Extract memory from current transcript`
- `Echo Notes: Review current memory candidate`
- `Echo Notes: Manage current memory relations`
- `Echo Notes: Manage transcription enhancement`
- `Echo Notes: Generate pending transcription term candidates from approved memory`
- `Echo Notes: Open Echo Memory home`
- `Echo Notes: Open Echo Memory timeline`
- `Echo Notes: Create personal agent context package`
- `Echo Notes: Rebuild memory profiles and aggregations from candidates`

当前 MVP 不包含外部 Agent CLI、语义检索、向量数据库、跨 Vault 同步、自动执行日历/笔记动作、自动批准记忆、自动关系发现或完整的工作记忆过期生命周期；上下文包只提供本地、可预览的 Markdown。

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

单个 AI 分析任务最长运行 15 分钟；长文本的分块提取与最终汇总共享这一时限。超时后任务会自动标记为失败，在转写稿中保留错误状态，并可从任务中心重试。分块运行每成功一块，就会立即在同一 transcript 内按模板隔离的隐藏 Obsidian 注释中保存检查点。重试会跳过严格匹配的连续成功前缀，并始终重新执行最终汇总；transcript 正文、脱敏开关、模板内容或版本、Provider、Base URL、模型、语言、分块设置或边界任一变化，都会从第一块安全重做。

未完成的分析检查点每个成功分块最多保存 12,000 字符的模型派生结果，不保存 API Key 或 Provider 原始响应，并在最终分析成功写入后清理。失败任务会为续跑而把这些派生内容保留在 Vault 中，因此 transcript 文件也应按敏感数据管理；如果不希望保留失败运行，可由用户手动删除对应文件。

如需手动运行分析，可以打开一个 `.transcript.md` 文件，执行 `Echo Notes: Analyze current transcript with selected template`，然后选择任意已启用模板。

Echo Notes 会把 AI 纪要写入转写段落前面的受控区块。相同模板再次生成时会覆盖该模板已有结果，不会重复堆叠；不同模板会追加到同一个 AI 纪要分析区块中。

新格式写入的 AI 纪要区块只保留模板标题和模型生成内容；`echo_notes_analysis_` 前缀的 Dataview 内联字段以及生成时间、服务商、模型、Trace ID 摘要会统一写到同一个 `.transcript.md` 文件末尾可见的 `Echo Notes 技术信息` 区块。这些字段不需要解析正文即可用于 Dataview 查询。本次结构调整之前生成的转写稿保持原样。

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

### 摘要

这里是模型生成的纪要内容。
<!-- echo-notes-analysis-item:end work-minutes -->
<!-- echo-notes-analysis:end -->

# 转写稿 Recording 20260531001942

这里是完整转写文本。

<!-- echo-notes-transcript-technical:start -->
# Echo Notes 技术信息

<!-- echo-notes-technical-item:start work-minutes -->
## 工作纪要

- [echo_notes_analysis_template_id:: work-minutes]
- [echo_notes_analysis_template_name:: 工作纪要]
- [echo_notes_analysis_template_version:: 1]
- [echo_notes_analysis_provider:: aliyun-bailian]
- [echo_notes_analysis_model:: deepseek-v4-pro]
- [echo_notes_analysis_generated_at:: 2026-06-01T10:00:00.000Z]

_生成时间：2026-06-01T10:00:00.000Z；服务商：aliyun-bailian；模型：deepseek-v4-pro_
<!-- echo-notes-technical-item:end work-minutes -->
<!-- echo-notes-transcript-technical:end -->
```

## 自动化

Echo Notes 可以选择性监听 Markdown 音频链接和新创建的音频文件。

- Markdown 音频链接：笔记变更后，插件会短暂等待，扫描 frontmatter、围栏代码块和 HTML 注释之外的支持音频引用，转写缺失的转写稿，并插入缺失的转写稿链接。
- 新音频文件：Obsidian workspace 加载完成后，插件可以转写新创建的音频文件，但不会强行修改来源笔记；没有来源笔记上下文时，AI 纪要分析会使用默认模板。
- 转写时分析：开启 AI 纪要分析后，手动转写命令会根据录音链接上下三行自动选择模板，并在后台把 AI 纪要写回转写稿。

所有自动化选项默认都是关闭的。

## 未来技术方向

Echo Notes 的长期目标，是从录音转写工具逐步演进为个人 AI Memory Layer。Echo Memory 已验证“转写 → 候选 → 审核 → 关系 → 跨记录视图”闭环，后续会重点探索：

- 为 Personal Agent 提供长期上下文，让 AI 能够基于用户真实历史记录进行辅助判断。
- 生成可预览、有长度上限、可按项目、人物、时间和证据状态筛选的 Personal Agent 上下文包。
- 在明确授权下触发日历、笔记写入和外部 Agent 工作流。
- 评估本地向量索引在候选规模扩大后的必要性，而不是把向量数据库设为首版依赖。
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

后续版本迭代的本地常规回归统一执行：

```bash
npm run verify
```

该入口会依次检查 `package.json`、`package-lock.json`、`manifest.json` 与
`versions.json` 的版本一致性、历史自动化测试、Lint、类型检查、生产构建、
隔离真实 Obsidian 设置页/新人指引 UI 回归、已暂存与未暂存 `git diff --check`
以及生产依赖审计。UI 验证目前要求 macOS 已安装 Obsidian Desktop；专用测试
Vault 必须启用 `echo-notes`，且 `.obsidian/plugins/echo-notes` 必须是解析到当前
工程根目录的软链接，不能使用复制安装。可通过 `ECHO_NOTES_TEST_VAULT`、
`OBSIDIAN_BINARY_PATH`、`OBSIDIAN_DATA_DIR`、`OBSIDIAN_ASAR_PATH` 覆盖自动发现路径，
通过 `ECHO_NOTES_UI_OUTPUT_DIR` 修改截图输出目录。`npm run package` 在生成发布文件前
会自动执行这套完整验证，因此打包同样需要上述本地 UI 环境。

### 发布验收

隔离真实链路门禁使用专用测试 Vault 中的无隐私素材，运行结束后删除临时 Obsidian Profile。它验证“硅基流动 `FunAudioLLM/SenseVoiceSmall` 转写 → 火山引擎 AgentPlan `doubao-seed-2.0-lite` AI 分析 → AgentPlan Echo Memory 提取”。两把密钥只通过进程环境传入；脚本会把 AgentPlan Key 写入分析与记忆两个独立 `SecretStorage` 条目，不打印任何密钥值。

```bash
read -s "SILICONFLOW_API_KEY?硅基流动 API Key: "
export SILICONFLOW_API_KEY
read -s "AGENTPLAN_API_KEY?AgentPlan API Key: "
export AGENTPLAN_API_KEY
npm run verify:real-chain
unset SILICONFLOW_API_KEY AGENTPLAN_API_KEY
```

## 本地测试安装

1. 使用独立测试 Vault。
2. 将本目录复制或软链接到 `.obsidian/plugins/echo-notes/`；自动 UI 验证必须使用指向工程根目录的软链接。
3. 执行 `npm install` 和 `npm run build`。
4. 在 Obsidian 中启用第三方插件。
5. 启用 Echo Notes。
6. 配置服务商 API Key。
7. 在笔记中插入音频链接并执行 Echo Notes 命令。

## 当前限制

- 火山引擎 AgentPlan 实时转写始终提供说话人分离和时间范围，MOSI 离线转写可选择开启；这些标签只能标记说话人编号，不能识别真实姓名。
- 实时转写仅支持 Obsidian 桌面端和本地文件系统 Vault。
- 首版实时录音只有开始和停止，没有暂停/恢复；异常退出最多可能丢失尚未产生的最后一个短 WebM 分片。
- 百炼新异步模型会解析句子与逐词时间戳；其他不提供该字段的 Provider 仍不输出逐词时间戳。
- 暂不支持所有 Provider 通用的大文件自动切片；共享 AudioChunkPipeline 已覆盖阿里百炼 `qwen3-asr-flash`、硅基流动官方或自定义模型与 MOSI。
- 不支持本地 Whisper。
- 长文本分析采用“逐块提取 + 最终汇总”，会增加模型调用次数和成本。失败或重启后可复用严格匹配的已完成分块，但最终汇总仍会重新调用；未分块的单次分析也会完整重试。
- 任务中心会持久化最多 100 条安全任务摘要。百炼异步任务在 `PENDING` 时可取消云端任务，在 `RUNNING` 时只能停止本地等待并保留继续跟踪入口；普通同步 Provider 仍不是后台队列，也不会获得云端暂停能力。
- Echo Memory 关系必须由用户明确确认，不会自动检测或裁决冲突；跨记录视图依赖明确的主体规范化，不进行语义实体消歧，暂不包含主题聚合、多审核人身份、PM 等角色包、向量检索和外部 Agent 动作。

## 联系与反馈

如有问题、建议或合作交流，欢迎通过微信联系作者。

- 微信号：`ccanbang`

<img src="./assets/wechat-contact.png" alt="微信号 ccanbang 的添加好友二维码" width="320">
