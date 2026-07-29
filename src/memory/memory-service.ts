import { App, normalizePath, TFile, TFolder } from "obsidian";
import { extractTranscriptAnalyses, extractTranscriptText } from "../analysis/analysis-output";
import { splitAnalysisText } from "../analysis/analysis-chunking";
import { FileService } from "../obsidian/file-service";
import type { EchoNotesSettings, MemoryMode } from "../settings/settings";
import { OpenAICompatibleMemoryProvider } from "./memory-provider";
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
	parseMemoryExtractionResponse,
	renderMemoryCandidate,
	sanitizeMemoryFileName
} from "./memory-output";
import {
	MEMORY_SCHEMA_VERSION,
	type EchoMemoryManifest,
	type MemoryAssertion,
	type MemoryCandidatePackage,
	type MemoryExtractionResult,
	type MemoryPaths,
	type MemoryRunRecord,
	type MemorySubjectType,
	type MemoryUserCategory,
	type MemoryUserProfile
} from "./memory-types";

export interface ExtractMemoryOptions {
	apiKey: string;
	analysisTemplateIds?: readonly string[];
	onProgress?: (stage: string) => void;
	signal?: AbortSignal;
}

interface CandidateAssertionWithOrigin {
	assertion: MemoryAssertion;
	candidateId: string;
	candidatePath: string;
}

interface ProfileCompilation {
	path: string;
	title: string;
	assertions: CandidateAssertionWithOrigin[];
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
		const fingerprint = createStableFingerprint(JSON.stringify({
			schemaVersion: MEMORY_SCHEMA_VERSION,
			promptVersion: 1,
			copyLanguage: settings.copyLanguage,
			provider: settings.memoryProvider,
			model: settings.memoryModel,
			user: manifest.user,
			transcriptPath: transcriptFile.path,
			analysisTemplateIds: analyses.map((analysis) => analysis.templateId),
			sourceText
		}));
		const existingRun = manifest.runs[fingerprint];
		if (existingRun && this.isFile(existingRun.candidatePath)) {
			throwIfMemoryTaskAborted(options.signal);
			const existingCandidateFile = this.app.vault.getAbstractFileByPath(existingRun.candidatePath) as TFile;
			const existingCandidate = parseMemoryCandidate(await this.app.vault.cachedRead(existingCandidateFile));
			if (!this.isFile(existingRun.meetingPath)) {
				options.onProgress?.("候选包已存在，正在修复会议页");
				await this.writeMeetingPage(existingRun.meetingPath, existingRun.candidatePath, existingCandidate);
			}
			if (settings.memoryMode === "compile-profiles" && !existingRun.compiledAt) {
				options.onProgress?.("候选包已存在，正在继续编译画像");
				await this.compileProfiles(settings, manifest, options.signal);
				existingRun.compiledAt = new Date().toISOString();
				throwIfMemoryTaskAborted(options.signal);
				await this.writeManifest(manifest);
			}
			return this.createSkippedResult(existingRun, settings.memoryMode, existingCandidate.assertions.length);
		}

		const chunks = settings.memoryLongTextEnabled
			? splitAnalysisText(sourceText, {
					maxCharacters: settings.memoryChunkCharacters,
					overlapCharacters: 400
				})
			: [{ index: 1, total: 1, start: 0, end: sourceText.length, text: sourceText }];
		if (!settings.memoryLongTextEnabled && sourceText.length > settings.memoryChunkCharacters) {
			throw new Error("记忆输入超过单次调用安全长度，且长文本分块已关闭。");
		}
		if (chunks.length > 20) {
			throw new Error(`记忆输入将产生 ${chunks.length} 个分块，超过安全上限 20。`);
		}

		const provider = new OpenAICompatibleMemoryProvider({
			provider: settings.memoryProvider,
			baseUrl: settings.memoryBaseUrl,
			model: settings.memoryModel,
			apiKey: options.apiKey
		});
		const createdAt = new Date().toISOString();
		const assertionMap = new Map<string, MemoryAssertion>();
		const traceIds: string[] = [];
		for (const chunk of chunks) {
			throwIfMemoryTaskAborted(options.signal);
			options.onProgress?.(`正在提取记忆分块 ${chunk.index}/${chunk.total}`);
			const result = await provider.extract({
				transcriptTitle: transcriptFile.basename,
				transcriptPath: transcriptFile.path,
				userDisplayName: manifest.user.displayName,
				text: chunk.text,
				chunkIndex: chunk.index,
				totalChunks: chunk.total,
				copyLanguage: settings.copyLanguage
			}, options.signal);
			throwIfMemoryTaskAborted(options.signal);
			if (result.traceId && !traceIds.includes(result.traceId)) {
				traceIds.push(result.traceId);
			}
			const parsed = parseMemoryExtractionResponse(result.text, chunk.text);
			for (const raw of parsed.assertions) {
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
		const meetingPath = normalizePath(
			`${manifest.paths.meetingsDir}/${safeTitle} ${createStableFingerprint(transcriptFile.path).slice(0, 8)}.md`
		);
		throwIfMemoryTaskAborted(options.signal);
		options.onProgress?.("正在写入会议页与记忆候选包");
		await this.writeCandidate(candidatePath, candidate);
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
		await this.writeMeetingPage(meetingPath, candidatePath, candidate);

		let compiled = false;
		if (settings.memoryMode === "compile-profiles") {
			options.onProgress?.("正在从候选包编译画像");
			await this.compileProfiles(settings, manifest, options.signal);
			compiled = true;
			run.compiledAt = new Date().toISOString();
			throwIfMemoryTaskAborted(options.signal);
			await this.writeManifest(manifest);
		}
		await this.appendLog(manifest, `${compiled ? "提取并编译" : "提取"} ${transcriptFile.path}，候选 ${candidate.assertions.length} 条。`);

		return {
			skipped: false,
			candidateFilePath: candidatePath,
			meetingFilePath: meetingPath,
			assertionCount: candidate.assertions.length,
			compiled,
			provider: settings.memoryProvider,
			model: settings.memoryModel,
			traceIds
		};
	}

	async compileProfiles(
		settings: EchoNotesSettings,
		existingManifest?: EchoMemoryManifest,
		signal?: AbortSignal
	): Promise<number> {
		throwIfMemoryTaskAborted(signal);
		const manifest = existingManifest ?? await this.readManifest(settings);
		const candidateFiles = this.collectFilesWithin(manifest.paths.candidatesDir)
			.filter((file) => file.extension === "md")
			.sort((left, right) => left.path.localeCompare(right.path));
		const packages: Array<{ path: string; candidate: MemoryCandidatePackage }> = [];
		for (const file of candidateFiles) {
			throwIfMemoryTaskAborted(signal);
			packages.push({ path: file.path, candidate: parseMemoryCandidate(await this.app.vault.cachedRead(file)) });
		}

		const compilations = this.createProfileCompilations(manifest, packages, settings.memoryMinimumConfidence);
		for (const compilation of compilations.values()) {
			throwIfMemoryTaskAborted(signal);
			await this.writeCompiledProfile(compilation);
		}
		throwIfMemoryTaskAborted(signal);
		manifest.lastCompiledAt = new Date().toISOString();
		await this.writeManifest(manifest);
		await this.appendLog(manifest, `从 ${packages.length} 个候选包重建 ${compilations.size} 份画像。`);
		return compilations.size;
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
		manifest.runs ??= {};
		manifest.entityIndex ??= {};
		return manifest;
	}

	private async ensureMemoryFolders(paths: MemoryPaths): Promise<void> {
		for (const path of [
			paths.meetingsDir,
			paths.candidatesDir,
			paths.peopleDir,
			paths.organizationsDir,
			paths.projectsDir,
			paths.userDir,
			paths.logsDir
		]) {
			await this.files.ensureFolder(path);
		}
	}

	private createProfileCompilations(
		manifest: EchoMemoryManifest,
		packages: Array<{ path: string; candidate: MemoryCandidatePackage }>,
		minimumConfidence: number
	): Map<string, ProfileCompilation> {
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

		for (const item of packages) {
			for (const assertion of item.candidate.assertions) {
				if (assertion.confidence < minimumConfidence) {
					continue;
				}
				const origin = { assertion, candidateId: item.candidate.id, candidatePath: item.path };
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
		}
		return compilations;
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

	private async writeCandidate(path: string, candidate: MemoryCandidatePackage): Promise<void> {
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
		await this.app.vault.create(path, renderMemoryCandidate(candidate));
	}

	private async writeMeetingPage(
		path: string,
		candidatePath: string,
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

	private isFile(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
	}

	private createSkippedResult(run: MemoryRunRecord, mode: MemoryMode, assertionCount: number): MemoryExtractionResult {
		return {
			skipped: true,
			candidateFilePath: run.candidatePath,
			meetingFilePath: run.meetingPath,
			assertionCount,
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
		? sorted.flatMap(({ assertion, candidateId, candidatePath }) => [
			`- **${escapeMarkdownInline(assertion.predicate)}**：${escapeMarkdownInline(assertion.value)}`,
			`  - 主体：${escapeMarkdownInline(assertion.subjectName)} · 置信度：${assertion.confidence.toFixed(2)} · 观察时间：${assertion.observedAt}`,
			`  - 证据：“${escapeMarkdownInline(assertion.evidenceQuote)}”`,
			`  - 来源：[[${assertion.sourcePath}]] · [[${candidatePath}|${candidateId}]]`
		])
		: ["_暂无达到编译阈值的候选记忆。_"];
	return [
		MEMORY_MANAGED_START,
		"## Echo Memory 自动汇总",
		"",
		...lines,
		MEMORY_MANAGED_END
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

function isUserProfileCategory(value: string): value is MemoryUserCategory {
	return Object.prototype.hasOwnProperty.call(MEMORY_USER_PROFILE_TITLES, value);
}

function getEntityTitleFromKey(key: string): string {
	return key.slice(key.indexOf(":") + 1) || "未命名实体";
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
