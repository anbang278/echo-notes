# 录音存储契约

## 1. 适用范围

Echo Notes 实时录音与 Obsidian 核心录音机的保存路径。录音是原始真源；设置只影响新录音，不能为实现目录配置搬移历史录音或修改全局附件配置。

## 2. 接口

- `RecordingStorageSettings = { strategy, subfolder, customFolder }`，由 settings.ts 定义和归一化。
- `validateRecordingStorage(settings): string | null`：返回用户可见错误或 null。
- `resolveRecordingFolder(settings, sourcePath): string | null`：空字符串表示根目录，null 表示交给 Obsidian 附件规则。
- `RecordingStorageService.create(request, create)`：串行执行路径选择和实际创建，回调返回创建结果；`createBinary` 是完整音频保存入口。
- `CoreRecordingStorageAdapter.refresh()/dispose()`：绑定、重绑定及恢复核心实例保存方法。

## 3. 数据与生命周期

- strategy 为 `obsidian | same-folder | note-subfolder | custom-folder`，缺失或未知默认 obsidian；两目录默认 Recordings。显式非法路径不能静默替换成默认目录。
- 有计时会话的核心录音捕获停止时的 Markdown 笔记（缺少会话的直接保存仍捕获保存入口时笔记）；活动文件不是 Markdown 时按无来源笔记处理，相对目录以库根为基准。
- 实时录音在申请麦克风前校验并冻结配置与来源笔记。文件创建前登记实时路径，避免 create 事件触发离线自动转写。
- 实时启动的异步边界须检查卸载状态；等待麦克风授权期间卸载后，迟到的流必须停止音轨，不能继续创建文件、连接 Provider 或启动计时器。实时音频的创建事件与笔记链接扫描均不得触发重复离线转写。
- 仅在启用的核心实例包装 saveRecording、onStartRecording、startRecording 和 onStopRecording，保留三个原生入口。外部重启核心插件后重绑定，卸载只撤销当前仍由自身持有的包装。
- 链接写入前重新确认视图仍显示捕获的笔记；已切换时用 Vault.process 追加到原笔记，不能写入另一篇笔记。

## 场景：实时分片通过 Vault API 持久化

### 1. 范围 / 触发条件

实时桌面本地 Vault 录音使用 `MediaRecorder` 的 WebM 分片。运行时禁止为此直接访问 Node.js `fs`；从 Obsidian 1.12.3 起使用受控 `TFile` 的 Vault API。

### 2. 签名

- `VaultRecordingSink.create(app: App, path: string): Promise<VaultRecordingSink>`。
- `VaultRecordingSink.append(blob: Blob): void`。
- `VaultRecordingSink.finish(): Promise<number>`。
- 写入调用固定为 `app.vault.appendBinary(file, data)`，其中 `data` 是精确覆盖本分片的 `ArrayBuffer`。

### 3. 契约

- `manifest.json` 的 `minAppVersion` 必须不低于 `appendBinary()` 可用的 1.12.3。
- 创建时先确认桌面本地 `FileSystemAdapter` 与 `appendBinary` 能力，再创建空文件；`append()` 保持非阻塞，串行队列负责顺序落盘。
- `finish()` 等待所有已入队分片，并返回累计已成功写入的字节数；停止时刷新 `TFile.stat`。
- 实时路径仍在创建前登记，自动转写排除与路径冻结语义不变。

### 4. 校验与错误矩阵

| 条件 | 处理 |
| --- | --- |
| 非桌面或非本地 Vault | 拒绝启动，不申请麦克风 |
| `appendBinary` 缺失 | 提示升级到 Obsidian 1.12.3 或更高版本，不创建文件、不启用回退 |
| 空分片 | 不写入、不增加字节数 |
| 首次或后续分片写入失败 | 保留已落盘文件；阻止已排队的后续写入；`finish()` 返回原始错误 |
| 停止前已有入队分片 | 等待队列完成后再结束录音 |

### 5. 正常、默认与错误示例

- 正常：每秒 WebM 分片按进入顺序调用 `appendBinary(TFile, ArrayBuffer)`，60 秒录音在停止前持续增长。
- 默认：核心录音机和离线音频保存继续走 `RecordingStorageService`，不使用此实时分片 sink。
- 错误：以 `node:fs/promises` 根据完整系统路径追加，或在 `appendBinary` 缺失时静默改用 `fs`。

### 6. 必需测试

- 单元测试覆盖多块顺序、空块、精确字节数、停止等待、首次失败后不写后续块和原始错误对象。
- 隔离 Obsidian 验收使用合成流录制至少 60 秒，断言文件先有首段、之后持续增长、停止后可由 `AudioContext.decodeAudioData()` 解码。
- 同一验收覆盖低版本能力缺失不请求麦克风，路径冻结、ASR 失败仍保留本地录音、自动转写排除与卸载清理。

### 7. 错误与正确方式

- 错误：`await import("node:fs/promises")` 后以绝对路径写入 WebM 分片。
- 正确：创建 `TFile` 后把每个精确字节范围交给 `app.vault.appendBinary(file, data)`；队列在首个错误后停止后续分片。

## 4. 校验与错误矩阵

| 条件 | 处理 |
| --- | --- |
| 绝对路径、URL、父级跳转、空路径段、非法字符、配置目录 | 拒绝并提示；实时不申请麦克风 |
| 固定目录为 `.` | 使用库根目录 |
| 目录不存在 | 复用 FileService.ensureFolder 创建 |
| 目录被文件占用 | 失败；核心允许在未创建音频时回退原生保存 |
| 文件重名或同服务并发保存 | 递增编号，路径选择与创建共用队列 |
| 文件已创建后抛错，或链接插入失败 | 保留已有文件，不能重复回退创建 |
| 核心接口缺失/不可写 | 保留原生保存，明确提示自定义策略未生效 |

## 5. 正常、默认与错误示例

- 正常：笔记 `会议/讨论.md`，note-subfolder + `附件/录音` → `会议/附件/录音/Recording ….webm`。
- 默认：旧配置没有 recordingStorage → 跟随 Obsidian，历史文件和转写输出策略保持原状。
- 错误：`../其他库` 或 `.obsidian/录音` → 校验失败，不能经 normalizePath 吞掉非法片段后继续保存。

## 6. 必需测试

设置迁移、非法路径、四种策略、中文多级路径、根目录与无笔记、同名并发、创建后异常不重复保存、视图切换、核心重启与卸载恢复。隔离宿主测试验证最终文件字节、笔记链接、自动转写路径、实时会话冻结及等待麦克风时卸载；合成流不等于真实麦克风或移动端验收。

## 7. 错误与正确方式

- 错误：临时更改 vault 的附件目录，录音结束再恢复；这会影响同期图片和其他附件。
- 正确：录音专用服务确定并创建最终路径，核心实例适配仅作用于本次录音保存。
- 错误：先保存、触发自动转写，再搬移录音。
- 正确：首次 create 事件所见即最终路径，后续链接与任务都消费该路径。

## 普通录音时间标注

- 实例级会话在原 startRecording 成功且 MediaRecorder.state=recording 后创建，用 Date.now 记录起止墙上时间、performance.now 记录经过时长。授权等待和保存耗时排除，差异超过 5 秒视为时钟异常并跳过标注。
- stop 冻结来源、视图和存放设置，每段保持到保存完成；启动/录制/保存时拒绝重复开始，重复停止幂等。媒体错误清理会话，接口不可写保留存储能力并提示。
- 时间格式为 录音时间：HH:mm–HH:mm（时长），跨日两端加 YYYY-MM-DD。分钟向下取整，不足一分钟为不到1分钟，整小时省略零分钟。
- 有会话的四种策略均通过 RecordingStorageService，自定义目录尚未创建时可按附件规则回退；创建后异常禁止重复保存。
- 时间和音频一次插入，用 replaceRange 在当前光标插入以保护选择正文。保存期间切换则追加原笔记并提示，目标丢失保留音频。直接保存缺少会话时维持原策略，不推测时间。
- 重绑定/卸载只恢复仍属于本适配器的方法并撤销媒体事件。权限未返回时临时保留 startRecording 的取消守卫，迟到流停止音轨，待原启动方法结束后恢复。
- 自动验证覆盖日期/分钟格式、四种策略、三种真实宿主入口、授权延迟/拒绝、连续多段、选择正文、来源切换/删除和卸载迟到权限。

## 分析完成后的录音用途摘要

- 核心适配器在已确定路径、实际createBinary之前登记来源就绪Promise，自动create入口等待时间/音频区块插入后才转写。正常完成、创建/插入失败与卸载都必须结算并清理等待者，不依赖当前活动笔记推测来源。
- 最终分析可附带用途摘要，输入标志默认为关闭，长文本分块不生成，最终汇总生成。摘要与正文独立解析，单行纯文本、Unicode计数15–30，异常不逆转有效分析。
- 技术区按模板保存摘要。同批多模板按输入顺序选首个成功有效摘要，同转写稿新轮次优先，回写前重查轮次、卸载、来源及音频TFile身份。
- 通过TranscriptLinkService同文件队列更新唯一音频上方的录音区块，依次为时间行、纯文本“AI 总结：…”行、音频行，摘要与时间相邻且去掉旧分隔符。新摘要插入独立行，新格式重复分析只替换已认领摘要。旧行内“｜AI 总结：…”及完整旧标记在重新分析该音频时迁移为独立行，相同摘要也须完成格式转换。时间行手写前缀原样保留，旧摘要后的手写后缀跟随摘要保留，沿用LF/CRLF。在对应转写稿保存独立写回快照，先落盘本次及当前已识别旧摘要，重读来源时固定本轮旧边界，成功后收敛为单个新摘要。多候选前缀歧义、重复标签、未知文本或损坏标记安全跳过，支持失败重试。缺少时间、引用歧义或编辑器冲突时跳过，禁止使用旧行号兜底。
- 测试覆盖正常/重复更新、手写保护、多音频、创建竞态、轮次、重试、摘要失败主分析成功和真实隔离Obsidian的Mock分析链。

## 摘要快照兼容与一次补生成

### 1. 适用条件

最终模板分析成功而短摘要缺失、为空、超长或格式不合规时触发。分块提取阶段只提取内容，最终汇总阶段负责摘要。

### 2. 接口

- `parseRecordingSummaryResponse()` 附带可选 `recordingSummaryIssue` 和 `recordingSummaryCharacters`，原因取 `missing | empty | length | format | envelope`。
- `recoverRecordingSummary(provider, input, analysisText, maxCharacters, isCurrent)` 最多调用一次既有 `provider.analyze()`，使用 `includeRecordingSummary=false` 的纯文本摘要请求。
- `AnalysisService.writeAnalysisToTranscript()` 返回已保存的模板技术区快照，`writeRecordingSummaryToTranscript()` 在身份和快照匹配时仅合并该模板摘要字段。

### 3. 数据契约

写回记录的外层是 YAML 引号字符串，内层是 JSON 摘要数组。单引号、双引号和单引号转义均须兼容。历史安全纯文本快照支持 1–150 字，新生成摘要维持 15–30 字。最多保留两个恢复候选，新摘要为首候选。解析、更新均保护非托管内容与 LF/CRLF。

### 4. 校验与错误

完整纪要先保存。补请求复用任务开始时捕获的 Provider、模型、密钥、语言、脱敏和分块上限，以及原 Provider 的剩余 15 分钟预算。失效批次、卸载、转写稿或来源身份变化时停止外发及补写。补请求失败、结果无效或技术区变化只产生独立提示，已保存纪要仍为成功。

### 5. 正常与异常样例

原生属性重写后的单引号快照应正常更新摘要。100–150 字历史快照应安全迁移为短摘要。重复字段、损坏数组或来源引用不唯一时保留现有内容，并显示实际原因。

### 6. 必需回归

单/双引号与转义、原生属性重写、历史快照、双候选恢复、人工内容保护。三个 Provider 的补请求、无效结果只补一次、原预算到期、配置变更快照、错误回显诊断隔离、共享 Promise、迟到结果和长文本汇总均须覆盖。

### 7. 实施约束

YAML scalar 先按 YAML 引号语义解码，随后校验 JSON 数组。补摘要按模板技术区快照局部合并。Provider 的远端错误文本可能包含请求内容，补生成诊断只接收受控生命周期数据和错误码。
