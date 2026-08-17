# Echo Memory 数据模型

## 真源层级

1. 原始音频、完整转写稿和人工编辑是真实来源。
2. AI 分析是带模板、Provider、模型和生成时间的派生输入。
3. 候选包保留模型提取时的结构化结果，是不可因审核而改写的审计真源。
4. 同目录 `.review.md` sidecar 记录用户对每条断言的审核状态、修正值和完整事件历史。
5. `99 系统/echo-memory-relations.json` 记录用户对跨候选已批准断言的关系判断与撤销历史。
6. 候选包、审核 sidecar 与关系存储共同构成编译真源；会议页、长期画像、项目/人物/时间线聚合和 Personal Agent 上下文包都是可重建的派生视图。

删除、拒绝或修正候选后，应通过重新编译更新画像，不能直接在画像托管区块中维护另一份事实。

## 候选 Schema

`MemoryCandidatePackage` 现在支持两代 Schema：

- **v1（legacy）**：`schemaVersion: 1`，仅包含主体、分类、关系/属性、值、置信度、证据和观察时间；历史候选无需迁移即可继续读取、审核和编译。
- **v2（新生成）**：`schemaVersion: 2`，在 v1 基础上新增 `memoryType`、`memoryHorizon`、可选 `admissionReason` 与可选 `temporal`。

两种 Schema 都包含：

- `schemaVersion`、候选包稳定 `id`、输入 `fingerprint`、`createdAt`。
- `provider`、`model`、`traceIds`。
- 来源 transcript 路径、标题和纳入的分析模板 ID。
- 断言数组。

每条 `MemoryAssertion` 包含：

- 稳定 `id`、`subjectType`、`subjectName`、`category`。
- `predicate`、`value`、`confidence`。
- 必须能在本次输入中定位的 `evidenceQuote`。
- `observedAt`、`sourcePath`、`chunkIndex`。
- v2 新增：`memoryType`（`fact`、`decision`、`preference`、`belief`、`experience`、`goal`）、`memoryHorizon`（`working`、`long_term`）、可选 `admissionReason`、可选 `temporal.validFrom/validTo`。

支持的主体是 User、人物、组织和项目。画像编译按主体与分类路由，并始终保留候选包和 transcript 回链。v1 断言不猜测类型；编译时把缺少 `memoryHorizon` 的断言按长期处理，只有 `long_term` 断言进入稳定画像，`working` 断言保留在时间线、跨记录视图和上下文包。

## 审核 sidecar Schema v1

候选同目录使用 `<候选文件名>.review.md`，无论候选是 v1 还是 v2，审核包自身保持 Schema v1 不变。审核包包含：

- `candidateId`、`candidateFingerprint` 和 `candidatePath`，用于阻止审核文件错配。
- 每条断言的 `pending`、`approved` 或 `rejected` 状态。
- `effectiveValue` 修正值、审核备注和 `reviewedAt`。
- 从初始待审核开始的完整事件数组；当前状态必须与最后一条事件一致。

新候选创建时同步生成全为 `pending` 的审核 sidecar。旧候选在首次审核或画像重建时以同样规则平滑补建，不会静默批准。只有 `approved` 断言进入画像，且编译使用 `effectiveValue`；拒绝或重置为待审核后，重新编译会从画像中撤销对应内容。

## 已批准记忆关系 Schema v1

关系使用独立的 `echo-memory-relations.json`，不修改候选包或审核 sidecar。每条关系包含：

- 稳定关系 ID、`conflicts`、`supplements`、`supersedes` 或 `invalidates` 类型，以及 `active` 或 `revoked` 状态。
- 来源与目标两端的候选 ID/路径、审核路径、断言 ID、transcript 路径、主体、关系/属性、生效值和观察时间快照。
- 关系备注、创建与更新时间，以及每次确认或撤销时使用的完整两端快照和备注。

只能在同一规范化主体、不同候选的已批准断言之间确认关系；同一对断言同时只能有一个生效关系，替代/作废链不能形成环。冲突与补充保留两端；替代与作废在画像编译时排除目标，并在来源断言下保留关系 ID 与目标候选/审核回链。任一端不再批准或生效值变化时，旧关系保留审计记录但变为不适用，不再压制目标。撤销后重新编译会恢复仍然批准的目标断言。

## 跨记录聚合视图

编译器在 `05 聚合`（英文目录为 `05 Aggregations`）生成固定的项目、人物和时间线 Markdown：

- 项目视图只包含 `project` 主体，按与实体索引一致的规范化名称分组。
- 人物视图只包含 `person` 主体，使用相同分组规则。
- 时间线包含全部当前已批准断言；可解析的观察时间按时间升序，无法解析的值稳定放在“时间待确认”。
- 三类视图都先应用关系解析：替代/作废目标排除，冲突/补充两端保留并显示关系 ID。
- 每条记录保留 transcript、候选包、审核 sidecar 和适用关系的回链；聚合不读取候选目录之外的 Vault 文件。

新增聚合路径是 Manifest v1 的向后兼容字段：旧清单首次读取时从根目录和固定语言推导，后续编译写回，不需要修改候选、审核或关系 Schema。

## Personal Agent 上下文包

上下文包写入 `06 上下文包`（英文目录为 `06 Context Packages`），只读取当前已批准且未被替代或作废的关系感知断言。命令 `Create personal agent context package` 会先打开本地预览 Modal，再由用户选择：

- 项目、人物：两个筛选条件使用 OR 语义；为空表示不限。
- 起止日期：按断言的 `observedAt` 日期闭区间过滤，无法解析日期的断言不会进入有日期范围的包。
- 记忆类型与时效：可多选 `memoryType` 和 `memoryHorizon`；不选表示不限，缺少 `memoryHorizon` 的 v1 断言按长期处理。
- 字符预算：4,000 至 100,000 字符，默认 12,000；按最新观察时间优先稳定排序，超出预算的条目省略并显示数量。

生成过程不联网、不调用外部 Agent。每条纳入的事实保留证据、transcript、候选、审核和关系回链；文件名由日期与事实快照指纹组成，相同日期、过滤条件和事实快照会复用同一路径。上下文正文位于 `echo-memory-context:managed` 区块内，区块外人工内容在重复生成时保留。

## 写入保护

- 候选包同时提供可读 Markdown 表格和 `echo-memory-data` JSON 托管区块。
- 审核 sidecar 只替换 `echo-memory-review:managed` 托管区块，并使用独立数据标记读取 JSON；标记外的人工补充保留。
- 关系存储使用插件拥有的可读 JSON，通过 `vault.process` 合并写入，不修改候选或审核文件；损坏、重复生效或环形关系会阻止画像重建。
- 会议页只替换 `echo-memory-meeting` 托管区块。
- 画像只替换 `echo-memory:managed` 托管区块。
- 跨记录视图只替换 `echo-memory-aggregation:managed` 托管区块，首页导航只替换 `echo-memory-home-aggregation` 区块。
- 标记之外的人工正文不会被自动覆盖。
- 相同输入指纹会复用已有候选包，避免重复模型调用。

## 当前缺口

关系目前完全由用户手动选择，没有自动候选发现、多用户审核人身份或批量关系审核。候选包已通过 v2 覆盖六种记忆类型与 working/long-term 时效，但工作记忆的完整生命周期（Active→Expired→Historical）仍留待后续阶段；项目和人物聚合及上下文包依赖明确主体名，不做语义实体消歧，也尚无主题聚合、语义检索或外部 Agent 执行动作。
