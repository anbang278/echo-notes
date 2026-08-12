import { App, normalizePath, TFile, TFolder } from "obsidian";
import { extractTranscriptAnalyses, extractTranscriptText } from "../analysis/analysis-output";
import { splitAnalysisText, type AnalysisTextChunk } from "../analysis/analysis-chunking";
import { FileService } from "../obsidian/file-service";
import type { DiagnosticSink } from "../diagnostics/diagnostic-types";
import type { EchoNotesSettings, MemoryMode } from "../settings/settings";
import { OpenAICompatibleMemoryProvider } from "./memory-provider";
import { extractMemoryChunkSequence } from "./memory-chunked-service";
import {
	createMemoryAggregationCompilations,
	renderInitialMemoryAggregation,
	renderMemoryAggregationHomeBlock,
	updateMemoryAggregationDocument,
	updateMemoryAggregationHome,
	type MemoryAggregationEntry
} from "./memory-aggregation";
import {
	buildMemoryContextPackagePreview,
	getMemoryContextFilterChoices,
	getMemoryContextPackagePath,
	renderInitialMemoryContextPackage,
	updateMemoryContextPackageDocument,
	type MemoryContextFilterChoices,
	type MemoryContextFilterOptions,
	type MemoryContextPackagePreview
} from "./memory-context";
import {
	MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS,
	assertMemoryExtractionCheckpointCapacity,
	createMemoryExtractionCheckpoint,
	createMemoryExtractionCheckpointIdentity,
	createMemoryExtractionCheckpointStore,
	getMemoryExtractionCheckpointStorePath,
	parseMemoryExtractionCheckpointStore,
	prepareMemoryExtractionCheckpointResult,
	readResumableMemoryExtraction as readResumableMemoryExtractionFromStore,
	removeMemoryExtractionCheckpoint,
	renderMemoryExtractionCheckpointStore,
	upsertMemoryExtractionCheckpoint,
	type MemoryExtractionCheckpoint,
	type MemoryExtractionCheckpointIdentity,
	type MemoryExtractionCheckpointStore
} from "./memory-checkpoint";
import { buildMemoryPaths, MEMORY_USER_PROFILE_TITLES, normalizeMemoryRoot } from "./memory-paths";
import {
	MEMORY_CANDIDATE_DATA_END,
	MEMORY_CANDIDATE_DATA_START,
	MEMORY_MANAGED_END,
	MEMORY_MANAGED_START,
	MEMORY_MEETING_END,
	MEMORY_MEETING_START,
	createStableFingerprint,
	formatMemoryExtractionFailureLog,
	formatMemoryExtractionRetryLog,
	insertOrReplaceManagedBlock,
	normalizeEntityName,
	parseMemoryCandidate,
	parseMemoryExtractionResponseWithDiagnostics,
	renderMemoryCandidate,
	sanitizeMemoryFileName
} from "./memory-output";
import {
	MEMORY_SCHEMA_VERSION,
	MEMORY_EXTRACTION_PROMPT_VERSION,
	type EchoMemoryManifest,
	type MemoryAssertion,
	type MemoryCandidatePackage,
	type MemoryExtractionResult,
	type MemoryPaths,
	type MemoryReviewPackage,
	type MemoryReviewStatus,
	type MemoryReviewUpdate,
	type MemoryRunRecord,
	type MemorySubjectType,
	type MemoryUserCategory,
	type MemoryUserProfile
} from "./memory-types";
import {
	applyMemoryReviewUpdates,
	countMemoryReviewStatuses,
	createMemoryReview,
	getApprovedMemoryAssertions,
	getCandidatePathFromReviewPath,
	getMemoryReviewPath,
	parseMemoryReview,
	reconcileMemoryReview,
	renderMemoryReview,
	updateMemoryReviewDocument
} from "./memory-review";
import {
	MEMORY_RELATION_TYPE_LABELS,
	confirmMemoryRelation as confirmMemoryRelationInStore,
	createMemoryRelationEndpoint,
	createMemoryRelationStore,
	getMemoryRelationEndpointKey,
	getMemoryRelationId,
	getMemoryRelationStorePath,
	matchesMemoryRelationEndpoint,
	parseMemoryRelationStore,
	renderMemoryRelationStore,
	resolveMemoryRelations,
	revokeMemoryRelation as revokeMemoryRelationInStore,
	stripMemoryRelationEvidence,
	type MemoryRelationAnnotation,
	type MemoryRelationEndpoint,
	type MemoryRelationRecord,
	type MemoryRelationStore,
	type MemoryRelationType
} from "./memory-relation";

export interface ExtractMemoryOptions {
	apiKey: string;
	analysisTemplateIds?: readonly string[];
	onProgress?: (stage: string, progress?: MemoryExtractionProgress) => void;
	signal?: AbortSignal;
	diagnostics?: DiagnosticSink;
}

export interface MemoryExtractionProgress {
	currentChunk: number;
	totalChunks: number;
}

interface CandidateAssertionWithOrigin {
	assertion: MemoryAssertion;
	candidateId: string;
	candidatePath: string;
	reviewPath: string;
	endpoint: MemoryRelationEndpoint;
	relationAnnotations: MemoryRelationAnnotation[];
}

interface CandidatePackageWithReview {
	path: string;
	reviewPath: string;
	candidate: MemoryCandidatePackage;
	review: MemoryReviewPackage;
}

type CandidateReviewReadMode = "ensure" | "read-only";

export interface MemoryReviewContext {
	candidatePath: string;
	reviewPath: string;
	candidate: MemoryCandidatePackage;
	review: MemoryReviewPackage;
}

export interface MemoryReviewSaveResult {
	reviewPath: string;
	counts: Record<MemoryReviewStatus, number>;
	compiledProfiles?: number;
}

export interface MemoryRelationContextItem {
	relation: MemoryRelationRecord;
	applicable: boolean;
}

export interface MemoryRelationContext {
	candidatePath: string;
	candidate: MemoryCandidatePackage;
	currentApprovedEndpoints: MemoryRelationEndpoint[];
	approvedEndpoints: MemoryRelationEndpoint[];
	relations: MemoryRelationContextItem[];
}

export interface MemoryRelationSaveResult {
	relationPath: string;
	relation: MemoryRelationRecord;
	compiledProfiles?: number;
}

export interface MemoryContextPackageContext {
	entries: MemoryAggregationEntry[];
	choices: MemoryContextFilterChoices;
	language: "zh" | "en";
}

export interface MemoryContextPackageSaveResult {
	path: string;
	preview: MemoryContextPackagePreview;
}

interface ProfileCompilation {
	path: string;
	title: string;
	assertions: CandidateAssertionWithOrigin[];
}

interface MemoryCompilationPlan {
	profiles: Map<string, ProfileCompilation>;
	aggregationEntries: CandidateAssertionWithOrigin[];
}

export class MemoryService {
	private app: App;
	private files: FileService;

	constructor(app: App) {
		this.app = app;
		this.files = new FileService(app);
	}

	async initialize(settings: EchoNotesSettings, profile: MemoryUserProfile): Promise<TFile> {
		const paths = buildMemoryPaths(settings.memoryRootFolder, settings.copyLanguage);
		const existingManifest = this.app.vault.getAbstractFileByPath(paths.manifest);
		if (existingManifest instanceof TFile) {
			throw new Error("该目录已经包含 Echo Memory 初始化清单，请恢复原配置或选择新的根目录。");
		}
		if (existingManifest) {
			throw new Error(`初始化清单路径已被文件夹占用：${paths.manifest}`);
		}
		await this.ensureMemoryFolders(paths);
		await this.writeIfMissing(paths.home, renderMemoryHome(paths, profile, settings.copyLanguage));
		await this.writeIfMissing(
			paths.soul,
			renderInitialProfile("SOUL", profile, settings.copyLanguage, true)
		);

		for (const [category, path] of Object.entries(paths.userProfiles) as Array<[MemoryUserCategory, string]>) {
			await this.writeIfMissing(
				path,
				renderInitialProfile(MEMORY_USER_PROFILE_TITLES[category][settings.copyLanguage], profile, settings.copyLanguage)
			);
		}
		for (const compilation of createMemoryAggregationCompilations([], paths, {}, settings.copyLanguage)) {
			await this.writeIfMissing(
				compilation.path,
				renderInitialMemoryAggregation(compilation, settings.copyLanguage)
			);
		}

		const now = new Date().toISOString();
		const manifest: EchoMemoryManifest = {
			schemaVersion: MEMORY_SCHEMA_VERSION,
			rootFolder: normalizeMemoryRoot(settings.memoryRootFolder),
			language: settings.copyLanguage,
			initializedAt: now,
			user: profile,
			paths,
			runs: {},
			entityIndex: {}
		};
		await this.app.vault.create(paths.manifest, serializeManifest(manifest));

		const homeFile = this.app.vault.getAbstractFileByPath(paths.home);
		if (!(homeFile instanceof TFile)) {
			throw new Error(`无法创建 Echo Memory 首页：${paths.home}`);
		}
		return homeFile;
	}

	async extractFromTranscript(
		settings: EchoNotesSettings,
		transcriptFile: TFile,
		options: ExtractMemoryOptions
	): Promise<MemoryExtractionResult> {
		throwIfMemoryTaskAborted(options.signal);
		const manifest = await this.readManifest(settings);
		const transcriptContent = await this.app.vault.cachedRead(transcriptFile);
		throwIfMemoryTaskAborted(options.signal);
		const transcriptText = extractTranscriptText(transcriptContent);
		if (!transcriptText.trim()) {
			throw new Error("转写稿正文为空，无法提取记忆。");
		}

		const analyses = extractTranscriptAnalyses(transcriptContent, options.analysisTemplateIds);
		const sourceText = buildMemorySourceText(transcriptText, analyses);
		options.diagnostics?.event("configuration", "memory-configuration", {
			provider: settings.memoryProvider,
			baseUrl: settings.memoryBaseUrl,
			model: settings.memoryModel,
			keyPresent: Boolean(options.apiKey.trim()),
			inputCharacters: sourceText.length,
			longTextEnabled: settings.memoryLongTextEnabled,
			analysisCount: analyses.length
		});
		const fingerprint = createStableFingerprint(JSON.stringify({
			schemaVersion: MEMORY_SCHEMA_VERSION,
			promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
			copyLanguage: settings.copyLanguage,
			provider: settings.memoryProvider,
			model: settings.memoryModel,
			user: manifest.user,
			transcriptPath: transcriptFile.path,
			analysisTemplateIds: analyses.map((analysis) => analysis.templateId),
			sourceText
		}));
		const existingRun = manifest.runs[fingerprint];
		const existingCandidateFile = existingRun
			? this.app.vault.getAbstractFileByPath(existingRun.candidatePath)
			: null;
		if (existingRun && existingCandidateFile instanceof TFile) {
			options.diagnostics?.event("lifecycle", "memory-existing-candidate-reused");
			throwIfMemoryTaskAborted(options.signal);
			const existingCandidate = parseMemoryCandidate(await this.app.vault.cachedRead(existingCandidateFile));
			const existingReview = await this.ensureMemoryReview(existingRun.candidatePath, existingCandidate);
			options.onProgress?.("候选包已存在，正在同步会议页与审核入口");
			await this.writeMeetingPage(
				existingRun.meetingPath,
				existingRun.candidatePath,
				existingReview.reviewPath,
				existingCandidate
			);
			if (settings.memoryMode === "compile-profiles" && !existingRun.compiledAt) {
				options.onProgress?.("候选包已存在，正在继续编译画像");
				await this.compileProfiles(settings, manifest, options.signal);
				existingRun.compiledAt = new Date().toISOString();
				throwIfMemoryTaskAborted(options.signal);
				await this.writeManifest(manifest);
			}
			await this.clearMemoryExtractionCheckpointAfterSuccess(manifest, transcriptFile.path);
			return this.createSkippedResult(
				existingRun,
				settings.memoryMode,
				existingCandidate.assertions.length,
				existingCandidate.rejectedAssertionCount ?? 0
			);
		}

		const overlapCharacters = 400;
		const chunks = settings.memoryLongTextEnabled
			? splitAnalysisText(sourceText, {
					maxCharacters: settings.memoryChunkCharacters,
					overlapCharacters
				})
			: [{ index: 1, total: 1, start: 0, end: sourceText.length, text: sourceText }];
		if (!settings.memoryLongTextEnabled && sourceText.length > settings.memoryChunkCharacters) {
			throw new Error("记忆输入超过单次调用安全长度，且长文本分块已关闭。");
		}
		if (chunks.length > MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS) {
			throw new Error(
				`记忆输入将产生 ${chunks.length} 个分块，超过安全上限 ${MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS}。`
			);
		}
		const checkpointIdentity = createMemoryExtractionCheckpointIdentity({
			transcriptPath: transcriptFile.path,
			sourceText,
			inputFingerprint: fingerprint,
			analysisTemplateIds: analyses.map((analysis) => analysis.templateId),
			user: manifest.user,
			settings,
			overlapCharacters,
			promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION
		});
		const resumable = chunks.length > 1
			? await this.readResumableMemoryExtraction(manifest, checkpointIdentity, chunks)
			: null;
		if (resumable) {
			options.diagnostics?.event("lifecycle", "memory-checkpoint-restored", {
				completedChunks: resumable.results.length,
				totalChunks: chunks.length
			});
			options.onProgress?.(
				`已恢复 ${resumable.results.length}/${chunks.length} 个记忆提取分块`,
				{ currentChunk: resumable.results.length, totalChunks: chunks.length }
			);
		}

		const provider = new OpenAICompatibleMemoryProvider({
			provider: settings.memoryProvider,
			baseUrl: settings.memoryBaseUrl,
			model: settings.memoryModel,
			apiKey: options.apiKey
		});
		const createdAt = resumable?.createdAt ?? new Date().toISOString();
		options.diagnostics?.event("lifecycle", "memory-chunks-prepared", { totalChunks: chunks.length });
		const chunkResults = await extractMemoryChunkSequence({
			chunks,
			resumeResults: resumable?.results,
			prepareResult: (result, chunk) =>
				prepareMemoryExtractionCheckpointResult(result, chunk.text, checkpointIdentity),
			extractChunk: async (chunk) => {
				options.diagnostics?.event("progress", "memory-chunk-started", { chunkIndex: chunk.index, totalChunks: chunk.total });
				const result = await provider.extract({
					transcriptTitle: transcriptFile.basename,
					transcriptPath: transcriptFile.path,
					userDisplayName: manifest.user.displayName,
					text: chunk.text,
					chunkIndex: chunk.index,
					totalChunks: chunk.total,
					copyLanguage: settings.copyLanguage,
					diagnostics: options.diagnostics
				}, options.signal);
				throwIfMemoryTaskAborted(options.signal);
				const parsed = parseMemoryExtractionResponseWithDiagnostics(result.text, chunk.text);
				const prepared = {
					assertions: parsed.response.assertions,
					provider: result.provider,
					model: result.model,
					rejectedAssertionCount: parsed.rejectedAssertions.length,
					traceId: result.traceId
				};
				options.diagnostics?.event("progress", "memory-chunk-completed", {
					chunkIndex: chunk.index,
					totalChunks: chunk.total,
					traceId: result.traceId,
					rejectedAssertions: prepared.rejectedAssertionCount
				});
				return prepared;
			},
			onChunkStart: (chunk) => {
				throwIfMemoryTaskAborted(options.signal);
				options.onProgress?.(
					`正在提取记忆分块 ${chunk.index}/${chunk.total}`,
					{ currentChunk: chunk.index - 1, totalChunks: chunk.total }
				);
			},
			onChunkComplete: async (chunk, results) => {
				throwIfMemoryTaskAborted(options.signal);
				if (chunks.length > 1) {
					await this.writeMemoryExtractionCheckpoint(
						manifest,
						createMemoryExtractionCheckpoint(checkpointIdentity, chunks, results, createdAt)
					);
				}
				options.onProgress?.(
					chunks.length > 1
						? `已保存记忆提取分块 ${chunk.index}/${chunk.total}${formatRejectedAssertionProgress(results)}`
						: "记忆提取完成，正在生成候选包",
					{ currentChunk: chunk.index, totalChunks: chunk.total }
				);
			}
		});
		const assertionMap = new Map<string, MemoryAssertion>();
		const traceIds: string[] = [];
		const rejectedAssertionCount = chunkResults.reduce(
			(total, result) => total + (result.rejectedAssertionCount ?? 0),
			0
		);
		options.diagnostics?.event("result", "memory-extraction-parsed", {
			chunks: chunkResults.length,
			rejectedAssertions: rejectedAssertionCount
		});
		for (const [index, result] of chunkResults.entries()) {
			const chunk = chunks[index];
			if (result.traceId && !traceIds.includes(result.traceId)) {
				traceIds.push(result.traceId);
			}
			for (const raw of result.assertions) {
				const subjectName = raw.subjectType === "user" ? manifest.user.displayName : raw.subjectName;
				const id = createStableFingerprint([
					fingerprint,
					raw.subjectType,
					normalizeEntityName(subjectName),
					raw.category,
					raw.predicate,
					raw.value,
					raw.evidenceQuote
				].join("\n"));
				assertionMap.set(id, {
					...raw,
					subjectName,
					id,
					observedAt: createdAt,
					sourcePath: transcriptFile.path,
					chunkIndex: chunk.index
				});
			}
		}
		const candidateId = `memory-${fingerprint.slice(0, 16)}`;
		const candidate: MemoryCandidatePackage = {
			schemaVersion: MEMORY_SCHEMA_VERSION,
			id: candidateId,
			fingerprint,
			createdAt,
			provider: settings.memoryProvider,
			model: settings.memoryModel,
			traceIds,
			...(rejectedAssertionCount > 0 ? { rejectedAssertionCount } : {}),
			source: {
				transcriptPath: transcriptFile.path,
				transcriptTitle: transcriptFile.basename,
				analysisTemplateIds: analyses.map((analysis) => analysis.templateId)
			},
			assertions: Array.from(assertionMap.values())
		};

		const date = createdAt.slice(0, 10);
		const safeTitle = sanitizeMemoryFileName(transcriptFile.basename);
		const candidatePath = normalizePath(`${manifest.paths.candidatesDir}/${date} ${safeTitle} ${fingerprint.slice(0, 8)}.md`);
		const reviewPath = getMemoryReviewPath(candidatePath);
		const meetingPath = normalizePath(
			`${manifest.paths.meetingsDir}/${safeTitle} ${createStableFingerprint(transcriptFile.path).slice(0, 8)}.md`
		);
		throwIfMemoryTaskAborted(options.signal);
		options.onProgress?.("正在写入会议页与记忆候选包");
		await this.writeCandidate(candidatePath, reviewPath, candidate);
		await this.ensureMemoryReview(candidatePath, candidate);
		throwIfMemoryTaskAborted(options.signal);
		const run: MemoryRunRecord = {
			fingerprint,
			transcriptPath: transcriptFile.path,
			candidatePath,
			meetingPath,
			provider: settings.memoryProvider,
			model: settings.memoryModel,
			createdAt
		};
		manifest.runs[fingerprint] = run;
		await this.writeManifest(manifest);
		throwIfMemoryTaskAborted(options.signal);
		await this.writeMeetingPage(meetingPath, candidatePath, reviewPath, candidate);

		let compiled = false;
		if (settings.memoryMode === "compile-profiles") {
			options.onProgress?.("正在从候选包编译画像");
			await this.compileProfiles(settings, manifest, options.signal);
			compiled = true;
			run.compiledAt = new Date().toISOString();
			throwIfMemoryTaskAborted(options.signal);
			await this.writeManifest(manifest);
		}
		await this.appendLog(
			manifest,
			`${compiled ? "提取并编译" : "提取"} ${transcriptFile.path}，候选 ${candidate.assertions.length} 条${formatRejectedAssertionSummary(rejectedAssertionCount)}。`
		);
		await this.clearMemoryExtractionCheckpointAfterSuccess(manifest, transcriptFile.path, checkpointIdentity);

		return {
			skipped: false,
			candidateFilePath: candidatePath,
			meetingFilePath: meetingPath,
			assertionCount: candidate.assertions.length,
			rejectedAssertionCount,
			compiled,
			provider: settings.memoryProvider,
			model: settings.memoryModel,
			traceIds
		};
	}

	async compileProfiles(
		settings: EchoNotesSettings,
		existingManifest?: EchoMemoryManifest,
		signal?: AbortSignal,
		reviewMode: CandidateReviewReadMode = "ensure"
	): Promise<number> {
		throwIfMemoryTaskAborted(signal);
		const manifest = existingManifest ?? await this.readManifest(settings);
		const relationStore = await this.readMemoryRelationStore(manifest);
		const packages = await this.collectCandidatePackages(manifest, signal, reviewMode);
		const plan = this.createMemoryCompilationPlan(manifest, packages, relationStore);
		for (const compilation of plan.profiles.values()) {
			throwIfMemoryTaskAborted(signal);
			await this.writeCompiledProfile(compilation);
		}
		throwIfMemoryTaskAborted(signal);
		await this.writeMemoryAggregations(manifest, plan.aggregationEntries, signal);
		throwIfMemoryTaskAborted(signal);
		manifest.lastCompiledAt = new Date().toISOString();
		await this.writeManifest(manifest);
		await this.appendLog(
			manifest,
			`从 ${packages.length} 个候选包重建 ${plan.profiles.size} 份画像和 3 份跨记录聚合视图。`
		);
		return plan.profiles.size;
	}

	async getReviewContext(settings: EchoNotesSettings, currentFile: TFile): Promise<MemoryReviewContext> {
		const manifest = await this.readManifest(settings);
		const candidatePath = currentFile.path.toLocaleLowerCase().endsWith(".review.md")
			? getCandidatePathFromReviewPath(currentFile.path)
			: currentFile.path;
		this.assertCandidatePath(manifest, candidatePath);
		const candidateFile = this.app.vault.getAbstractFileByPath(candidatePath);
		if (!(candidateFile instanceof TFile)) {
			throw new Error(`记忆候选包不存在：${candidatePath}`);
		}
		const candidate = parseMemoryCandidate(await this.app.vault.cachedRead(candidateFile));
		const { reviewPath, review } = await this.ensureMemoryReview(candidatePath, candidate);
		return { candidatePath, reviewPath, candidate, review };
	}

	async saveMemoryReview(
		settings: EchoNotesSettings,
		candidatePath: string,
		updates: readonly MemoryReviewUpdate[]
	): Promise<MemoryReviewSaveResult> {
		const manifest = await this.readManifest(settings);
		this.assertCandidatePath(manifest, candidatePath);
		const candidateFile = this.app.vault.getAbstractFileByPath(candidatePath);
		if (!(candidateFile instanceof TFile)) {
			throw new Error(`记忆候选包不存在：${candidatePath}`);
		}
		const candidate = parseMemoryCandidate(await this.app.vault.cachedRead(candidateFile));
		const current = await this.ensureMemoryReview(candidatePath, candidate);
		const updated = applyMemoryReviewUpdates(current.review, candidate, updates);
		await this.writeMemoryReview(current.reviewPath, updated, candidate);

		let compiledProfiles: number | undefined;
		if (settings.memoryMode === "compile-profiles") {
			try {
				compiledProfiles = await this.compileProfiles(settings, manifest);
			} catch (error) {
				throw new Error(
						`审核状态已保存，但画像与聚合视图自动重建失败：${getErrorMessage(error)}。请修复后运行“从候选包重建画像与聚合视图”。`,
					{ cause: error }
				);
			}
		}
		const counts = countMemoryReviewStatuses(updated);
		await this.appendLog(
			manifest,
			`审核候选 ${candidatePath}：批准 ${counts.approved} 条，拒绝 ${counts.rejected} 条，待审核 ${counts.pending} 条。`
		);
		return { reviewPath: current.reviewPath, counts, compiledProfiles };
	}

	async getMemoryRelationContext(
		settings: EchoNotesSettings,
		currentFile: TFile
	): Promise<MemoryRelationContext> {
		const manifest = await this.readManifest(settings);
		const candidatePath = currentFile.path.toLocaleLowerCase().endsWith(".review.md")
			? getCandidatePathFromReviewPath(currentFile.path)
			: currentFile.path;
		this.assertCandidatePath(manifest, candidatePath);
		const packages = await this.collectCandidatePackages(manifest, undefined, "read-only");
		const currentPackage = packages.find((item) => item.path === candidatePath);
		if (!currentPackage) {
			throw new Error(`记忆候选包不存在：${candidatePath}`);
		}
		const approvedEndpoints = this.createApprovedRelationEndpoints(packages);
		const relationStore = await this.readMemoryRelationStore(manifest);
		const resolution = resolveMemoryRelations(relationStore, approvedEndpoints);
		const relations = Object.values(relationStore.relations)
			.filter((relation) =>
				relation.source.candidatePath === candidatePath || relation.target.candidatePath === candidatePath
			)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
			.map((relation) => ({
				relation,
				applicable: resolution.applicableRelationIds.has(relation.id)
			}));
		return {
			candidatePath,
			candidate: currentPackage.candidate,
			currentApprovedEndpoints: approvedEndpoints.filter((endpoint) => endpoint.candidatePath === candidatePath),
			approvedEndpoints,
			relations
		};
	}

	async confirmMemoryRelation(
		settings: EchoNotesSettings,
		candidatePath: string,
		type: MemoryRelationType,
		source: MemoryRelationEndpoint,
		target: MemoryRelationEndpoint,
		note: string
	): Promise<MemoryRelationSaveResult> {
		const manifest = await this.readManifest(settings);
		this.assertCandidatePath(manifest, candidatePath);
		if (source.candidatePath !== candidatePath) {
			throw new Error("关系来源必须属于当前候选包。");
		}
		if (source.candidatePath === target.candidatePath) {
			throw new Error("当前关系模型只允许关联不同候选包中的断言。");
		}
		const packages = await this.collectCandidatePackages(manifest, undefined, "read-only");
		const approvedEndpoints = this.createApprovedRelationEndpoints(packages);
		const currentSource = approvedEndpoints.find((endpoint) => matchesMemoryRelationEndpoint(source, endpoint));
		const currentTarget = approvedEndpoints.find((endpoint) => matchesMemoryRelationEndpoint(target, endpoint));
		if (!currentSource || !currentTarget) {
			throw new Error("关系引用的断言已不再批准或生效内容已变化，请重新选择。");
		}
		const relationPath = getMemoryRelationStorePath(manifest.paths.systemDir);
		const relationFile = await this.ensureMemoryRelationStore(relationPath);
		const relationId = getMemoryRelationId(type, currentSource, currentTarget);
		let savedRelation: MemoryRelationRecord | undefined;
		await this.app.vault.process(relationFile, (content) => {
			const store = this.parseMemoryRelationStore(content, relationPath);
			const updated = confirmMemoryRelationInStore(store, type, currentSource, currentTarget, note);
			savedRelation = updated.relations[relationId];
			return updated === store ? content : renderMemoryRelationStore(updated);
		});
		if (!savedRelation) {
			throw new Error("记忆关系已写入，但无法读取保存结果。");
		}
		const compiledProfiles = await this.compileProfilesAfterRelationChange(settings, manifest);
		await this.appendLog(
			manifest,
			`确认记忆关系 ${savedRelation.id}（${MEMORY_RELATION_TYPE_LABELS[savedRelation.type]}）：${savedRelation.source.candidatePath} → ${savedRelation.target.candidatePath}。`
		);
		return { relationPath, relation: savedRelation, compiledProfiles };
	}

	async revokeMemoryRelation(
		settings: EchoNotesSettings,
		candidatePath: string,
		relationId: string,
		note: string
	): Promise<MemoryRelationSaveResult> {
		const manifest = await this.readManifest(settings);
		this.assertCandidatePath(manifest, candidatePath);
		const relationPath = getMemoryRelationStorePath(manifest.paths.systemDir);
		const existing = this.app.vault.getAbstractFileByPath(relationPath);
		if (!(existing instanceof TFile)) {
			throw new Error(`Echo Memory 关系存储不存在：${relationPath}`);
		}
		let savedRelation: MemoryRelationRecord | undefined;
		await this.app.vault.process(existing, (content) => {
			const store = this.parseMemoryRelationStore(content, relationPath);
			const relation = store.relations[relationId];
			if (
				!relation ||
				(relation.source.candidatePath !== candidatePath && relation.target.candidatePath !== candidatePath)
			) {
				throw new Error("当前候选包未引用该记忆关系。");
			}
			const updated = revokeMemoryRelationInStore(store, relationId, note);
			savedRelation = updated.relations[relationId];
			return updated === store ? content : renderMemoryRelationStore(updated);
		});
		if (!savedRelation) {
			throw new Error("记忆关系撤销后无法读取保存结果。");
		}
		const compiledProfiles = await this.compileProfilesAfterRelationChange(settings, manifest);
		await this.appendLog(manifest, `撤销记忆关系 ${savedRelation.id}。`);
		return { relationPath, relation: savedRelation, compiledProfiles };
	}

	async appendExtractionFailureLog(settings: EchoNotesSettings, transcriptPath: string, error: string): Promise<void> {
		const manifest = await this.readManifest(settings);
		await this.appendLog(manifest, formatMemoryExtractionFailureLog(transcriptPath, error));
	}

	async appendExtractionRetryLog(settings: EchoNotesSettings, transcriptPath: string): Promise<void> {
		const manifest = await this.readManifest(settings);
		await this.appendLog(manifest, formatMemoryExtractionRetryLog(transcriptPath));
	}

	async getHomeFile(settings: EchoNotesSettings): Promise<TFile> {
		const manifest = await this.readManifest(settings);
		const file = this.app.vault.getAbstractFileByPath(manifest.paths.home);
		if (!(file instanceof TFile)) {
			throw new Error(`Echo Memory 首页不存在：${manifest.paths.home}`);
		}
		return file;
	}

	async getTimelineFile(settings: EchoNotesSettings): Promise<TFile> {
		const manifest = await this.readManifest(settings);
		const file = this.app.vault.getAbstractFileByPath(manifest.paths.timelineAggregation);
		if (!(file instanceof TFile)) {
			throw new Error(`Echo Memory 时间线不存在：${manifest.paths.timelineAggregation}。请先重建画像与聚合视图。`);
		}
		return file;
	}

	async getMemoryContextPackageContext(
		settings: EchoNotesSettings
	): Promise<MemoryContextPackageContext> {
		const manifest = await this.readManifest(settings);
		const relationStore = await this.readMemoryRelationStore(manifest);
		const packages = await this.collectCandidatePackages(manifest, undefined, "read-only");
		const entries = this.createCurrentMemoryEntries(packages, relationStore);
		return {
			entries,
			choices: getMemoryContextFilterChoices(entries),
			language: manifest.language
		};
	}

	async createMemoryContextPackage(
		settings: EchoNotesSettings,
		options: MemoryContextFilterOptions
	): Promise<MemoryContextPackageSaveResult> {
		const manifest = await this.readManifest(settings);
		const relationStore = await this.readMemoryRelationStore(manifest);
		const packages = await this.collectCandidatePackages(manifest, undefined, "read-only");
		const entries = this.createCurrentMemoryEntries(packages, relationStore);
		const preview = buildMemoryContextPackagePreview(entries, options, manifest.language);
		const path = getMemoryContextPackagePath(manifest.paths, preview, manifest.language);
		await this.files.ensureFolder(manifest.paths.contextPackagesDir);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) {
			throw new Error(`上下文包路径已被文件夹占用：${path}`);
		}
		const content = existing instanceof TFile
			? await this.app.vault.cachedRead(existing)
			: renderInitialMemoryContextPackage(preview, manifest.language);
		const updated = updateMemoryContextPackageDocument(content, preview);
		if (existing instanceof TFile) {
			if (updated !== content) {
				await this.app.vault.modify(existing, updated);
			}
		} else {
			await this.app.vault.create(path, updated);
		}
		await this.appendLog(
			manifest,
			`生成 Personal Agent 上下文包 ${path}：纳入 ${preview.includedCount}/${preview.matchingCount} 条记忆，预算 ${preview.options.maxCharacters} 字符。`
		);
		return { path, preview };
	}

	private async readManifest(settings: EchoNotesSettings): Promise<EchoMemoryManifest> {
		const paths = buildMemoryPaths(settings.memoryRootFolder, settings.memoryPathLanguage);
		const file = this.app.vault.getAbstractFileByPath(paths.manifest);
		if (!(file instanceof TFile)) {
			throw new Error("Echo Memory 尚未初始化，或初始化清单不存在。");
		}
		let manifest: EchoMemoryManifest;
		try {
			manifest = JSON.parse(await this.app.vault.cachedRead(file)) as EchoMemoryManifest;
		} catch (error) {
			throw new Error(`Echo Memory 初始化清单无法读取：${getErrorMessage(error)}`, { cause: error });
		}
		if (manifest.schemaVersion !== MEMORY_SCHEMA_VERSION || !manifest.paths || !manifest.user) {
			throw new Error("Echo Memory 初始化清单版本不受支持或内容不完整。");
		}
		if (normalizeMemoryRoot(manifest.rootFolder) !== normalizeMemoryRoot(settings.memoryRootFolder)) {
			throw new Error("Echo Memory 根目录与初始化清单不一致。");
		}
		manifest.paths = { ...buildMemoryPaths(manifest.rootFolder, manifest.language), ...manifest.paths };
		manifest.runs ??= {};
		manifest.entityIndex ??= {};
		return manifest;
	}

	private async readResumableMemoryExtraction(
		manifest: EchoMemoryManifest,
		identity: MemoryExtractionCheckpointIdentity,
		chunks: readonly AnalysisTextChunk[]
	): Promise<ReturnType<typeof readResumableMemoryExtractionFromStore>> {
		const path = getMemoryExtractionCheckpointStorePath(manifest.paths.systemDir);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			return null;
		}
		if (!(existing instanceof TFile)) {
			throw new Error(`Echo Memory 检查点存储路径已被文件夹占用：${path}`);
		}
		const store = this.parseMemoryExtractionCheckpointStore(await this.app.vault.cachedRead(existing), path);
		assertMemoryExtractionCheckpointCapacity(store, identity.transcriptPath);
		return readResumableMemoryExtractionFromStore(store, identity, chunks);
	}

	private async writeMemoryExtractionCheckpoint(
		manifest: EchoMemoryManifest,
		checkpoint: MemoryExtractionCheckpoint
	): Promise<void> {
		const path = getMemoryExtractionCheckpointStorePath(manifest.paths.systemDir);
		const file = await this.ensureMemoryExtractionCheckpointStore(path);
		await this.app.vault.process(file, (content) => {
			const store = this.parseMemoryExtractionCheckpointStore(content, path);
			return renderMemoryExtractionCheckpointStore(upsertMemoryExtractionCheckpoint(store, checkpoint));
		});
	}

	private async clearMemoryExtractionCheckpointAfterSuccess(
		manifest: EchoMemoryManifest,
		transcriptPath: string,
		expectedIdentity?: MemoryExtractionCheckpointIdentity
	): Promise<void> {
		try {
			const path = getMemoryExtractionCheckpointStorePath(manifest.paths.systemDir);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (!existing) {
				return;
			}
			if (!(existing instanceof TFile)) {
				throw new Error(`Echo Memory 检查点存储路径已被文件夹占用：${path}`);
			}
			await this.app.vault.process(existing, (content) => {
				const store = this.parseMemoryExtractionCheckpointStore(content, path);
				const updated = removeMemoryExtractionCheckpoint(store, transcriptPath, expectedIdentity);
				return updated === store ? content : renderMemoryExtractionCheckpointStore(updated);
			});
		} catch (error) {
			try {
				await this.appendLog(
					manifest,
					`候选包已成功写入，但清理提取检查点失败：${getErrorMessage(error)}`
				);
			} catch {
				// 候选包和清单已经成功写入，日志失败不能逆转完成状态。
			}
		}
	}

	private async ensureMemoryExtractionCheckpointStore(path: string): Promise<TFile> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}
		if (existing) {
			throw new Error(`Echo Memory 检查点存储路径已被文件夹占用：${path}`);
		}
		try {
			return await this.app.vault.create(
				path,
				renderMemoryExtractionCheckpointStore(createMemoryExtractionCheckpointStore())
			);
		} catch (error) {
			const createdByConcurrentTask = this.app.vault.getAbstractFileByPath(path);
			if (createdByConcurrentTask instanceof TFile) {
				return createdByConcurrentTask;
			}
			throw error;
		}
	}

	private parseMemoryExtractionCheckpointStore(
		content: string,
		path: string
	): MemoryExtractionCheckpointStore {
		const store = parseMemoryExtractionCheckpointStore(content);
		if (!store) {
			throw new Error(
				`Echo Memory 检查点存储损坏或版本不受支持：${path}。为避免覆盖恢复数据，已停止提取；请先移走或修复该文件。`
			);
		}
		return store;
	}

	private async collectCandidatePackages(
		manifest: EchoMemoryManifest,
		signal?: AbortSignal,
		reviewMode: CandidateReviewReadMode = "ensure"
	): Promise<CandidatePackageWithReview[]> {
		const candidateFiles = this.collectFilesWithin(manifest.paths.candidatesDir)
			.filter((file) => file.extension === "md" && !file.path.toLocaleLowerCase().endsWith(".review.md"))
			.sort((left, right) => left.path.localeCompare(right.path));
		const packages: CandidatePackageWithReview[] = [];
		for (const file of candidateFiles) {
			throwIfMemoryTaskAborted(signal);
			const candidate = parseMemoryCandidate(await this.app.vault.cachedRead(file));
			const { reviewPath, review } = reviewMode === "ensure"
				? await this.ensureMemoryReview(file.path, candidate)
				: await this.readMemoryReviewWithoutChanges(file.path, candidate);
			packages.push({ path: file.path, reviewPath, candidate, review });
		}
		return packages;
	}

	private async readMemoryReviewWithoutChanges(
		candidatePath: string,
		candidate: MemoryCandidatePackage
	): Promise<{ reviewPath: string; review: MemoryReviewPackage }> {
		const reviewPath = getMemoryReviewPath(candidatePath);
		const existing = this.app.vault.getAbstractFileByPath(reviewPath);
		if (!existing) {
			return { reviewPath, review: createMemoryReview(candidate, candidatePath) };
		}
		if (!(existing instanceof TFile)) {
			throw new Error(`审核文件路径已被文件夹占用：${reviewPath}`);
		}
		return { reviewPath, review: parseMemoryReview(await this.app.vault.cachedRead(existing)) };
	}

	private createApprovedRelationEndpoints(
		packages: readonly CandidatePackageWithReview[]
	): MemoryRelationEndpoint[] {
		return packages.flatMap((item) =>
			getApprovedMemoryAssertions(item.candidate, item.review, item.path).map(({ assertion }) =>
				createMemoryRelationEndpoint({
					candidate: item.candidate,
					candidatePath: item.path,
					reviewPath: item.reviewPath,
					assertion
				})
			)
		);
	}

	private async readMemoryRelationStore(manifest: EchoMemoryManifest): Promise<MemoryRelationStore> {
		const path = getMemoryRelationStorePath(manifest.paths.systemDir);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			return createMemoryRelationStore();
		}
		if (!(existing instanceof TFile)) {
			throw new Error(`Echo Memory 关系存储路径已被文件夹占用：${path}`);
		}
		const store = this.parseMemoryRelationStore(await this.app.vault.read(existing), path);
		if (stripMemoryRelationEvidence(store) === store) {
			return store;
		}

		// 旧版关系文件可能把原文证据重复写入每个端点和历史事件。以 process
		// 的当前内容为准清理，避免读取期间的其他关系更新被旧快照覆盖。
		let sanitizedStore = stripMemoryRelationEvidence(store);
		await this.app.vault.process(existing, (content) => {
			const currentStore = this.parseMemoryRelationStore(content, path);
			sanitizedStore = stripMemoryRelationEvidence(currentStore);
			return sanitizedStore === currentStore ? content : renderMemoryRelationStore(sanitizedStore);
		});
		return sanitizedStore;
	}

	private async ensureMemoryRelationStore(path: string): Promise<TFile> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return existing;
		}
		if (existing) {
			throw new Error(`Echo Memory 关系存储路径已被文件夹占用：${path}`);
		}
		try {
			return await this.app.vault.create(path, renderMemoryRelationStore(createMemoryRelationStore()));
		} catch (error) {
			const createdByConcurrentTask = this.app.vault.getAbstractFileByPath(path);
			if (createdByConcurrentTask instanceof TFile) {
				return createdByConcurrentTask;
			}
			throw error;
		}
	}

	private parseMemoryRelationStore(content: string, path: string): MemoryRelationStore {
		const store = parseMemoryRelationStore(content);
		if (!store) {
			throw new Error(
				`Echo Memory 关系存储损坏或版本不受支持：${path}。为避免错误恢复已被替代的记忆，已停止操作；请先移走或修复该文件。`
			);
		}
		return store;
	}

	private async compileProfilesAfterRelationChange(
		settings: EchoNotesSettings,
		manifest: EchoMemoryManifest
	): Promise<number | undefined> {
		if (settings.memoryMode !== "compile-profiles") {
			return undefined;
		}
		try {
			return await this.compileProfiles(settings, manifest, undefined, "read-only");
		} catch (error) {
			throw new Error(
				`记忆关系已保存，但画像与聚合视图自动重建失败：${getErrorMessage(error)}。请修复后运行“从候选包重建画像与聚合视图”。`,
				{ cause: error }
			);
		}
	}

	private async ensureMemoryFolders(paths: MemoryPaths): Promise<void> {
		for (const path of [
			paths.meetingsDir,
			paths.candidatesDir,
			paths.peopleDir,
			paths.organizationsDir,
			paths.projectsDir,
			paths.userDir,
			paths.aggregationsDir,
			paths.contextPackagesDir,
			paths.logsDir
		]) {
			await this.files.ensureFolder(path);
		}
	}

	private createMemoryCompilationPlan(
		manifest: EchoMemoryManifest,
		packages: CandidatePackageWithReview[],
		relationStore: MemoryRelationStore
	): MemoryCompilationPlan {
		const compilations = new Map<string, ProfileCompilation>();
		const ensure = (path: string, title: string): ProfileCompilation => {
			const existing = compilations.get(path);
			if (existing) {
				return existing;
			}
			const created = { path, title, assertions: [] };
			compilations.set(path, created);
			return created;
		};

		ensure(manifest.paths.soul, "SOUL");
		for (const [category, path] of Object.entries(manifest.paths.userProfiles) as Array<[MemoryUserCategory, string]>) {
			ensure(path, MEMORY_USER_PROFILE_TITLES[category][manifest.language]);
		}
		for (const [entityKey, path] of Object.entries(manifest.entityIndex)) {
			ensure(path, getEntityTitleFromKey(entityKey));
		}
		const aggregationEntries = this.createCurrentMemoryEntries(packages, relationStore);

		for (const origin of aggregationEntries) {
			const { assertion } = origin;
			if (assertion.subjectType === "user") {
				ensure(manifest.paths.soul, "SOUL").assertions.push(origin);
				if (isUserProfileCategory(assertion.category)) {
					ensure(
						manifest.paths.userProfiles[assertion.category],
						MEMORY_USER_PROFILE_TITLES[assertion.category][manifest.language]
					).assertions.push(origin);
				}
				continue;
			}

			const entityPath = this.resolveEntityPath(manifest, assertion.subjectType, assertion.subjectName);
			ensure(entityPath, assertion.subjectName).assertions.push(origin);
		}
		return { profiles: compilations, aggregationEntries };
	}

	private createCurrentMemoryEntries(
		packages: readonly CandidatePackageWithReview[],
		relationStore: MemoryRelationStore
	): CandidateAssertionWithOrigin[] {
		const approvedOrigins: CandidateAssertionWithOrigin[] = packages.flatMap((item) =>
			getApprovedMemoryAssertions(item.candidate, item.review, item.path).map(({ assertion }) => ({
				assertion,
				candidateId: item.candidate.id,
				candidatePath: item.path,
				reviewPath: item.reviewPath,
				endpoint: createMemoryRelationEndpoint({
					candidate: item.candidate,
					candidatePath: item.path,
					reviewPath: item.reviewPath,
					assertion
				}),
				relationAnnotations: []
			}))
		);
		const relationResolution = resolveMemoryRelations(
			relationStore,
			approvedOrigins.map((origin) => origin.endpoint)
		);

		const entries: CandidateAssertionWithOrigin[] = [];
		for (const origin of approvedOrigins) {
			const endpointKey = getMemoryRelationEndpointKey(origin.endpoint);
			if (relationResolution.suppressedEndpointKeys.has(endpointKey)) {
				continue;
			}
			origin.relationAnnotations = relationResolution.annotations.get(endpointKey) ?? [];
			entries.push(origin);
		}
		return entries;
	}

	private resolveEntityPath(
		manifest: EchoMemoryManifest,
		type: Exclude<MemorySubjectType, "user">,
		name: string
	): string {
		const normalizedName = normalizeEntityName(name);
		const key = `${type}:${normalizedName}`;
		const indexedPath = manifest.entityIndex[key];
		if (indexedPath) {
			return indexedPath;
		}
		const directory = type === "person"
			? manifest.paths.peopleDir
			: type === "organization"
				? manifest.paths.organizationsDir
				: manifest.paths.projectsDir;
		const safeName = sanitizeMemoryFileName(name);
		const path = normalizePath(`${directory}/${safeName} ${createStableFingerprint(key).slice(0, 6)}.md`);
		manifest.entityIndex[key] = path;
		return path;
	}

	private async writeCompiledProfile(compilation: ProfileCompilation): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(compilation.path);
		const content = existing instanceof TFile
			? await this.app.vault.cachedRead(existing)
			: `# ${compilation.title}\n\n## 人工内容\n\n`;
		if (existing && !(existing instanceof TFile)) {
			throw new Error(`画像路径已被文件夹占用：${compilation.path}`);
		}
		const block = renderProfileManagedBlock(compilation.assertions);
		const updated = insertOrReplaceManagedBlock(content, MEMORY_MANAGED_START, MEMORY_MANAGED_END, block);
		if (existing instanceof TFile) {
			if (updated !== content) {
				await this.app.vault.modify(existing, updated);
			}
		} else {
			await this.app.vault.create(compilation.path, updated);
		}
	}

	private async writeMemoryAggregations(
		manifest: EchoMemoryManifest,
		entries: readonly CandidateAssertionWithOrigin[],
		signal?: AbortSignal
	): Promise<void> {
		await this.files.ensureFolder(manifest.paths.aggregationsDir);
		const compilations = createMemoryAggregationCompilations(
			entries,
			manifest.paths,
			manifest.entityIndex,
			manifest.language
		);
		for (const compilation of compilations) {
			throwIfMemoryTaskAborted(signal);
			const existing = this.app.vault.getAbstractFileByPath(compilation.path);
			if (existing && !(existing instanceof TFile)) {
				throw new Error(`跨记录聚合路径已被文件夹占用：${compilation.path}`);
			}
			const content = existing instanceof TFile
				? await this.app.vault.cachedRead(existing)
				: renderInitialMemoryAggregation(compilation, manifest.language);
			const updated = updateMemoryAggregationDocument(content, compilation.managedBlock);
			if (existing instanceof TFile) {
				if (updated !== content) {
					await this.app.vault.modify(existing, updated);
				}
			} else {
				await this.app.vault.create(compilation.path, updated);
			}
		}

		const home = this.app.vault.getAbstractFileByPath(manifest.paths.home);
		if (!(home instanceof TFile)) {
			throw new Error(`Echo Memory 首页不存在：${manifest.paths.home}`);
		}
		const homeContent = await this.app.vault.cachedRead(home);
		const updatedHome = updateMemoryAggregationHome(homeContent, manifest.paths, manifest.language);
		if (updatedHome !== homeContent) {
			await this.app.vault.modify(home, updatedHome);
		}
	}

	private async writeCandidate(
		path: string,
		reviewPath: string,
		candidate: MemoryCandidatePackage
	): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const parsed = parseMemoryCandidate(await this.app.vault.cachedRead(existing));
			if (parsed.fingerprint !== candidate.fingerprint) {
				throw new Error(`候选包路径冲突：${path}`);
			}
			return;
		}
		if (existing) {
			throw new Error(`候选包路径已被文件夹占用：${path}`);
		}
		await this.app.vault.create(path, renderMemoryCandidate(candidate, reviewPath));
	}

	private async ensureMemoryReview(
		candidatePath: string,
		candidate: MemoryCandidatePackage
	): Promise<{ reviewPath: string; review: MemoryReviewPackage }> {
		const reviewPath = getMemoryReviewPath(candidatePath);
		const existing = this.app.vault.getAbstractFileByPath(reviewPath);
		if (existing && !(existing instanceof TFile)) {
			throw new Error(`审核文件路径已被文件夹占用：${reviewPath}`);
		}
		if (!(existing instanceof TFile)) {
			const review = createMemoryReview(candidate, candidatePath);
			await this.app.vault.create(reviewPath, renderMemoryReview(review, candidate));
			return { reviewPath, review };
		}

		const content = await this.app.vault.cachedRead(existing);
		const parsed = parseMemoryReview(content);
		const reconciled = reconcileMemoryReview(parsed, candidate, candidatePath);
		if (reconciled !== parsed) {
			await this.app.vault.modify(existing, updateMemoryReviewDocument(content, reconciled, candidate));
		}
		return { reviewPath, review: reconciled };
	}

	private async writeMemoryReview(
		reviewPath: string,
		review: MemoryReviewPackage,
		candidate: MemoryCandidatePackage
	): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(reviewPath);
		if (!(existing instanceof TFile)) {
			throw new Error(`审核文件不存在：${reviewPath}`);
		}
		const content = await this.app.vault.cachedRead(existing);
		parseMemoryReview(content);
		const updated = updateMemoryReviewDocument(content, review, candidate);
		if (updated !== content) {
			await this.app.vault.modify(existing, updated);
		}
	}

	private async writeMeetingPage(
		path: string,
		candidatePath: string,
		reviewPath: string,
		candidate: MemoryCandidatePackage
	): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing && !(existing instanceof TFile)) {
			throw new Error(`会议页路径已被文件夹占用：${path}`);
		}
		const content = existing instanceof TFile
			? await this.app.vault.cachedRead(existing)
			: `---\necho_memory_type: meeting\nsource: "[[${candidate.source.transcriptPath}]]"\n---\n\n# ${candidate.source.transcriptTitle}\n\n## 人工补充\n\n`;
		const analysisLines = candidate.source.analysisTemplateIds.length > 0
			? candidate.source.analysisTemplateIds.map((id) => `- ${id}`)
			: ["- 无"];
		const managed = [
			MEMORY_MEETING_START,
			"## Echo Memory 沉淀",
			"",
			`- 来源转写稿：[[${candidate.source.transcriptPath}]]`,
			`- 记忆候选包：[[${candidatePath}]]`,
			`- 候选审核：[[${reviewPath}]]`,
			`- 候选断言：${candidate.assertions.length} 条`,
			`- 提取时间：${candidate.createdAt}`,
			"",
			"### 纳入的纪要模板",
			"",
			...analysisLines,
			MEMORY_MEETING_END
		].join("\n");
		const updated = insertOrReplaceManagedBlock(content, MEMORY_MEETING_START, MEMORY_MEETING_END, managed);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, updated);
		} else {
			await this.app.vault.create(path, updated);
		}
	}

	private collectFilesWithin(folderPath: string): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) {
			return [];
		}
		const files: TFile[] = [];
		const visit = (current: TFolder): void => {
			for (const child of current.children) {
				if (child instanceof TFile) {
					files.push(child);
				} else if (child instanceof TFolder) {
					visit(child);
				}
			}
		};
		visit(folder);
		return files;
	}

	private assertCandidatePath(manifest: EchoMemoryManifest, candidatePath: string): void {
		if (
			!isPathWithin(candidatePath, manifest.paths.candidatesDir) ||
			!candidatePath.toLocaleLowerCase().endsWith(".md") ||
			candidatePath.toLocaleLowerCase().endsWith(".review.md")
		) {
			throw new Error("请在 Echo Memory 候选包或其审核文件中运行此命令。");
		}
	}

	private async writeIfMissing(path: string, content: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			return;
		}
		if (existing) {
			throw new Error(`初始化路径已被文件夹占用：${path}`);
		}
		await this.app.vault.create(path, content);
	}

	private async writeManifest(manifest: EchoMemoryManifest): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(manifest.paths.manifest);
		if (!(file instanceof TFile)) {
			throw new Error(`Echo Memory 初始化清单不存在：${manifest.paths.manifest}`);
		}
		await this.app.vault.modify(file, serializeManifest(manifest));
	}

	private async appendLog(manifest: EchoMemoryManifest, message: string): Promise<void> {
		const now = new Date();
		const date = now.toISOString().slice(0, 10);
		const path = normalizePath(`${manifest.paths.logsDir}/${date}.md`);
		const line = `- ${now.toISOString()} ${message}\n`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.append(existing, line);
		} else if (!existing) {
			await this.app.vault.create(path, `# Echo Memory 运行日志 ${date}\n\n${line}`);
		}
	}

	private createSkippedResult(
		run: MemoryRunRecord,
		mode: MemoryMode,
		assertionCount: number,
		rejectedAssertionCount: number
	): MemoryExtractionResult {
		return {
			skipped: true,
			candidateFilePath: run.candidatePath,
			meetingFilePath: run.meetingPath,
			assertionCount,
			rejectedAssertionCount,
			compiled: mode === "compile-profiles" && Boolean(run.compiledAt),
			provider: run.provider,
			model: run.model,
			traceIds: []
		};
	}
}

function renderMemoryHome(
	paths: MemoryPaths,
	profile: MemoryUserProfile,
	language: "zh" | "en"
): string {
	const title = language === "en" ? "Echo Memory Home" : "Echo Memory 首页";
	return [
		`# ${title}`,
		"",
		`- [[${paths.soul}|SOUL]]`,
		`- [[${paths.meetingsDir}|${language === "en" ? "Meetings" : "会议"}]]`,
		`- [[${paths.candidatesDir}|${language === "en" ? "Memory Candidates" : "记忆候选"}]]`,
		`- [[${paths.peopleDir}|${language === "en" ? "People" : "人物"}]]`,
		`- [[${paths.organizationsDir}|${language === "en" ? "Organizations" : "组织"}]]`,
			`- [[${paths.projectsDir}|${language === "en" ? "Projects" : "项目"}]]`,
			"",
			`当前用户：${profile.displayName} · ${profile.role}`,
			`近期目标：${profile.recentGoal}`,
			"",
			renderMemoryAggregationHomeBlock(paths, language),
			""
		].join("\n");
}

function renderInitialProfile(
	title: string,
	profile: MemoryUserProfile,
	language: "zh" | "en",
	includeIdentity = false
): string {
	const identity = includeIdentity
		? [
			`- ${language === "en" ? "Name" : "称呼"}：${profile.displayName}`,
			`- ${language === "en" ? "Current role" : "当前角色"}：${profile.role}`,
			`- ${language === "en" ? "Recent goal" : "近期目标"}：${profile.recentGoal}`,
			""
		]
		: [];
	return [
		`# ${title}`,
		"",
		...identity,
		language === "en" ? "## Manual Notes" : "## 人工内容",
		"",
		renderProfileManagedBlock([]),
		""
	].join("\n");
}

function renderProfileManagedBlock(assertions: CandidateAssertionWithOrigin[]): string {
	const sorted = [...assertions].sort((left, right) =>
		left.assertion.observedAt.localeCompare(right.assertion.observedAt) ||
		left.assertion.id.localeCompare(right.assertion.id)
	);
	const lines = sorted.length > 0
		? sorted.flatMap(({ assertion, candidateId, candidatePath, reviewPath, relationAnnotations }) => [
			`- **${escapeMarkdownInline(assertion.predicate)}**：${escapeMarkdownInline(assertion.value)}`,
			`  - 主体：${escapeMarkdownInline(assertion.subjectName)} · 置信度：${assertion.confidence.toFixed(2)} · 观察时间：${assertion.observedAt}`,
			`  - 证据：“${escapeMarkdownInline(assertion.evidenceQuote)}”`,
			`  - 来源：[[${assertion.sourcePath}]] · [[${candidatePath}|${candidateId}]] · [[${reviewPath}|审核记录]]`,
			...relationAnnotations.map(renderProfileRelationAnnotation)
		])
		: ["_暂无已批准的候选记忆。_"];
	return [
		MEMORY_MANAGED_START,
		"## Echo Memory 自动汇总",
		"",
		...lines,
		MEMORY_MANAGED_END
	].join("\n");
}

function renderProfileRelationAnnotation(annotation: MemoryRelationAnnotation): string {
	const counterpart = annotation.counterpart;
	const direction = annotation.type === "conflicts"
		? "与另一条已批准记忆存在冲突"
		: annotation.type === "supplements"
			? annotation.role === "source" ? "补充另一条已批准记忆" : "由另一条已批准记忆补充"
			: annotation.type === "supersedes"
				? "替代另一条已批准记忆"
				: "确认另一条已批准记忆作废";
	return [
		`  - 关系：${MEMORY_RELATION_TYPE_LABELS[annotation.type]}（${annotation.relationId}）· ${direction}`,
		`    - 关联：${escapeMarkdownInline(counterpart.predicate)}：${escapeMarkdownInline(counterpart.effectiveValue)} · [[${counterpart.candidatePath}|候选包]] · [[${counterpart.reviewPath}|审核记录]]`
	].join("\n");
}

function buildMemorySourceText(
	transcriptText: string,
	analyses: Array<{ templateId: string; markdown: string }>
): string {
	const sections = ["# 转写正文", "", transcriptText.trim()];
	if (analyses.length > 0) {
		sections.push("", "# 本批次成功纪要");
		for (const analysis of analyses) {
			sections.push("", `## 模板 ${analysis.templateId}`, "", analysis.markdown);
		}
	}
	return sections.join("\n");
}

function formatRejectedAssertionProgress(
	results: readonly { rejectedAssertionCount?: number }[]
): string {
	const count = results.reduce((total, result) => total + (result.rejectedAssertionCount ?? 0), 0);
	return formatRejectedAssertionSummary(count);
}

function formatRejectedAssertionSummary(count: number): string {
	return count > 0 ? `，证据校验拒绝 ${count} 条` : "";
}

function isUserProfileCategory(value: string): value is MemoryUserCategory {
	return Boolean(Object.prototype.hasOwnProperty.call(MEMORY_USER_PROFILE_TITLES, value));
}

function getEntityTitleFromKey(key: string): string {
	return key.slice(key.indexOf(":") + 1) || "未命名实体";
}

function isPathWithin(path: string, folderPath: string): boolean {
	const normalizedFolder = normalizePath(folderPath).replace(/\/$/, "");
	return normalizePath(path).startsWith(`${normalizedFolder}/`);
}

function serializeManifest(manifest: EchoMemoryManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1").trim();
}

function throwIfMemoryTaskAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) {
		return;
	}
	throw signal.reason instanceof Error ? signal.reason : new Error("记忆提取已取消。");
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const MEMORY_CANDIDATE_MARKERS = {
	start: MEMORY_CANDIDATE_DATA_START,
	end: MEMORY_CANDIDATE_DATA_END
};
