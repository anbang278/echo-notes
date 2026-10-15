import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { formatLocalProgress, mergeLocalCheckpoint, parseLocalTask } from "../src/providers/local-task-lifecycle";
import { TaskCenterStore, createTaskCenterState, createTaskId, markInterruptedTasks, normalizeTaskCenterState } from "../src/task-center/task-center-store";
import { normalizeEchoNotesSettings, type EchoNotesSettings } from "../src/settings/settings";
import type { LocalTranscriptionTaskResume, TranscriptionErrorCode, TranscriptionInput, TranscriptionProvider, TranscriptionResult } from "../src/providers/transcription-provider";

const task = (): LocalTranscriptionTaskResume => ({
	protocol: 1, clientRequestId: "request-1", jobId: "job-1", instanceId: "instance-1", origin: "http://127.0.0.1:18081",
	sourcePath: "Fixtures/meeting.wav", sourceSize: 42, sourceMtimeMs: 1000, sourceIdentity: "file-identity",
	model: "mlx-community/Qwen3-ASR-0.6B-8bit", language: "auto", configurationFingerprint: "configuration",
	confirmedOffset: 42, phase: "transcribing"
});
const taskId = createTaskId("transcription", "Fixtures/meeting.wav");

interface TestPlugin {
	settings: EchoNotesSettings;
	taskCenter: TaskCenterStore;
	activeTranscriptionControllers: Map<string, AbortController>;
	processingAudio: Map<string, Promise<unknown>>;
	unloading: boolean;
	loadSettings(): Promise<void>;
	getApiKey(provider: "local-openai-compatible" | "lm-studio"): string;
	onunload(): void;
	performAudioToTranscript(audio: unknown, source: unknown, options: Record<string, unknown>): Promise<{ analysisEligible: boolean } | null>;
	cancelTaskCenterLocalTask(id: string): Promise<boolean>;
	cleanupLocalTranscriptionResult(id: string): Promise<void>;
	resumeLocalTranscriptionTask(id: string): Promise<void>;
	resumeRestoredRemoteTranscriptionTasks(): Promise<void>;
	retryTranscriptionTask(...args: unknown[]): Promise<void>;
	persistPersistentState(): Promise<void>;
	transcriptService: {
		getTranscriptFile(...args: unknown[]): unknown;
		writeTranscribingTranscript(...args: unknown[]): Promise<unknown>;
		writeSuccessTranscript(...args: unknown[]): Promise<unknown>;
	};
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function createFakeClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; run: () => void }>();
	const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };
	return {
		now: () => now,
		setTimeout: (run: () => void, delay = 0) => {
			const id = ++nextId;
			timers.set(id, { at: now + delay, run });
			return id;
		},
		clearTimeout: (id: number) => { timers.delete(id); },
		pendingCount: () => timers.size,
		reset: () => { timers.clear(); now = 0; },
		flush,
		advance: async (milliseconds: number) => {
			const until = now + milliseconds;
			for (;;) {
				const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				now = next[1].at;
				timers.delete(next[0]);
				next[1].run();
				await flush();
			}
			now = until;
			await flush();
		}
	};
}

/** Load the actual plugin methods; replace only Obsidian's host boundary and provider factory. */
function loadPluginHarness() {
	const directory = mkdtempSync(path.join(tmpdir(), "echo-notes-local-lifecycle-"));
	const output = path.join(directory, "plugin.cjs");
	try {
		execFileSync(process.execPath, ["--input-type=module", "-e", `
			import esbuild from 'esbuild';
			await esbuild.build({
				stdin: { contents: 'export { default } from "./src/main"; export { TranscriptionError } from "./src/providers/transcription-provider";', resolveDir: process.cwd(), loader: 'ts' },
				bundle: true, platform: 'node', format: 'cjs',
				outfile: process.argv[1], external: ['obsidian'], logLevel: 'silent',
				plugins: [{ name: 'local-lifecycle-provider-fixture', setup(build) {
					build.onLoad({ filter: /[/\\\\]providers[/\\\\]provider-registry\\.ts$/ }, () => ({
						contents: 'export function createTranscriptionProvider() { return globalThis.__fixtureProvider; }', loader: 'ts'
					}));
				} }]
			});
		`, output], { cwd: process.cwd(), stdio: "pipe" });
		class HostBase {}
		class FileSystemAdapter {}
		class Notice { hide() {} setMessage() {} }
		const host = new Proxy({
			FileSystemAdapter, Notice, Platform: { isMobile: false },
			normalizePath: (value: string) => value.replace(/\\/g, "/"),
			requestUrl: () => { throw new Error("Unexpected network access in local lifecycle test"); }
		}, { get: (target, name) => name in target ? target[name as keyof typeof target] : HostBase });
		const module = { exports: {} as {
			default: { prototype: object };
			TranscriptionError: new (code: TranscriptionErrorCode, message: string) => Error;
		} };
		const realRequire = createRequire(path.join(process.cwd(), "package.json"));
		const clock = createFakeClock();
		class ClockDate extends Date { static now() { return clock.now(); } }
		const sandbox = {
			module, exports: module.exports, require: (name: string) => name === "obsidian" ? host : realRequire(name),
			AbortController, URL, TextEncoder, TextDecoder, DOMException, console,
			setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval, clearInterval, Date: ClockDate, Error, Map, Set,
			window: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval, clearInterval },
			__fixtureProvider: undefined as TranscriptionProvider | undefined
		};
		vm.runInNewContext(readFileSync(output, "utf8"), sandbox, { filename: output });
		return { prototype: module.exports.default.prototype, TranscriptionError: module.exports.TranscriptionError, sandbox, FileSystemAdapter, clock };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export async function runLocalTaskLifecycleTests(): Promise<void> {
	const sample = task();
	assert.deepEqual(parseLocalTask({ ...sample, apiKey: "forbidden-key", audio: "forbidden-audio", raw: {} }), sample);
	for (const override of [
		{ protocol: 2 }, { origin: "https://remote.example" }, { origin: "http://127.0.0.1:9000" },
		{ phase: "unknown" }, { sourceSize: NaN }, { confirmedOffset: 43 }, { sourceSize: 1.5 }, { sourceMtimeMs: -1 },
		{ clientRequestId: "" }, { model: "" }, { configurationFingerprint: "" }
	]) assert.equal(parseLocalTask({ ...sample, ...override }), undefined);
	assert.deepEqual(mergeLocalCheckpoint({ ...sample, cancelRequested: true, phase: "canceling" }, { ...sample, phase: "uploading" }),
		{ ...sample, cancelRequested: true, phase: "canceling" });
	assert.equal(mergeLocalCheckpoint({ ...sample, cancelRequested: true, phase: "canceled" }, sample).phase, "canceled");
	assert.equal(mergeLocalCheckpoint({ ...sample, cancelRequested: true }, { ...sample, clientRequestId: "request-2" }).cancelRequested, undefined);
	assert.equal(formatLocalProgress({ type: "local-asr-progress", phase: "uploading", uploadedBytes: 5, totalBytes: 10 }), "上传音频 50%");
	assert.equal(formatLocalProgress({ type: "local-asr-progress", phase: "waiting" }), "等待服务返回");

	const store = new TaskCenterStore();
	store.upsertTask({ id: taskId, kind: "transcription", title: "meeting", targetPath: sample.sourcePath, status: "running", stage: "转写中", provider: "local-openai-compatible", localTask: sample });
	store.upsertTask({ id: "generic", kind: "transcription", title: "generic", targetPath: "generic.wav", status: "running", stage: "等待服务", provider: "local-openai-compatible" });
	const restored = markInterruptedTasks(normalizeTaskCenterState(createTaskCenterState(store.getTasks())).tasks);
	assert.equal(restored.find(item => item.id === taskId)?.status, "running");
	assert.equal(restored.find(item => item.id === "generic")?.status, "failed");
	assert.match(restored.find(item => item.id === "generic")?.error ?? "", /结果未知|核对服务端/);
	store.updateTask(taskId, { status: "success", localTask: { ...sample, phase: "cleanup-pending" } });
	store.clearFinishedTasks();
	assert.ok(store.getTask(taskId), "Clear finished tasks must retain pending cleanup metadata");
	store.updateTask(taskId, { status: "cancelled", localTask: { ...sample, cancelRequested: true, phase: "canceled" } });
	store.clearFinishedTasks();
	assert.equal(store.getTask(taskId), undefined);

	const harness = loadPluginHarness();
	function fixture(options: { generic?: boolean; writeFailure?: boolean; cleanupFailure?: boolean; cancelConfirmed?: boolean; duringTranscribe?: (input: TranscriptionInput) => Promise<void> } = {}) {
		// Scenarios are independent; never run a prior fixture's timer against the next provider.
		harness.clock.reset();
		const events: string[] = [];
		const snapshots: ReturnType<typeof createTaskCenterState>[] = [];
		const plugin = Object.create(harness.prototype) as TestPlugin;
		const audio = { path: sample.sourcePath, name: "meeting.wav", extension: "wav", stat: { size: 42, mtime: 1000, ctime: 1000 } };
		const transcript = { path: "Fixtures/meeting.transcript.md" };
		Object.assign(plugin, {
			settings: normalizeEchoNotesSettings({
				offlineTranscription: { provider: "local-openai-compatible", baseUrl: `${sample.origin}/v1`, model: sample.model, language: "auto" },
				confirmBeforeTranscription: false, skipExistingTranscript: false
			}),
			taskCenter: new TaskCenterStore(), activeTranscriptionControllers: new Map(), processingAudio: new Map(), unloading: false,
			app: { vault: { adapter: new harness.FileSystemAdapter() } },
			persistentStateTimer: null, gettingStartedNativeSettingsTimer: null, realtimeStatusTimer: null,
			settingsListeners: new Set(), gettingStartedListeners: new Set(), markdownDebounceTimers: new Map(), activeMemoryTasks: new Map(),
			getApiKey: () => "", startDiagnosticSession: () => ({ id: "diagnostic", chainId: "chain" }),
			diagnostics: { getSink: () => undefined, record: () => undefined, complete: () => undefined },
			markGettingStartedRunning: async () => undefined,
			markGettingStartedTranscriptionSuccess: async () => { events.push("getting-started-success"); },
			log: () => undefined,
			persistPersistentState: async () => { events.push("persist"); snapshots.push(createTaskCenterState(plugin.taskCenter.getTasks())); },
			transcriptService: {
				getTranscriptFile: () => undefined, getResumableTranscriptionSegments: async () => [],
				writeTranscribingTranscript: async () => transcript,
				writeSuccessTranscript: async () => {
					events.push("write-success");
					if (options.writeFailure) throw new Error("ENOSPC fixture");
					return transcript;
				}
			}
		});
		const provider: TranscriptionProvider = {
			id: "local-openai-compatible",
			transcribe: async (input) => {
				events.push("transcribe");
				if (!options.generic) await input.onLocalCheckpoint?.(sample);
				await options.duringTranscribe?.(input);
				return { provider: "local-openai-compatible", model: sample.model, text: "Synthetic transcript fixture.",
					...(options.generic ? {} : { localTask: sample }) } as TranscriptionResult;
			},
			cancelLocalTask: async (value) => {
				events.push("cancel-server");
				assert.ok(snapshots.some(snapshot => snapshot.tasks.some(item => item.localTask?.cancelRequested)), "Cancellation intent must be persisted before remote mutation");
				return { confirmed: options.cancelConfirmed !== false, task: { ...value, cancelRequested: true, phase: options.cancelConfirmed === false ? "canceling" : "canceled" } };
			},
			acknowledgeLocalResult: async (value) => {
				events.push("cleanup-server");
				assert.ok(events.includes("write-success"), "Service cleanup must only occur after transcript write");
				assert.equal(plugin.taskCenter.getTask(taskId)?.status, "success");
				if (options.cleanupFailure) throw new Error("Cleanup connection fixture");
				return { confirmed: true, task: value };
			}
		};
		harness.sandbox.__fixtureProvider = provider;
		return { plugin, audio, events, snapshots, provider, run: (resume?: LocalTranscriptionTaskResume) => plugin.performAudioToTranscript(audio, undefined, { resumeLocalTask: resume }) };
	}

	const successful = fixture();
	const outcome = await successful.run();
	assert.equal(outcome?.analysisEligible, true);
	assert.equal(successful.plugin.taskCenter.getTask(taskId)?.status, "success");
	assert.equal(successful.plugin.taskCenter.getTask(taskId)?.localTask, undefined);
	assert.ok(successful.events.indexOf("write-success") < successful.events.indexOf("cleanup-server"));
	const successfulEvents = [...successful.events];
	assert.equal(await successful.plugin.cancelTaskCenterLocalTask(taskId), false, "A stale cancel action after result cleanup must leave success unchanged");
	assert.equal(successful.plugin.taskCenter.getTask(taskId)?.status, "success");
	assert.deepEqual(successful.events, successfulEvents);

	const savedBeforeCrash = fixture({ duringTranscribe: async () => { throw new Error("Service unavailable after transcript save"); } });
	savedBeforeCrash.plugin.transcriptService.getTranscriptFile = () => ({ path: "Fixtures/meeting.transcript.md" });
	savedBeforeCrash.plugin.transcriptService.writeTranscribingTranscript = async () => { throw new Error("Existing completed transcript must never be replaced by empty progress on recovery"); };
	assert.equal(await savedBeforeCrash.run({ ...sample, phase: "saving" }), null);
	assert.equal(savedBeforeCrash.events.includes("transcribe"), true, "Recovery must reach the provider without overwriting the existing transcript");
	assert.equal(savedBeforeCrash.plugin.taskCenter.getTask(taskId)?.localTask?.jobId, sample.jobId);
	for (const code of ["network_error", "local_task_expired"] as const) {
		let document = "Completed transcript saved before the crash.";
		const recovery = fixture({ duringTranscribe: async () => { throw new harness.TranscriptionError(code, "Synthetic recovery failure"); } });
		recovery.plugin.transcriptService.getTranscriptFile = () => ({ path: "Fixtures/meeting.transcript.md" });
		recovery.plugin.transcriptService.writeTranscribingTranscript = async () => {
			document = "Empty transcription progress.";
			return { path: "Fixtures/meeting.transcript.md" };
		};
		assert.equal(await recovery.run({ ...sample, phase: "saving" }), null);
		assert.equal(document, "Completed transcript saved before the crash.", "Recovery failure must preserve the already durable successful transcript");
		assert.equal(recovery.events.includes("write-success"), false);
		assert.equal(recovery.events.includes("cleanup-server"), false);
		assert.equal(recovery.plugin.taskCenter.getTask(taskId)?.status, code === "local_task_expired" ? "failed" : "paused");
	}

	for (const cancelConfirmed of [false, true]) {
		const changed = fixture({ cancelConfirmed, duringTranscribe: async () => {
			throw new harness.TranscriptionError("source_changed", "Synthetic source changed");
		} });
		assert.equal(await changed.run(), null);
		const retained = changed.plugin.taskCenter.getTask(taskId);
		assert.equal(changed.events.includes("cancel-server"), true, "A changed source must cancel the original job rather than orphan its admission slot");
		assert.equal(retained?.localTask?.jobId, sample.jobId, "Keep the job identity until cancellation is confirmed");
		assert.equal(retained?.localTask?.cancelRequested, true);
		assert.equal(retained?.localTask?.phase, cancelConfirmed ? "canceled" : "canceling");
		assert.equal(retained?.status, cancelConfirmed ? "cancelled" : "paused");
		assert.equal(changed.events.includes("write-success"), false);
		assert.equal(changed.events.includes("cleanup-server"), false);
	}
	const changedConfig = fixture({ duringTranscribe: async () => {
		throw new harness.TranscriptionError("local_configuration_changed", "Synthetic configuration changed");
	} });
	assert.equal(await changedConfig.run(sample), null);
	assert.equal(changedConfig.plugin.taskCenter.getTask(taskId)?.status, "paused");
	assert.equal(changedConfig.plugin.taskCenter.getTask(taskId)?.localTask?.jobId, sample.jobId);
	assert.equal(changedConfig.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, undefined);
	assert.equal(changedConfig.events.includes("cancel-server"), false, "A configuration change must retain the job so the original configuration can resume it");

	const failedWrite = fixture({ writeFailure: true });
	assert.equal(await failedWrite.run(), null);
	assert.equal(failedWrite.events.includes("cleanup-server"), false);
	assert.equal(failedWrite.plugin.taskCenter.getTask(taskId)?.status, "paused");
	assert.equal(failedWrite.plugin.taskCenter.getTask(taskId)?.localTask?.phase, "saving");
	assert.equal(await failedWrite.plugin.cancelTaskCenterLocalTask(taskId), true, "A failed disk write must leave the retained service result cancelable");
	assert.equal(failedWrite.plugin.taskCenter.getTask(taskId)?.status, "cancelled");
	assert.equal(failedWrite.events.includes("cancel-server"), true);

	const cancelPersistenceFailure = fixture();
	cancelPersistenceFailure.plugin.taskCenter.upsertTask({ id: taskId, kind: "transcription", title: "meeting", targetPath: sample.sourcePath,
		status: "running", stage: "转写中", provider: "local-openai-compatible", localTask: sample });
	const cancelController = new AbortController();
	cancelPersistenceFailure.plugin.activeTranscriptionControllers.set(taskId, cancelController);
	cancelPersistenceFailure.plugin.persistPersistentState = async () => { throw new Error("Cancellation persistence fixture"); };
	assert.equal(await cancelPersistenceFailure.plugin.cancelTaskCenterLocalTask(taskId), false, "A failed intent write must return a controlled failure");
	assert.equal(cancelPersistenceFailure.events.includes("cancel-server"), false, "Do not cancel server work before the cancellation intent is durable");
	assert.equal(cancelController.signal.aborted, false, "Do not interrupt the active connection before persisting cancellation intent");
	assert.equal(cancelPersistenceFailure.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, true, "Retain intent in memory for a user retry");

	const cleanupFailure = fixture({ cleanupFailure: true });
	assert.equal((await cleanupFailure.run())?.analysisEligible, true);
	assert.equal(cleanupFailure.plugin.taskCenter.getTask(taskId)?.status, "success");
	assert.equal(cleanupFailure.plugin.taskCenter.getTask(taskId)?.localTask?.phase, "cleanup-pending");
	assert.equal(cleanupFailure.plugin.taskCenter.getTask(taskId)?.retry?.label, "重试清理");
	assert.ok(cleanupFailure.snapshots.some(snapshot => snapshot.tasks.some(item => item.status === "success" && item.localTask?.phase === "cleanup-pending")));

	for (const generic of [false, true]) {
		const started = deferred();
		const finish = deferred();
		const cancelRace = fixture({ generic, duringTranscribe: async (input) => {
			started.resolve();
			await finish.promise;
			if (!generic) await input.onLocalCheckpoint?.({ ...sample, phase: "uploading" }); // Late ACK after confirmed cancellation.
		} });
		const operation = cancelRace.run();
		await started.promise;
		assert.equal(await cancelRace.plugin.cancelTaskCenterLocalTask(taskId), true);
		finish.resolve();
		assert.equal(await operation, null);
		assert.equal(cancelRace.events.includes("write-success"), false, "Late results must not write successful transcripts");
		assert.equal(cancelRace.events.includes("getting-started-success"), false);
		assert.equal(cancelRace.events.includes("cleanup-server"), false);
		assert.equal(cancelRace.plugin.taskCenter.getTask(taskId)?.status, generic ? "failed" : "cancelled");
		if (!generic) assert.equal(cancelRace.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, true);
	}

	const unloadStarted = deferred();
	const unloadFinish = deferred();
	const unloaded = fixture({ duringTranscribe: async (input) => {
		unloadStarted.resolve();
		await unloadFinish.promise;
		assert.equal(input.signal?.aborted, true);
	} });
	const unloadRun = unloaded.run();
	await unloadStarted.promise;
	unloaded.plugin.onunload();
	unloadFinish.resolve();
	assert.equal(await unloadRun, null);
	assert.equal(unloaded.events.includes("cancel-server"), false, "Plugin unload must preserve server jobs rather than cancel them");
	assert.equal(unloaded.events.includes("write-success"), false);
	assert.equal(unloaded.plugin.taskCenter.getTask(taskId)?.localTask?.jobId, sample.jobId);
	assert.equal(unloaded.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, undefined);
	assert.equal(unloaded.plugin.activeTranscriptionControllers.size, 0);

	const uncertain = fixture({ cancelConfirmed: false, duringTranscribe: async () => { throw new Error("Disconnected fixture"); } });
	assert.equal(await uncertain.run(), null);
	assert.equal(await uncertain.plugin.cancelTaskCenterLocalTask(taskId), false);
	assert.equal(uncertain.plugin.taskCenter.getTask(taskId)?.status, "paused");
	assert.equal(uncertain.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, true);
	assert.equal(uncertain.plugin.taskCenter.getTask(taskId)?.retry?.label, "重试取消");

	function cancellationFixture() {
		const value = fixture({ cancelConfirmed: false });
		value.plugin.taskCenter.upsertTask({ id: taskId, kind: "transcription", title: "meeting", targetPath: sample.sourcePath,
			status: "running", stage: "转写中", provider: "local-openai-compatible", localTask: sample,
			recovery: { kind: "transcription", audioPath: sample.sourcePath } });
		return value;
	}
	const automatic = cancellationFixture();
	const firstCancel = automatic.provider.cancelLocalTask!;
	let automaticCalls = 0;
	automatic.provider.cancelLocalTask = async value => {
		automaticCalls++;
		if (automaticCalls === 1) return firstCancel(value);
		return { confirmed: true, task: { ...value, cancelRequested: true, phase: "canceled" } };
	};
	assert.equal(await automatic.plugin.cancelTaskCenterLocalTask(taskId), false);
	await harness.clock.advance(999);
	assert.equal(automaticCalls, 1, "Cancellation confirmation waits before contacting the service again");
	await harness.clock.advance(1);
	assert.equal(automaticCalls, 2);
	assert.equal(automatic.plugin.taskCenter.getTask(taskId)?.status, "cancelled", "A later server confirmation must finish cancellation without a click or reload");
	assert.equal(harness.clock.pendingCount(), 0, "Confirmed cancellation releases both timers");
	await harness.clock.advance(120_000);
	assert.equal(automaticCalls, 2);
	assert.equal(automatic.events.includes("transcribe"), false, "Automatic cancellation must never submit inference");
	assert.ok(automatic.snapshots.some(snapshot => snapshot.tasks.some(item => item.status === "cancelled")), "Automatic completion must be persisted");

	const offline = cancellationFixture();
	const attemptTimes: number[] = [];
	offline.provider.cancelLocalTask = async () => {
		attemptTimes.push(harness.clock.now());
		throw new Error("Offline cancellation fixture");
	};
	await offline.plugin.cancelTaskCenterLocalTask(taskId);
	await harness.clock.advance(120_000);
	assert.deepEqual(attemptTimes, [0, 1000, 3000, 7000, 15000, 30000, 45000, 60000, 75000, 90000, 105000], "Offline cancellation uses bounded exponential backoff");
	assert.equal(offline.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, true);
	assert.equal(offline.plugin.taskCenter.getTask(taskId)?.status, "paused");
	assert.match(offline.plugin.taskCenter.getTask(taskId)?.stage ?? "", /重试取消/);
	assert.equal(offline.plugin.taskCenter.getTask(taskId)?.retry?.label, "重试取消");
	assert.equal(harness.clock.pendingCount(), 0);
	await harness.clock.advance(120_000);
	assert.equal(attemptTimes.length, 11, "A timed-out cancellation must not silently start another retry window");
	let manualCalls = 0;
	offline.provider.cancelLocalTask = async value => {
		manualCalls++;
		return { confirmed: manualCalls > 1, task: { ...value, phase: manualCalls > 1 ? "canceled" : "canceling" } };
	};
	await offline.plugin.cancelTaskCenterLocalTask(taskId);
	await harness.clock.advance(1000);
	assert.equal(manualCalls, 2, "A deliberate retry starts a new confirmation window");
	assert.equal(offline.plugin.taskCenter.getTask(taskId)?.status, "cancelled");

	for (const inFlight of [false, true]) {
		const stopping = cancellationFixture();
		const finishConfirmation = deferred();
		let calls = 0;
		stopping.provider.cancelLocalTask = async value => {
			calls++;
			if (calls === 1) return { confirmed: false, task: value };
			await finishConfirmation.promise;
			return { confirmed: true, task: { ...value, phase: "canceled" } };
		};
		await stopping.plugin.cancelTaskCenterLocalTask(taskId);
		if (inFlight) await harness.clock.advance(1000);
		stopping.plugin.onunload();
		const snapshotsAtUnload = stopping.snapshots.length;
		finishConfirmation.resolve();
		await harness.clock.advance(120_000);
		assert.equal(calls, inFlight ? 2 : 1, "Unloading must stop scheduling cancellation requests");
		assert.equal(stopping.plugin.taskCenter.getTask(taskId)?.status, "paused", "A response arriving after unload must not change persisted task state");
		assert.equal(stopping.plugin.taskCenter.getTask(taskId)?.localTask?.cancelRequested, true);
		assert.equal(stopping.snapshots.length, snapshotsAtUnload);
		assert.equal(harness.clock.pendingCount(), 0);
	}

	const pendingConfirmation = cancellationFixture();
	const releaseConfirmation = deferred();
	let pendingCalls = 0;
	pendingConfirmation.provider.cancelLocalTask = async value => {
		pendingCalls++;
		if (pendingCalls > 1) await releaseConfirmation.promise;
		return { confirmed: false, task: value };
	};
	await pendingConfirmation.plugin.cancelTaskCenterLocalTask(taskId);
	await harness.clock.advance(1000);
	const manualWhilePending = pendingConfirmation.plugin.cancelTaskCenterLocalTask(taskId);
	await harness.clock.advance(119_000);
	assert.equal(pendingCalls, 2, "The automatic retry and manual action must share one in-flight cancellation");
	assert.match(pendingConfirmation.plugin.taskCenter.getTask(taskId)?.stage ?? "", /重试取消/);
	releaseConfirmation.resolve();
	await manualWhilePending;
	await harness.clock.advance(120_000);
	assert.equal(pendingCalls, 2, "A late unconfirmed response must not reset the confirmation deadline");
	assert.equal(harness.clock.pendingCount(), 0);
	assert.match(pendingConfirmation.plugin.taskCenter.getTask(taskId)?.stage ?? "", /重试取消/);

	const recoveredCancellation = cancellationFixture();
	recoveredCancellation.plugin.taskCenter.updateTask(taskId, { status: "paused", localTask: { ...sample, cancelRequested: true, phase: "canceling" } });
	let recoveredCalls = 0;
	recoveredCancellation.provider.cancelLocalTask = async value => {
		recoveredCalls++;
		return { confirmed: recoveredCalls > 1, task: { ...value, phase: recoveredCalls > 1 ? "canceled" : "canceling" } };
	};
	await recoveredCancellation.plugin.resumeRestoredRemoteTranscriptionTasks();
	await harness.clock.flush();
	await harness.clock.advance(1000);
	assert.equal(recoveredCalls, 2, "Reload must continue confirming a persisted cancellation intent");
	assert.equal(recoveredCancellation.plugin.taskCenter.getTask(taskId)?.status, "cancelled");
	assert.equal(recoveredCancellation.events.includes("transcribe"), false);

	const duplicateCancel = fixture();
	duplicateCancel.plugin.taskCenter.upsertTask({ id: taskId, kind: "transcription", title: "meeting", status: "running",
		stage: "转写中", provider: "local-openai-compatible", localTask: sample });
	const cancelStarted = deferred();
	const cancelFinished = deferred();
	let cancelCalls = 0;
	duplicateCancel.provider.cancelLocalTask = async (value) => {
		cancelCalls++;
		cancelStarted.resolve();
		await cancelFinished.promise;
		return { confirmed: true, task: { ...value, cancelRequested: true, phase: "canceled" } };
	};
	const cancelFirst = duplicateCancel.plugin.cancelTaskCenterLocalTask(taskId);
	const cancelSecond = duplicateCancel.plugin.cancelTaskCenterLocalTask(taskId);
	await cancelStarted.promise;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(cancelCalls, 1, "Repeated cancellation shares a single remote mutation");
	cancelFinished.resolve();
	await Promise.all([cancelFirst, cancelSecond]);
	assert.equal(duplicateCancel.plugin.taskCenter.getTask(taskId)?.status, "cancelled");

	const replacement: LocalTranscriptionTaskResume = { ...sample, clientRequestId: "request-2", jobId: "job-2", phase: "uploading" };
	for (const nextGeneration of [replacement, { ...sample, instanceId: "instance-2" }]) {
		const replacedBeforeTimer = cancellationFixture();
		await replacedBeforeTimer.plugin.cancelTaskCenterLocalTask(taskId);
		replacedBeforeTimer.plugin.taskCenter.restartTask({ id: taskId, kind: "transcription", title: "new", status: "running",
			stage: "新任务上传中", provider: "local-openai-compatible", localTask: nextGeneration });
		await harness.clock.advance(120_000);
		assert.equal(replacedBeforeTimer.events.filter(event => event === "cancel-server").length, 1, "A stale timer cannot cancel a replacement request or server instance");
		assert.equal(replacedBeforeTimer.plugin.taskCenter.getTask(taskId)?.stage, "新任务上传中");
		assert.equal(harness.clock.pendingCount(), 0);
	}
	for (const rejectOldResponse of [false, true]) {
		const staleCancel = fixture();
		staleCancel.plugin.taskCenter.upsertTask({ id: taskId, kind: "transcription", title: "old", status: "running",
			stage: "转写中", provider: "local-openai-compatible", localTask: sample });
		const started = deferred();
		const finished = deferred();
		staleCancel.provider.cancelLocalTask = async (value) => {
			started.resolve();
			await finished.promise;
			if (rejectOldResponse) throw new Error("Old cancellation connection failed");
			return { confirmed: true, task: { ...value, cancelRequested: true, phase: "canceled" } };
		};
		const pendingCancel = staleCancel.plugin.cancelTaskCenterLocalTask(taskId);
		await started.promise;
		staleCancel.plugin.taskCenter.restartTask({ id: taskId, kind: "transcription", title: "new", status: "running",
			stage: "新任务上传中", provider: "local-openai-compatible", localTask: replacement });
		const nextController = new AbortController();
		staleCancel.plugin.activeTranscriptionControllers.set(taskId, nextController);
		finished.resolve();
		await pendingCancel;
		assert.equal(staleCancel.plugin.taskCenter.getTask(taskId)?.status, "running", "An old cancellation response must not overwrite a replacement task");
		assert.equal(staleCancel.plugin.taskCenter.getTask(taskId)?.stage, "新任务上传中");
		assert.equal(staleCancel.plugin.taskCenter.getTask(taskId)?.localTask?.clientRequestId, replacement.clientRequestId);
		assert.equal(nextController.signal.aborted, false);
	}

	const staleCleanup = fixture({ cleanupFailure: true });
	await staleCleanup.run();
	const cleanupStarted = deferred();
	const cleanupFinished = deferred();
	let cleanupCalls = 0;
	staleCleanup.provider.acknowledgeLocalResult = async (value) => {
		cleanupCalls++;
		cleanupStarted.resolve();
		await cleanupFinished.promise;
		return { confirmed: true, task: value };
	};
	const cleanupFirst = staleCleanup.plugin.cleanupLocalTranscriptionResult(taskId);
	const cleanupSecond = staleCleanup.plugin.cleanupLocalTranscriptionResult(taskId);
	await cleanupStarted.promise;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(cleanupCalls, 1, "Repeated cleanup shares one remote operation");
	staleCleanup.plugin.taskCenter.restartTask({ id: taskId, kind: "transcription", title: "new", status: "running",
		stage: "新任务上传中", provider: "local-openai-compatible", localTask: replacement });
	cleanupFinished.resolve();
	await Promise.all([cleanupFirst, cleanupSecond]);
	assert.equal(staleCleanup.plugin.taskCenter.getTask(taskId)?.status, "running");
	assert.equal(staleCleanup.plugin.taskCenter.getTask(taskId)?.stage, "新任务上传中");
	assert.equal(staleCleanup.plugin.taskCenter.getTask(taskId)?.localTask?.jobId, replacement.jobId, "Old cleanup must not remove the new job's recovery metadata");

	for (const generic of [false, true]) {
		const saving = fixture({ generic });
		const startedSaving = deferred();
		const finishSaving = deferred();
		saving.plugin.transcriptService.writeSuccessTranscript = async () => {
			saving.events.push("write-success");
			startedSaving.resolve();
			await finishSaving.promise;
			return { path: "Fixtures/meeting.transcript.md" };
		};
		const pendingSave = saving.run();
		await startedSaving.promise;
		assert.equal(await saving.plugin.cancelTaskCenterLocalTask(taskId), false, "Saving is an atomic completion phase for both standard and jobs paths");
		finishSaving.resolve();
		assert.equal((await pendingSave)?.analysisEligible, true);
		assert.equal(saving.plugin.taskCenter.getTask(taskId)?.status, "success");
	}

	const genericSuccess = fixture({ generic: true });
	await genericSuccess.run();
	assert.equal(await genericSuccess.plugin.cancelTaskCenterLocalTask(taskId), false, "A stale cancel action must not replace a completed result with failure");
	assert.equal(genericSuccess.plugin.taskCenter.getTask(taskId)?.status, "success");

	const resumption = fixture();
	resumption.plugin.taskCenter.upsertTask({ id: taskId, kind: "transcription", title: "meeting", targetPath: sample.sourcePath,
		status: "running", stage: "转写中", provider: "local-openai-compatible", localTask: sample,
		recovery: { kind: "transcription", audioPath: sample.sourcePath } });
	const retries: unknown[][] = [];
	resumption.plugin.retryTranscriptionTask = async (...args) => { retries.push(args); };
	await resumption.plugin.resumeRestoredRemoteTranscriptionTasks();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(retries.length, 1);
	assert.deepEqual(retries[0][6], sample, "Reload should resume the same local job metadata");
	resumption.plugin.settings.offlineTranscription.provider = "lm-studio";
	await resumption.plugin.resumeLocalTranscriptionTask(taskId);
	assert.equal(retries.length, 1, "A changed provider must not silently resume against another configuration");
	assert.equal(resumption.plugin.taskCenter.getTask(taskId)?.status, "paused");

	for (const provider of ["local-openai-compatible", "lm-studio"] as const) {
		for (const legacySource of ["settings", "secret-storage"] as const) {
			for (const targetAlreadySet of [false, true]) {
				const migrated = fixture();
				const secrets = new Map<string, string>();
				const targetId = `echo-notes-transcription-api-key-${provider}`;
				secrets.set("echo-notes-transcription-api-key-siliconflow", "synthetic-unrelated-key");
				if (legacySource === "secret-storage") secrets.set("echo-notes-api-key", "synthetic-legacy-key");
				if (targetAlreadySet) secrets.set(targetId, "synthetic-selected-provider-key");
				Object.assign(migrated.plugin, {
					getApiKey: (harness.prototype as TestPlugin).getApiKey,
					loadData: async () => ({
						offlineTranscription: { provider, baseUrl: `${sample.origin}/v1`, model: sample.model, language: "auto" },
						...(legacySource === "settings" ? { apiKey: "synthetic-legacy-key" } : {})
					}),
					saveData: async () => undefined,
					app: { secretStorage: {
						getSecret: (id: string) => secrets.get(id) ?? null,
						setSecret: (id: string, value: string) => { secrets.set(id, value); }
					} }
				});
				await migrated.plugin.loadSettings();
				assert.equal(migrated.plugin.getApiKey(provider), targetAlreadySet ? "synthetic-selected-provider-key"
					: provider === "local-openai-compatible" ? "" : "synthetic-legacy-key",
				"Loading settings must never migrate a legacy cloud credential into the new local provider");
				assert.equal(secrets.get("echo-notes-transcription-api-key-siliconflow"), "synthetic-unrelated-key");
				if (provider === "local-openai-compatible") {
					assert.equal(secrets.get(targetId), targetAlreadySet ? "synthetic-selected-provider-key" : undefined);
				}
			}
		}
	}
}
