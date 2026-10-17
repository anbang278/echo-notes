import assert from "node:assert/strict";
import {
	LOCAL_ASR_LIFECYCLE_DEFAULTS,
	defaultLocalAsrReadinessUrl,
	normalizeLocalAsrLifecycleSettings,
	normalizeLocalAsrServiceKey,
	readLocalAsrProfile,
	readLocalAsrProfiles,
	saveLocalAsrProfile,
	validateLocalAsrLifecycleForEnable,
	validateLocalAsrReadinessUrl,
	writeLocalAsrProfiles,
	type LocalAsrSettingsStore
} from "../src/local-asr/lifecycle-settings";
import {
	LocalAsrAcquireError,
	LocalAsrLifecycleManager,
	type LocalAsrClock,
	type LocalAsrCommandHandle,
	type LocalAsrCommandRunner,
	type LocalAsrCommandSpec,
	type LocalAsrProbe,
	type LocalAsrProbeResult,
	type LocalAsrTimers
} from "../src/local-asr/lifecycle-manager";

function memoryStore(initial: Record<string, string> = {}): LocalAsrSettingsStore & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		load: (key) => data.get(key) ?? null,
		save: (key, value) => { data.set(key, value); }
	};
}

export function runLocalAsrSettingsTests(): void {
	// T01: 默认、归一化与非法值回退。
	assert.deepEqual(normalizeLocalAsrLifecycleSettings(undefined), LOCAL_ASR_LIFECYCLE_DEFAULTS);
	assert.deepEqual(normalizeLocalAsrLifecycleSettings(null), LOCAL_ASR_LIFECYCLE_DEFAULTS);
	assert.deepEqual(normalizeLocalAsrLifecycleSettings("junk"), LOCAL_ASR_LIFECYCLE_DEFAULTS);
	const normalized = normalizeLocalAsrLifecycleSettings({
		enabled: "yes", startCommand: "  start.sh  ", stopCommand: "stop.sh", workingDirectory: " /tmp/asr ",
		readinessUrl: " http://127.0.0.1:9000/health ", startupTimeoutSeconds: "60", idleTimeoutSeconds: 0,
		shutdownTimeoutSeconds: 45
	});
	assert.deepEqual(normalized, {
		enabled: false, startCommand: "start.sh", stopCommand: "stop.sh", workingDirectory: "/tmp/asr",
		readinessUrl: "http://127.0.0.1:9000/health", startupTimeoutSeconds: 60, idleTimeoutSeconds: 0, shutdownTimeoutSeconds: 45
	});
	assert.equal(normalizeLocalAsrLifecycleSettings({ startupTimeoutSeconds: 0, idleTimeoutSeconds: -5, shutdownTimeoutSeconds: Number.NaN }).startupTimeoutSeconds, 180);
	assert.equal(normalizeLocalAsrLifecycleSettings({ idleTimeoutSeconds: -5 }).idleTimeoutSeconds, 30);
	assert.equal(normalizeLocalAsrLifecycleSettings({ startupTimeoutSeconds: 999_999 }).startupTimeoutSeconds, 24 * 3600);

	// T02: profile 键按 Provider + 规范化 Base URL 隔离；localhost 归一化到 127.0.0.1；API路径保留、去末尾斜线。
	assert.equal(normalizeLocalAsrServiceKey("local-openai-compatible", "http://localhost:9000/v1/"), "local-openai-compatible|http://127.0.0.1:9000/v1");
	assert.equal(normalizeLocalAsrServiceKey("local-openai-compatible", "http://127.0.0.1:9000/v1"), "local-openai-compatible|http://127.0.0.1:9000/v1");
	assert.notEqual(normalizeLocalAsrServiceKey("local-openai-compatible", "http://127.0.0.1:9000/v1"), normalizeLocalAsrServiceKey("local-openai-compatible", "http://127.0.0.1:9001/v1"));
	assert.throws(() => normalizeLocalAsrServiceKey("local-openai-compatible", "https://remote.example/v1"));

	// T02: 存储 round-trip、损坏 JSON、隔离。
	const store = memoryStore();
	const profile = { ...LOCAL_ASR_LIFECYCLE_DEFAULTS, enabled: true, startCommand: "start.sh", stopCommand: "stop.sh", readinessUrl: "http://127.0.0.1:9000/health" };
	saveLocalAsrProfile(store, "local-openai-compatible", "http://localhost:9000/v1/", profile);
	assert.deepEqual(readLocalAsrProfile(store, "local-openai-compatible", "http://127.0.0.1:9000/v1"), profile, "localhost 与 127.0.0.1 是同一 profile");
	assert.deepEqual(readLocalAsrProfile(store, "local-openai-compatible", "http://127.0.0.1:9100/v1"), LOCAL_ASR_LIFECYCLE_DEFAULTS, "不同端口互不串用");
	const written = memoryStore();
	writeLocalAsrProfiles(written, {});
	assert.equal(written.data.get("echo-notes:local-asr-lifecycle:v1"), "{}");
	const savedPayload = store.data.get("echo-notes:local-asr-lifecycle:v1") ?? "";
	assert.ok(savedPayload.includes("local-openai-compatible|http://127.0.0.1:9000/v1"), "profile 按规范化键保存");
	assert.ok(savedPayload.includes("start.sh"), "命令按原文保存（本机存储，不进 data.json）");
	const corrupted = memoryStore({ "echo-notes:local-asr-lifecycle:v1": "{not json" });
	assert.deepEqual(readLocalAsrProfiles(corrupted), {});
	const arrayRoot = memoryStore({ "echo-notes:local-asr-lifecycle:v1": "[1,2]" });
	assert.deepEqual(readLocalAsrProfiles(arrayRoot), {});

	// T01/T19: 启用校验文案与默认就绪地址。
	assert.equal(validateLocalAsrLifecycleForEnable({ ...LOCAL_ASR_LIFECYCLE_DEFAULTS }, "http://127.0.0.1:9000/v1"), "请先填写启动命令和关闭命令。");
	assert.equal(validateLocalAsrLifecycleForEnable({ ...LOCAL_ASR_LIFECYCLE_DEFAULTS, startCommand: "s", stopCommand: "t" }, "http://127.0.0.1:9000/v1"), "请填写就绪检查地址。");
	assert.equal(
		validateLocalAsrLifecycleForEnable({ ...LOCAL_ASR_LIFECYCLE_DEFAULTS, startCommand: "s", stopCommand: "t", readinessUrl: "http://127.0.0.1:9001/health" }, "http://127.0.0.1:9000/v1"),
		"就绪检查地址必须使用当前服务的同源地址。");
	assert.equal(
		validateLocalAsrLifecycleForEnable({ ...LOCAL_ASR_LIFECYCLE_DEFAULTS, startCommand: "s", stopCommand: "t", readinessUrl: "http://127.0.0.1:9000/health?x=1" }, "http://127.0.0.1:9000/v1"),
		"请填写有效的就绪检查地址。", "查询参数在 URL 解析阶段被拒绝");
	assert.equal(validateLocalAsrLifecycleForEnable({ ...LOCAL_ASR_LIFECYCLE_DEFAULTS, startCommand: "s", stopCommand: "t", readinessUrl: "http://127.0.0.1:9000/health" }, "http://127.0.0.1:9000/v1"), undefined);
	assert.equal(defaultLocalAsrReadinessUrl("http://localhost:9000/v1"), "http://127.0.0.1:9000/health");
	assert.equal(validateLocalAsrReadinessUrl("", "http://127.0.0.1:9000/v1"), "请填写就绪检查地址。");
	assert.equal(validateLocalAsrReadinessUrl("http://127.0.0.1:9000/health", "http://localhost:9000/v1"), undefined, "localhost 与 127.0.0.1 视为同源");
	assert.equal(validateLocalAsrReadinessUrl("https://127.0.0.1:9000/health", "http://127.0.0.1:9000/v1"), "就绪检查地址必须使用当前服务的同源地址。");
}

interface Harness {
	manager: LocalAsrLifecycleManager;
	probes: LocalAsrProbeResult[];
	probeLog: string[];
	commands: Array<{ spec: { command: string; workingDirectory: string; timeoutMs: number }; handle: FakeHandle }>;
	clock: FakeClock;
	timers: FakeTimers;
	notices: Array<{ stage: string; errorCode?: string }>;
}

class FakeClock implements LocalAsrClock {
	private current = 0;
	now(): number { return this.current; }
	advance(ms: number): void { this.current += ms; }
}

class FakeTimers implements LocalAsrTimers {
	private nextId = 0;
	private entries = new Map<number, { at: number; run: () => void }>();
	constructor(private clock: FakeClock) {}
	setTimeout(handler: () => void, delayMs: number): unknown {
		const id = ++this.nextId;
		this.entries.set(id, { at: this.clock.now() + Math.max(0, delayMs), run: handler });
		return id;
	}
	clearTimeout(handle: unknown): void { this.entries.delete(handle as number); }
	pendingCount(): number { return this.entries.size; }
	peek(): { at: number } | undefined {
		const next = [...this.entries.values()].sort((a, b) => a.at - b.at)[0];
		return next ? { at: next.at } : undefined;
	}
	async runNext(): Promise<void> {
		const next = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (!next) throw new Error("没有可运行的计时器");
		this.clock.current = Math.max(this.clock.current, next[1].at);
		this.entries.delete(next[0]);
		next[1].run();
		await flushMicrotasks();
	}
	async runUntilIdleOr(deadlineMs: number): Promise<void> {
		const limit = this.clock.now() + deadlineMs;
		for (;;) {
			const next = [...this.entries.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > limit) break;
			this.clock.current = Math.max(this.clock.current, next[1].at);
			this.entries.delete(next[0]);
			next[1].run();
			await flushMicrotasks();
		}
		this.clock.current = limit;
		await flushMicrotasks();
	}
}

class FakeHandle implements LocalAsrCommandHandle {
	exitedPromise: Promise<{ code: number | null; signal: string | null }>;
	private settle!: (value: { code: number | null; signal: string | null }) => void;
	cancelled = false;
	constructor() {
		this.exitedPromise = new Promise((resolve) => { this.settle = resolve; });
	}
	exit(code: number | null, signal: string | null = null): void { this.settle({ code, signal }); }
	cancel(): void { this.cancelled = true; this.exit(null, "SIGTERM"); }
	get exited(): Promise<{ code: number | null; signal: string | null }> { return this.exitedPromise; }
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

/** 只推进到启动命令已发起、就绪探测尚未返回的微任务深度。 */
async function flushToCommandLaunched(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createHarness(probeResults: LocalAsrProbeResult[], options: { runner?: LocalAsrCommandRunner } = {}): Harness {
	const clock = new FakeClock();
	const timers = new FakeTimers(clock);
	const probeLog: string[] = [];
	const probe: LocalAsrProbe = async (url) => {
		probeLog.push(url);
		const next = probeResults.shift();
		if (next === undefined) return { kind: "network-error" };
		return next;
	};
	const commands: Harness["commands"] = [];
	const runCommand: LocalAsrCommandRunner = options.runner ?? (async (spec) => {
		const handle = new FakeHandle();
		commands.push({ spec, handle });
		return handle;
	});
	const notices: Harness["notices"] = [];
	const manager = new LocalAsrLifecycleManager({
		probe, runCommand, clock, timers,
		notify: { notify: (stage, errorCode) => { notices.push({ stage, errorCode }); } }
	});
	return { manager, probes: probeResults, probeLog, commands, clock, timers, notices };
}

const BASE_SPEC: LocalAsrCommandSpec = {
	provider: "local-openai-compatible",
	baseUrl: "http://127.0.0.1:9700/v1",
	readinessUrl: "http://127.0.0.1:9700/health",
	startCommand: "start.sh",
	stopCommand: "stop.sh",
	workingDirectory: "",
	startupTimeoutSeconds: 60,
	idleTimeoutSeconds: 30,
	shutdownTimeoutSeconds: 10
};

export async function runLocalAsrManagerTests(): Promise<void> {
	// T03: 预先就绪的服务直接复用；不启动也不关闭。
	{
		const harness = createHarness([{ kind: "ready", instanceId: "inst-1" }]);
		const lease = await harness.manager.acquire(BASE_SPEC);
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "external");
		assert.equal(harness.commands.length, 0, "就绪服务不执行任何命令");
		await lease.release("safe-terminal");
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "external", "外部服务不进入空闲关闭");
		await harness.timers.runUntilIdleOr(120_000);
		assert.equal(harness.commands.length, 0, "外部服务永不执行停止命令");
	}
	// T03: 503 视为已有服务：等待而非启动。
	{
		const harness = createHarness([{ kind: "responding", status: 503 }, { kind: "ready" }]);
		const lease = await harness.manager.acquire(BASE_SPEC);
		assert.equal(harness.commands.length, 0, "503 不触发启动");
		await lease.release("safe-terminal");
	}
	// T03: 401/403/404/重定向是配置错误，不得启动。
	for (const outcome of [{ kind: "invalid-config" } as const]) {
		const harness = createHarness([outcome]);
		await assert.rejects(harness.manager.acquire(BASE_SPEC), (error: unknown) =>
			error instanceof LocalAsrAcquireError && error.kind === "invalid-config");
		assert.equal(harness.commands.length, 0);
	}
	{
		const harness = createHarness([{ kind: "invalid-config" }]);
		await assert.rejects(harness.manager.acquire(BASE_SPEC), (error: unknown) =>
			error instanceof LocalAsrAcquireError && error.kind === "invalid-config");
		assert.equal(harness.commands.length, 0);
	}
	// T04: 明确 ECONNREFUSED 才启动；脚本退出0但未就绪继续等待。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "connection-refused" }, { kind: "ready", instanceId: "inst-9" }]);
		const leasePromise = harness.manager.acquire(BASE_SPEC);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(harness.commands.length, 1, "第一次拒绝后恰好一次启动");
		harness.commands[0].handle.exit(0);
		// 第二个 refused：启动后首次就绪探测仍未就绪，进入1秒间隔等待。
		await flushMicrotasks();
		await flushMicrotasks();
		await harness.timers.runNext(); // 探测间隔到：第三次 probe = ready
		const lease = await leasePromise;
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "in-use");
		await lease.release("safe-terminal");
		// 空闲倒计时 → 关闭
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.commands.length, 2, "空闲超时触发关闭命令");
		harness.commands[1].handle.exit(0);
		harness.probes.push({ kind: "connection-refused" });
		await flushMicrotasks();
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "unmanaged", "连接明确拒绝后确认停止");
	}
	// T07: 10个并发 acquire 仅一次启动；单个等待者取消不影响其他。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const controllers = Array.from({ length: 10 }, () => new AbortController());
		const leases = controllers.map((controller) => harness.manager.acquire(BASE_SPEC, controller.signal));
		await flushToCommandLaunched();
		assert.equal(harness.commands.length, 1, "共享启动");
		// abort 发生在就绪探测返回之前。
		controllers[0].abort();
		await flushMicrotasks();
		await flushMicrotasks();
		const settled = await Promise.allSettled(leases);
		const rejected = settled.filter((entry) => entry.status === "rejected");
		assert.equal(rejected.length, 1, "仅取消的等待者失败");
		assert.ok(rejected[0].status === "rejected" && rejected[0].reason instanceof LocalAsrAcquireError && rejected[0].reason.kind === "aborted");
		const fulfilled = settled.filter((entry) => entry.status === "fulfilled");
		assert.equal(fulfilled.length, 9, "其余等待者全部成功");
		for (const entry of fulfilled) await entry.value.release("safe-terminal");
	}
	// T09: 29秒不关闭、30秒关闭；新 acquire 取消倒计时；0秒立即关闭。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const first = await acquireStarted(harness);
		await first.release("safe-terminal");
		await harness.timers.runUntilIdleOr(29_000);
		assert.equal(harness.commands.length, 1, "29 秒不关闭");
		harness.clock.advance(1_000);
		await flushMicrotasks();
		await flushMicrotasks();
	}
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const first = await acquireStarted(harness);
		await first.release("safe-terminal");
		const second = harness.manager.acquire(BASE_SPEC);
		await flushMicrotasks();
		await flushMicrotasks();
		harness.probes.push({ kind: "ready" });
		const lease = await second;
		await lease.release("safe-terminal");
		await harness.timers.runUntilIdleOr(60_000);
		assert.ok(harness.commands.length >= 1);
	}
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const spec = { ...BASE_SPEC, idleTimeoutSeconds: 0 };
		const lease = await acquireStarted(harness, spec);
		await lease.release("safe-terminal");
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(harness.commands.length, 2, "空闲0秒立即关闭");
		harness.commands[1].handle.exit(0);
		harness.probes.push({ kind: "connection-refused" });
		await flushMicrotasks();
		await flushMicrotasks();
		await flushMicrotasks();
	}
	// T12: result-unknown / server-work-pending 保持阻塞，不关闭。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("result-unknown");
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "blocked");
		await harness.timers.runUntilIdleOr(120_000);
		assert.equal(harness.commands.length, 1, "阻塞状态不执行停止命令");
	}
	// T14: stop 退出0但仍响应 → stop-failed；stop 非零 → stop-failed。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.commands.length, 2);
		harness.commands[1].handle.exit(0);
		harness.probes.push({ kind: "ready" }, { kind: "ready" });
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "stop-failed");
	}
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		await harness.timers.runUntilIdleOr(60_000);
		harness.commands[1].handle.exit(1);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "stop-failed");
	}
	// T10: stop-failed 后新任务可以重新 acquire（重新探测启动）。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		await harness.timers.runUntilIdleOr(60_000);
		harness.commands[1].handle.exit(1);
		await flushMicrotasks();
		await flushMicrotasks();
		harness.probes.push({ kind: "ready" });
		const again = await harness.manager.acquire(BASE_SPEC);
		await again.release("safe-terminal");
	}
	// T15: 同 origin 运行中套用不同启停快照 → config-conflict。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await assert.rejects(harness.manager.acquire({ ...BASE_SPEC, startCommand: "other-start.sh" }), (error: unknown) =>
			error instanceof LocalAsrAcquireError && error.kind === "config-conflict");
		await lease.release("safe-terminal");
	}
	// T05: 启动命令非零退出不能被健康就绪竞态掩盖。
	{
		const harness = createHarness([{ kind: "connection-refused" }]);
		const pending = harness.manager.acquire(BASE_SPEC);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(harness.commands.length, 1);
		harness.commands[0].handle.exit(1);
		await flushMicrotasks();
		await flushMicrotasks();
		harness.probes.push({ kind: "ready" });
		await harness.timers.runNext();
		await assert.rejects(pending, (error: unknown) =>
			error instanceof LocalAsrAcquireError && error.kind === "start-failed");
	}
	// T06: 启动 deadline 超时 → start-timeout，不留下无限等待。
	{
		const harness = createHarness([{ kind: "connection-refused" }]);
		const pending = harness.manager.acquire(BASE_SPEC);
		await flushMicrotasks();
		await flushMicrotasks();
		assert.equal(harness.commands.length, 1, "超时前已执行一次启动");
		await harness.timers.runUntilIdleOr(59_000);
		await assert.rejects(pending, (error: unknown) => error instanceof LocalAsrAcquireError && error.kind === "start-timeout");
		assert.equal(harness.commands.length, 1, "无所有权证据不执行停止命令");
	}
	// T16: 卸载 dispose 清理计时器；阻塞任务保留服务。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("result-unknown");
		await harness.manager.dispose();
		assert.equal(harness.commands.length, 1, "未知结果任务保留服务，不执行停止");
	}
	// T16: dispose 时空闲且有所有权 → 尽力停止。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		const stopping = harness.manager.dispose({ forceStop: true });
		await flushMicrotasks();
		harness.commands[1].handle.exit(0);
		harness.probes.push({ kind: "connection-refused" });
		await stopping;
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "unmanaged");
	}
	// T11: 扩展 job 的运行/paused/取消待确认/保存中/cleanup-pending 均为 server-work-pending，阻止关闭。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("server-work-pending");
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "blocked", "服务端工作未确认时保持阻塞");
		await harness.timers.runUntilIdleOr(120_000);
		assert.equal(harness.commands.length, 1, "server-work-pending 不执行停止命令");
	}
	// T13: 关闭前实例变化 → 解除托管为外部服务，不停止他人的服务。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready", instanceId: "inst-a" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		// 空闲触发停止：关闭前复核实例，发现已换成 inst-b。
		harness.probes.push({ kind: "ready", instanceId: "inst-b" });
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "external", "实例变化后视为外部服务");
		assert.equal(harness.commands.length, 1, "不停止非本次启动的实例");
	}
	// T13: 同实例确认 → 正常执行关闭命令。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready", instanceId: "inst-a" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		harness.probes.push({ kind: "ready", instanceId: "inst-a" });
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.commands.length, 2, "实例一致时执行关闭");
		harness.commands[1].handle.exit(0);
		harness.probes.push({ kind: "connection-refused" });
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "unmanaged");
	}
	// T10: 重复 release 幂等；晚到的空闲 timer 不重复触发关闭。
	{
		const harness = createHarness([{ kind: "connection-refused" }, { kind: "ready" }]);
		const lease = await acquireStarted(harness);
		await lease.release("safe-terminal");
		await lease.release("safe-terminal");
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.commands.length, 2, "重复 release 只触发一次关闭");
		harness.commands[1].handle.exit(0);
		harness.probes.push({ kind: "connection-refused" });
		await harness.timers.runUntilIdleOr(60_000);
		assert.equal(harness.manager.getState(BASE_SPEC.baseUrl), "unmanaged");
	}
}

/** T18: 无 window.require 环境可导入执行模块且不触发 child_process 加载；移动端调用返回受控错误。 */
export async function runLocalAsrMobileSafetyTests(): Promise<void> {
	const { createDesktopCommandRunner } = await import("../src/local-asr/desktop-command-adapter");
	const globalWindow = (globalThis as { window?: unknown }).window;
	assert.equal(globalWindow, undefined, "Node 测试环境不应有 window");
	await assert.rejects(createDesktopCommandRunner()({
		command: "start.sh", workingDirectory: "", timeoutMs: 1000
	}), /仅桌面版支持本地服务命令执行。/, "无 window.require 时不执行命令并给出受控错误");
}

async function acquireStarted(harness: Harness, spec: LocalAsrCommandSpec = BASE_SPEC): Promise<Awaited<ReturnType<LocalAsrLifecycleManager["acquire"]>>> {
	const pending = harness.manager.acquire(spec);
	// 启动链：pre-probe(refused) → runCommand → waitForReadiness 轮询探测。
	// 就绪探测未命中时需要推进 FakeTimers 的 1000ms 间隔，直到 acquire 落定。
	for (let round = 0; round < 20; round += 1) {
		await flushMicrotasks();
		const settled = await Promise.race([pending.then(() => true, () => true), Promise.resolve(false)]);
		if (settled) break;
		if (harness.timers.pendingCount() === 0) break;
		await harness.timers.runNext();
	}
	const lease = await pending;
	if (harness.commands.length > 0) harness.commands[0].handle.exit(0);
	return lease;
}
