# Echo Notes 迭代记录

## 2026-07-31：首轮完整审计与 Task Center 重启恢复

### 发现的问题

1. Task Center 只存在于内存，重启后运行状态、失败原因和重试入口消失。
2. 长音频逐段写回 transcript，但失败或重启后会重新上传已经成功的分段。
3. Echo Memory 候选无审核状态，画像编译只按置信度过滤。
4. `src/main.ts` 与 `tests/smoke-tests.ts` 体积过大，工作流集成测试不足。

### 选择原因

任务状态持久化是 P0 可靠性基础，也是分段级断点续跑的前置条件。它不改变 transcript 或 Memory 数据格式，不需要外部服务，且可以通过纯本地测试完整验证。

### 本轮改动

- 新增 Task Center v1 持久化快照、严格输入校验、100 条上限和运行时回调剥离。
- 为转写、AI 分析、记忆提取和画像重建记录最小恢复上下文。
- 插件加载时把遗留 `running` 任务改成明确的重启中断失败，并重新绑定重试入口。
- 使用一秒节流写入插件设置，避免高频进度直接触发同频磁盘写入。
- 创建产品方向、架构、Memory 模型和路线图文档。

### 关键文件

- `src/task-center/task-center-store.ts`
- `src/settings/settings.ts`
- `src/main.ts`
- `tests/smoke-tests.ts`
- `docs/`

### 验证

- 修改前与修改后：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 全部通过。
- `npm run verify:settings-ui` 通过：Obsidian 1.12.7，运行时错误 0，24 张深浅主题与多宽度截图无布局溢出。

### 仍存在的风险

- 当前恢复从完整工作流重新开始，不会复用已成功上传的音频分段或已完成的分析分块。
- 恢复上下文引用的文件或模板可能被用户删除；重试会明确提示，但不会自动猜测替代对象。
- Task Center 摘要保存在插件 `data.json`，它是操作状态而非内容真源；transcript 与 Memory 数据仍以 Vault 文件为准。

### 主链路状态

录音与 transcript 数据保护较完整；分析支持长文本但不支持跨重启分块恢复；Memory 已形成单记录候选与画像派生链路，但候选审核尚未闭环。

### 下一项工作

建立 Provider 无关的长音频分段检查点，使用音频指纹、Provider、模型和时间范围验证可复用分段，只重试缺失或失败部分。

### 暂缓项

- 候选审核：价值高，但按优先级应先完成长音频可靠性底座。
- 跨记录聚合和 Personal Agent 接口：依赖已审核 Memory Schema。
- 向量数据库和更多 Provider：当前没有证据表明它们是主链瓶颈。

## 2026-07-31：长音频分段检查点与断点续跑

### 发现的问题

Task Center 恢复了重试入口，但阿里百炼、SiliconFlow 和 MOSI 的长音频重试仍从头上传；自适应缩段后编号变化，不能用 `index` 作为分段身份。

### 选择原因

这是第一轮任务恢复之后最直接的 P0 缺口。解决后可以减少失败重试的等待、流量和潜在重复费用，并继续复用现有 transcript 人工内容保护。

### 完成的改动

- 在未完成 transcript 托管区块内写入可读的 v1 检查点，记录源音频元数据、Provider、模型、无密钥配置指纹和成功分段。
- 重试前严格校验音频、配置、Schema、分段结构和从 0 开始的连续时间范围；任何不匹配都安全失效。
- 固定管线跳过已成功前缀；自适应管线按原二分边界重建已成功叶子，只上传剩余范围。
- SiliconFlow/MOSI 存在有效检查点时直接进入分段管线，避免再次尝试已知失败的整段请求。
- 成功 transcript 不保留检查点；失败与进行中 transcript 保留，人工正文和自定义 frontmatter 不受影响。

### 验证

- `npm run lint`：通过。
- `npm run typecheck`：通过。
- `npm test`：通过，覆盖固定分段复用、自适应缩段恢复、身份变化、损坏/非连续检查点、Obsidian 注释转义和人工内容保护。
- `npm run build`：通过。

### 仍存在的风险

- 整段请求、实时 AgentPlan、Ollama 和 LM Studio 不支持分段检查点，重试会重新发起完整请求。
- 未完成 transcript 会同时保存可读正文与结构化检查点，文件体积会临时增加；成功后检查点自动移除。
- 尚未用真实付费 Provider 故障注入验证跨进程续跑，自动化证据来自公共管线和 transcript 契约测试。

### 下一项工作

建设 Echo Memory 候选审核与 Schema v2：旧候选迁移为待审核，画像默认只消费已批准断言，批准、修正、拒绝都可追溯并可重编译。

## 2026-07-31：Echo Memory 候选审核与可逆重编译

### 发现的问题

高置信度 AI 候选此前可以直接进入长期画像，用户没有在 Obsidian 内批准、修正或拒绝的入口；改变候选状态也无法可靠撤销派生画像内容。

### 选择原因

这是从“可生成候选”走向“可信长期记忆”的关键缺口。继续做跨记录聚合会放大未经确认的错误，因此必须先建立人工决策与可逆重编译边界。

### 完成的改动

- 保持 `MemoryCandidatePackage` v1 不变，为每份候选新增同目录 `.review.md` sidecar。
- 每条断言记录 `pending`、`approved` 或 `rejected`、生效修正值、备注、审核时间和完整事件历史。
- 新旧候选均从待审核开始；旧候选首次审核或重建时平滑补建 sidecar，不会静默批准。
- 新增 `Review current memory candidate` 命令和 Obsidian Modal，支持逐条审核与全部批准/拒绝。
- 画像编译排除审核文件，只消费已批准断言并使用修正值；拒绝或重置后重建会撤销对应托管内容。
- 候选与会议页回链审核文件；审核和画像更新仅替换各自托管区块，保留人工正文。
- 损坏、错配或历史与当前状态不一致的审核数据会明确失败，不会覆盖历史或继续编译。

### 关键文件

- `src/memory/memory-review.ts`
- `src/memory/memory-review-modal.ts`
- `src/memory/memory-service.ts`
- `src/main.ts`
- `styles.css`
- `tests/smoke-tests.ts`

### 验证

- 纯函数测试覆盖默认待审核、批准与修正、拒绝、重置、事件历史、路径映射、Markdown 往返解析、结构符号、损坏数据和人工内容保护。
- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build` 全部通过。
- `npm run verify:settings-ui` 通过：Obsidian 1.12.7，运行时错误 0；原有 24 张设置页截图与新增 4 张审核 Modal 截图无溢出。
- 隔离 Vault 实际验证旧候选迁移、批准、修正、拒绝、自动编译、重置待审核、画像撤销和审核文件人工正文保护。

### 仍存在的风险

- 升级前已经生成的旧画像不会在插件加载时自动改写；首次手动重建或在自动编译模式下保存审核后，才会按批准状态清除旧派生内容。
- 审核是单用户事件历史，尚无审核人身份、多候选冲突、替代和废弃关系。
- `MemoryService` 仍缺少独立的 Vault IO 集成测试，当前由纯函数、构建和隔离 Obsidian UI 共同覆盖。

### 下一项工作

为长文本 AI 分析增加与输入、模板和 Provider 配置绑定的检查点，失败或重启后复用已完成分块，避免重复调用与费用。

## 2026-07-31：长文本 AI 分析检查点与断点续跑

### 发现的问题

长文本分析已经顺序提取分块并最终汇总，但任一后续分块、最终汇总或 Obsidian 会话失败后，重试都会重新调用已成功分块。初版检查点自审还发现：首次汇总可能使用完整分块响应，而恢复后只能使用检查点中截断的 12,000 字符，导致同一输入在两条路径上的汇总材料不一致。

### 选择原因

这是转写可靠性完成后最直接的 P1 缺口。它位于 transcript 到 Echo Memory 的必经链路，重复调用既增加费用，也会因为模型非确定性让重试结果漂移。

### 完成的改动

- 新增分析检查点 Schema v1，每个模板使用独立的 transcript 隐藏 Obsidian 注释区块。
- 检查点身份绑定 transcript 路径和实际发送正文、模板 ID/名称/版本/提示词、Provider、Base URL、模型、语言、脱敏开关、分块参数及请求管线版本。
- 每块成功后立即通过 `vault.process` 合并写入；只复用身份、连续序号、字符边界和文本指纹全部匹配的成功前缀。
- 重试跳过匹配前缀并重新执行最终汇总；最终分析成功写入后按模板清理检查点，清理失败不会把成功任务改写为失败。
- 每块只保留最终汇总实际使用的前 12,000 字符；首次运行与恢复运行共用同一准备函数，不保存 API Key、raw response 或未使用的超长尾部。
- 插入、替换、移除支持 LF/CRLF，并保护无托管区块、frontmatter 与人工空白；多模板并发检查点互不覆盖。
- Task Center 的分析进度明确显示“分块”而非音频“分段”。

### 关键文件

- `src/analysis/analysis-checkpoint.ts`
- `src/analysis/analysis-chunked-service.ts`
- `src/analysis/analysis-service.ts`
- `src/analysis/analysis-output.ts`
- `src/main.ts`
- `src/task-center/task-center-view.ts`
- `tests/smoke-tests.ts`

### 验证

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`：通过。
- 纯函数测试覆盖 JSON 往返、Obsidian 注释转义、敏感 raw 排除、12,000 字符一致性、身份或边界变化失效、损坏/非连续数据失效、多模板隔离、LF/CRLF、无托管 transcript 人工空白保护，以及恢复后只调用剩余分块。
- `npm run verify:settings-ui`：通过；Obsidian 1.12.7，运行时错误 0，18 张标准截图、6 张模板管理截图和 4 张候选审核截图均无布局溢出，代表性桌面与 375px 截图已目视复核。
- 未调用真实付费 Provider；续跑执行流由可注入的分块序列测试验证。

### 仍存在的风险

- 失败任务会在 transcript 内保留敏感派生分块结果；README 已披露存储位置、体积上限和手动删除边界。
- 最终汇总不建立检查点，重试会再次调用一次汇总；这样可以避免把未写入 transcript 的结果误认为最终成功。
- 无法承诺消除 Provider 在检查点持久化失败时的重复调用；若模型已返回但 Vault 写入失败，该块必须重做。
- Echo Memory 自己的长文本提取仍没有分块检查点。

### 主链路状态

长音频转写、AI 分析和 Task Center 均具备跨失败或重启的安全恢复语义；Echo Memory 候选审核与画像撤销已闭环。当前主链唯一明显的重复分块调用缺口移到 Echo Memory 提取阶段。

### 下一项工作

为 Echo Memory 长文本提取增加与 transcript、所选成功分析、Provider、模型、Schema 和分块边界绑定的 Vault 检查点，成功生成候选包后清理，失败或重启后只处理缺失分块。

### 暂缓项

- 已批准记忆冲突与替代关系：依赖 Memory 提取可靠性先收口。
- 工作流协调器拆分：只随具体纵向切片渐进提取，避免单独大搬移。
- 向量检索与更多 Provider：没有证据表明它们优先于主链恢复能力。

## 2026-07-31：Echo Memory 长文本提取检查点与断点续跑

### 发现的问题

Echo Memory 已能顺序提取最多 20 个长文本分块，但后续分块、候选写入或 Obsidian 会话失败后，重试仍会重新调用全部成功分块。部分提取结果不能作为最终候选暴露，同时又需要在 Vault 中安全保留，才能跨失败或重启续跑。

### 选择原因

这是转写和 AI 分析完成断点续跑后，主链最后一处明显的重复分块调用缺口。补齐后可以减少等待、流量和潜在费用，并让“转写 → 分析 → 候选记忆”使用一致的失败恢复语义。

### 完成的改动

- 新增 Echo Memory 提取检查点 Schema v1，使用 `99 系统/echo-memory-checkpoints.json`（英文目录为 `99 System`）作为插件拥有、用户可读的共享 JSON 存储。
- 按 transcript 路径隔离条目，通过 `vault.process` 合并更新；不同 transcript 并发写入或清理不会覆盖其他条目。
- 身份绑定来源正文、候选输入、纳入分析、初始化用户、Schema/Prompt/Pipeline、Provider、Base URL 指纹、模型、语言和分块配置。
- 只复用身份、连续序号、字符边界、文本指纹、Provider、模型和原文证据定位全部匹配的成功前缀；其余情况从第一块安全重做。
- 每块先经过结构与原文证据校验，再持久化最多 24,000 字符的结构化断言；不保存 API Key、认证头、完整请求或 Provider 原始响应。
- 初次运行和恢复运行共用结果准备函数，并沿用检查点首次 `createdAt`，使候选路径、断言 ID、`observedAt` 和 Trace 元数据保持稳定。
- 只有候选包、审核 sidecar、清单记录、会议页、运行日志和可选画像编译完成后才删除当前 transcript 的检查点条目；清理失败只记日志，不把成功候选误报为失败。
- Task Center 的 Memory 进度明确显示“分块”与 `i/N`；恢复后仍由现有显式重试入口继续执行。

### 关键文件

- `src/memory/memory-checkpoint.ts`
- `src/memory/memory-chunked-service.ts`
- `src/memory/memory-service.ts`
- `src/main.ts`
- `src/task-center/task-center-view.ts`
- `tests/smoke-tests.ts`
- `scripts/verify-settings-ui.mjs`

### 验证

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`git diff --check`：通过。
- 纯函数与执行流测试覆盖 JSON 往返、敏感字段排除、24,000 字符上限、输入/配置/边界变化失效、非连续与证据错配失效、不同 transcript 隔离、条件清理、总存储上限、恢复后只调用剩余分块和首次 `createdAt` 保持。
- `npm run verify:settings-ui`：通过；Obsidian 1.12.7，运行时错误 0，18 张标准截图、6 张模板管理截图和 4 张候选审核截图无溢出。
- 隔离 Obsidian 使用本机临时 HTTP Mock 和真实 Vault IO 注入第 2 块 HTTP 500：首轮只保留第 1 块且没有候选；第二轮调用序列为 `1,2,2`，随后生成候选、审核 sidecar、清单记录和会议页，保持首次 `createdAt`，并只清理当前检查点条目。
- 未调用真实付费 Provider，临时 Mock、Obsidian 进程和隔离 Vault 均在 `finally` 中清理。

### 仍存在的风险

- 失败任务会在 Vault 中保留敏感派生断言；README 已披露路径、每块与总存储上限、成功清理和手动归档边界。
- 若 Provider 已返回但检查点写入失败，该块无法证明已安全持久化，重试时仍必须重新调用。
- 检查点只覆盖分块提取；单块输入失败会完整重试。候选包仍必须经过人工审核，不会因成功续跑自动进入画像。
- 尚未使用真实付费 Provider 做跨进程故障注入；自动化证据来自本地 OpenAI-compatible HTTP Mock、真实 Obsidian renderer 和 Vault IO。

### 主链路状态

Task Center、长音频转写、长文本 AI 分析和 Echo Memory 分块提取均具备跨失败或重启的安全恢复语义；候选审核与画像撤销已闭环。当前主要瓶颈由重复调用可靠性转向多份已批准记忆之间的冲突、补充、替代和废弃关系。

### 下一项工作

建立已批准记忆的可解释关系模型：不修改原始候选，不自动裁决冲突，由用户确认新旧断言的冲突、补充、替代或废弃关系，并可撤销后重新编译画像。

### 暂缓项

- 跨记录项目、人物和时间线聚合：先解决已批准事实关系，避免聚合放大互相矛盾的状态。
- 工作流协调器与测试入口拆分：继续随具体纵向切片渐进提取，避免脱离用户价值的大范围搬移。
- 向量检索、更多 Provider 和外部 Agent 动作：当前仍没有证据表明它们优先于可信关系模型。

## 2026-07-31：已批准记忆冲突、补充、替代与作废关系

### 发现的问题

候选审核已经能决定单条断言是否进入画像，但同一主体在多份候选中的已批准断言仍只能并列展示。历史状态、补充信息、互相冲突的口径和已经失效的旧事实没有可审计关系，跨记录聚合会把它们混成无法解释的长期画像。

### 选择原因

这是从单记录审核进入跨记录理解前的必要可信边界。自动按时间或模型判断新旧事实会把推测伪装成用户决定，因此第一版只保存用户明确确认的关系，不自动发现或裁决冲突。

### 完成的改动

- 新增独立的关系真源 `99 系统/echo-memory-relations.json`（英文目录为 `99 System`），不修改候选包或审核 sidecar。
- 关系端点保存候选、审核、transcript、主体、断言、生效值和观察时间快照；确认、重新确认和撤销事件均保存当时的完整两端快照，历史不会因后续审核修正而丢失。
- 只允许同一规范化主体、不同候选中的已批准断言建立 `conflicts`、`supplements`、`supersedes` 或 `invalidates` 关系；同一断言对只能有一个生效关系。
- 替代与作废链禁止成环；损坏、重复生效或环形关系 JSON 会在画像写入前阻止重建，不会猜测修复。
- 任一端失去批准或生效值变化时，已有关系保留为审计历史但自动变为不适用，不再压制任何断言；重新确认会追加新快照。
- 冲突与补充保留两端事实并显示关系 ID 和候选/审核回链；替代与作废从画像事实中排除目标，但在来源事实下保留目标快照与回链；撤销后重建恢复目标。
- 新增“管理当前记忆关系”命令与 Obsidian Modal，可确认、查看生效/不适用状态、填写备注并撤销关系。
- 关系保存成功但画像自动重建失败时，错误会明确说明“记忆关系已保存”，并提示修复后手动重建，避免用户重复确认。
- 自审进一步把关系查看、确认、撤销及其自动画像重建切换为审核数据只读模式：不会补建未审核 sidecar，也不会协调或改写已有审核文件；用户主动审核或手动重建仍保留旧候选平滑迁移能力。
- 关系存储限制为 5,000 条关系、每条 100 个事件和总计 10,000,000 字符；其中不保存 API Key、完整请求或 Provider raw response。

### 关键文件

- `src/memory/memory-relation.ts`
- `src/memory/memory-relation-modal.ts`
- `src/memory/memory-service.ts`
- `src/main.ts`
- `styles.css`
- `tests/smoke-tests.ts`
- `scripts/verify-settings-ui.mjs`
- `docs/MEMORY_MODEL.md`

### 验证

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`git diff --check`：通过。
- 纯函数测试覆盖四种关系、同主体与跨候选约束、单对唯一关系、撤销与重新确认、审核值变化失效、新快照追加、历史快照保留、替代/作废压制、冲突/补充双端保留、环形链拒绝，以及损坏、重复生效和人工构造环形存储拒绝。
- `npm run verify:settings-ui`：通过；Obsidian 1.12.7，运行时错误 0，18 张标准截图、6 张模板管理截图、4 张候选审核截图和 4 张关系 Modal 截图均无布局溢出。
- 隔离 Vault 实际确认替代关系后，旧值不再作为画像事实出现但仍有关系 ID 和审计回链；撤销后旧值恢复，关系历史由 1 条追加为 2 条。
- 隔离 Vault 对关系确认与撤销前后逐字比较候选包和审核 sidecar，内容均未变化；无审核 sidecar 的候选也没有因打开、确认或撤销关系而被补建审核文件。
- 未调用真实付费 Provider；验收使用隔离 Obsidian、临时最小 Vault 和本地 HTTP Mock，进程与临时目录均由验证脚本清理。

### 仍存在的风险

- 关系候选完全依赖用户手动发现，尚无基于明确规则的候选提示；自动发现前需先证明误报率和审核成本可接受。
- 当前是单用户事件历史，没有审核人身份、批量关系审核或协同合并语义。
- 关系 JSON 包含已批准派生记忆的内容快照，应按敏感 Vault 数据管理；用户手工损坏时系统会阻止编译，但不会自动修改或删除该文件。
- 画像仍按主体与分类平铺断言，尚不能解释项目决策、人物关系或状态随多次记录的演变。

### 主链路状态

录音、转写、长文本分析、Memory 提取、候选审核、可逆画像和已批准事实关系已经形成稳定、可恢复、可追溯的单记录到长期记忆闭环。当前最大缺口进入 P3：把多份已批准且关系明确的断言组织为可重建的项目、人物和时间线聚合。

### 下一项工作

实现跨记录项目、人物与时间线聚合的最小纵向切片：只消费已批准且未被替代/作废的断言，保留冲突，不扫描无关 Vault 内容，并为每个聚合节点保留候选、审核、关系和 transcript 回链。

### 暂缓项

- 自动关系候选发现：先用手动关系与跨记录聚合验证真实工作流，再决定是否需要规则或模型辅助。
- Personal Agent 上下文包：依赖聚合筛选口径稳定，当前直接输出会过早固化接口。
- 向量数据库、更多 Provider 和复杂聊天界面：没有证据表明它们优先于可追溯聚合。

## 2026-07-31：关系感知的项目、人物与时间线聚合

### 发现的问题

主体画像已经跨候选汇总已批准断言，但仍按单个主体与分类平铺。用户无法在一个稳定视图中查看同一项目或人物跨多份记录的变化，也无法按观察时间检查全部记忆演进；手工拼接会遗漏审核、关系或原文证据。

### 选择原因

这是单记录 Memory 闭环进入 Personal Agent 上下文之前的 P3 最小切片。现有候选、审核和关系解析已经给出可信输入，无需再调用模型；使用固定 Markdown 视图可以先验证筛选口径，同时保持 Obsidian-native 和 local-first。

### 完成的改动

- 在中文工作区新增 `05 聚合/项目.md`、`人物.md`、`时间线.md`，英文工作区对应 `05 Aggregations/Projects.md`、`People.md`、`Timeline.md`。
- 项目与人物视图按与实体索引一致的 NFKC、空白和大小写规范化主体分组；显示名从稳定排序后的最早记录派生，输入枚举顺序不会改变标题。
- 时间线包含全部当前已批准断言，可解析观察时间按升序排列，无法解析的时间稳定归入“时间待确认”；同时间使用主体、谓词、候选和断言 ID 形成确定顺序。
- 聚合与画像共用同一个审核和关系解析结果：替代/作废目标排除，冲突/补充两端保留并显示关系 ID；撤销审核或关系后同步恢复。
- 每条聚合记录保留 transcript、候选包、审核 sidecar 和适用关系回链；只递归候选目录，不读取 Vault 其他笔记。
- 三份文件只替换 `echo-memory-aggregation:managed` 区块，首页导航只替换 `echo-memory-home-aggregation` 区块，人工内容保持。
- Manifest v1 增加四个向后兼容路径字段；旧清单读取时按固定根目录与语言补齐，并在下一次编译写回，不修改候选、审核或关系 Schema。
- 初始化直接创建空聚合视图；审核保存、关系确认/撤销、记忆提取自动编译和手动重建都会同步更新聚合。
- 新增 `Open Echo Memory timeline` 命令；原重建命令保持稳定 ID，用户可见名称更新为同时重建画像与聚合。

### 关键文件

- `src/memory/memory-aggregation.ts`
- `src/memory/memory-paths.ts`
- `src/memory/memory-types.ts`
- `src/memory/memory-service.ts`
- `src/main.ts`
- `tests/smoke-tests.ts`
- `scripts/verify-settings-ui.mjs`

### 验证

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`git diff --check`：通过。
- 纯函数测试覆盖中英文路径、规范化分组、输入顺序无关的标题、时间稳定排序、无法解析时间、实体画像链接、transcript/候选/审核/关系回链，以及聚合和首页人工内容保护。
- `npm run verify:settings-ui`：通过；Obsidian 1.12.7，运行时错误 0，原有 18 张标准截图、6 张模板管理截图、4 张候选审核截图和 4 张关系 Modal 截图继续通过。
- 隔离 Vault 使用两份不同日期候选，各批准 User、Project 和 Person 断言；确认替代关系后旧 User 目标从画像和时间线撤下，项目与人物历史仍按时间保留；撤销后旧目标同步恢复。
- 隔离 Vault 验证旧 Manifest 删除新增路径后可自动补齐；三份聚合与首页链接真实落盘；时间线命令打开目标文件；项目页人工判断在确认与撤销关系后均逐字保留。
- 候选包和审核 sidecar 在关系操作前后逐字不变；无审核 sidecar 的候选未被补建，候选目录外含“外部噪声断言”的笔记未进入聚合。
- 未调用真实付费 Provider；测试使用隔离 Obsidian、临时最小 Vault 和本地 HTTP Mock。

### 仍存在的风险

- 项目和人物分组只使用明确名称规范化，同名不同实体仍可能被合并；当前没有别名映射或语义消歧。
- 时间线使用候选的单点 `observedAt`，候选 Schema 尚无来源时间范围、任务完成时间或决策生效区间。
- 当前没有组织和主题专用聚合页；组织断言仍会进入全局时间线和既有组织画像。
- 聚合是完整重建而非增量索引；当前候选规模没有性能瓶颈证据，达到可量化阈值前不引入额外索引或向量数据库。

### 主链路状态

Echo Notes 已形成“录音/语音 → 可恢复转写 → 可恢复分析 → 可恢复候选提取 → 人工审核 → 已批准关系 → 可逆画像与跨记录视图”的完整本地闭环。下一阶段可以开始构建默认不联网、可预览且长度受控的 Personal Agent 上下文接口。

### 下一项工作

实现 Personal Agent 上下文包的最小纵向切片：使用明确的项目、人物、起止时间和字符预算过滤当前已批准记忆，在 Vault 中生成可预览 Markdown，保留全部证据回链，不自动发送给任何外部 Agent。

### 暂缓项

- 语义检索与向量数据库：明确过滤器尚未证明不足，引入会扩大隐私与迁移成本。
- 自动关系候选与实体消歧：先观察上下文包使用时的漏检和误合并问题，再决定规则与交互。
- 外部 Agent 执行、日历或笔记写入：上下文包预览与授权边界稳定前不接入。

## 2026-07-31：本地 Personal Agent 上下文包

### 发现的问题

项目、人物和时间线聚合已经能提供可信的跨记录视图，但用户仍需手工复制和裁剪内容，无法在交给 Personal Agent 前确认筛选范围、证据回链和长度预算。直接把整个 Vault 或未审核候选交给 Agent 会扩大隐私和事实风险。

### 选择原因

这是聚合完成后的最小 P4 纵向切片。当前审核、关系解析和聚合已经提供稳定的本地输入，因此先实现明确过滤、生成前预览和 Markdown 输出，不引入网络、语义检索或新的 Provider。

### 完成的改动

- 新增 `src/memory/memory-context.ts`，实现项目/人物 OR 过滤、`observedAt` 日期闭区间、最新优先稳定排序、4,000～100,000 字符预算、超长条目省略和事实快照指纹。
- 新增 `src/memory/memory-context-modal.ts`，在生成前展示筛选控件、匹配/纳入/省略数量、预算使用量和可滚动 Markdown 预览。
- `MemoryService` 复用当前已批准且关系解析后的记忆集合，生成到 `06 上下文包` 或 `06 Context Packages`；同日期同快照复用路径，只替换 `echo-memory-context:managed` 区块并保护人工正文。
- `main.ts` 注册 `Create personal agent context package` 命令；确认生成后打开结果文件并记录本地运行日志，不触发任何外部 Agent 或 HTTP 请求。
- 更新响应式样式、README、架构、Memory 模型和路线图；新增纯函数和隔离 UI 验收覆盖。

### 关键文件

- `src/memory/memory-context.ts`
- `src/memory/memory-context-modal.ts`
- `src/memory/memory-service.ts`
- `src/main.ts`
- `styles.css`
- `tests/smoke-tests.ts`
- `scripts/verify-settings-ui.mjs`

### 验证

- `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、`git diff --check`：通过。
- `npm run verify:settings-ui`：通过；Obsidian 1.12.7，运行时错误 0，标准 18 张、模板 6 张、审核 4 张、关系 4 张、上下文包 4 张截图均生成。
- 隔离 Vault 验证项目/日期筛选、4,000 字符预算、最新优先排序、transcript/候选/审核回链、未审核候选和候选目录外噪声排除；重复生成保留人工正文。
- 生成前后 Memory HTTP Mock 调用计数不变，未调用真实付费 Provider 或外部 Agent。

### 仍存在的风险

- 筛选依赖明确主体名称，不做主题语义召回或实体消歧；当前不支持组织专用筛选。
- 上下文包是本地 Markdown 预览和导出，不会自动把内容发送给外部 Agent；后续授权协议仍需单独设计。
- 预算按字符数而非模型 token 估算，实际 Agent 可接受长度需由使用证据校准。

### 主链路状态

Echo Notes 已形成“录音/语音 → 可恢复转写 → 可恢复分析 → 可恢复候选提取 → 人工审核 → 已批准关系 → 可逆画像与跨记录视图 → 本地可预览上下文包”的闭环。当前输入默认保留在 Vault 内，只有用户明确配置和触发 Provider 时才发生网络请求。

### 下一项工作

收集上下文包的真实筛选与漏检证据，再决定是否需要主题聚合、可解释关系候选提示或轻量本地索引；不直接引入向量数据库或外部 Agent 执行。

## 2026-08-03：Echo Notes 0.4.2 发布验收

### Provider 组合

- 转写：SiliconFlow，模型 `FunAudioLLM/SenseVoiceSmall`。
- AI 分析：Volcengine AgentPlan，模型 `doubao-seed-2.0-lite`。
- Memory：Volcengine AgentPlan，模型 `doubao-seed-2.0-lite`。
- AgentPlan 分析与记忆共用同一专属 Key，但继续写入两个独立的 Obsidian SecretStorage 槽位；真实验收只从环境变量无回显注入。

### 发布修改

- `package.json`、`package-lock.json`、`manifest.json` 与 `versions.json` 统一升级至 `0.4.2`，`minAppVersion` 保持 `1.11.4`。
- 修复并强化真实链路验收脚本，覆盖实际转写路径、Provider、模型、任务状态、Trace ID、候选审核、关系、聚合、上下文包、检查点清理和敏感信息零泄漏。
- 真实链路的双候选关系夹具在隔离 Vault 内复用同一份真实转写内容，消除 ASR 拼写漂移对同一主体判断的干扰；不修改测试 Vault 原件。
- 更新中英文 README 的 Provider 组合、密钥边界和发布验收命令。

### 验证

- `npm ci`、`npm test`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run package`、Release 版本校验、`git diff --check`、生产依赖与全依赖审计：全部通过，依赖漏洞为 0。
- `npm run verify:settings-ui`：通过；共生成 36 张截图，全部语义检查通过，运行时错误与布局溢出均为 0。
- 隔离 Obsidian 1.12.7 真实链路通过：“SiliconFlow 转写 → AgentPlan 分析 → AgentPlan Memory → 候选审核 → 关系 → 聚合 → 上下文包”。
- 转写、分析和两次 Memory 任务均为 `success`，Provider 与模型匹配且均有 Trace ID；候选包与审核 sidecar 各 2 份，关系和上下文包真实落盘。
- 成功流程无遗留分析或 Memory 检查点，转写稿与上下文包未发现环境变量名、认证头或 API Key 痕迹。
- 临时 Vault 与独立 Obsidian Profile 在验收结束后自动清理；未访问生产 Vault。
