import {
	LOCAL_ASR_PROBE_INTERVAL_MS,
	LOCAL_ASR_PROBE_TIMEOUT_MS,
	classifyLocalAsrHttpStatus,
	classifyLocalAsrNetworkError,
	normalizeLocalAsrOrigin,
	parseLocalAsrInstanceId,
	type LocalAsrClock,
	type LocalAsrCommandHandle,
	type LocalAsrCommandRunner,
	type LocalAsrCommandSpec,
	type LocalAsrNoticeSink,
	type LocalAsrProbe,
	type LocalAsrProbeResult,
	type LocalAsrTimers
} from "./lifecycle-contracts";

export type LocalAsrLeaseOutcome = "safe-terminal" | "server-work-pending" | "result-unknown";

export interface LocalAsrLease {
	readonly origin: string;
	readonly generation: number;
	/** 幂等：重复 release 只记一次。 */
	release(outcome: LocalAsrLeaseOutcome): Promise<void>;
}

export type LocalAsrAcquireErrorKind =
	| "invalid-config" | "start-failed" | "start-timeout" | "aborted" | "config-conflict" | "runner-unavailable";

export class LocalAsrAcquireError extends Error {
	constructor(readonly kind: LocalAsrAcquireErrorKind, message: string) {
		super(message);
		this.name = "LocalAsrAcquireError";
	}
}

export type LocalAsrServiceState =
	| "unmanaged" | "probing" | "starting" | "waiting-ready" | "in-use" | "idle"
	| "stopping" | "stop-failed" | "blocked" | "external";

interface ManagedSession {
	origin: string;
	generation: number;
	spec: LocalAsrCommandSpec;
	startedAt: number;
	instanceId?: string;
	external: boolean;
}

interface PendingAcquire {
	signal?: AbortSignal;
	progress?: (stage: string) => void;
	release: (lease: LocalAsrLease | LocalAsrAcquireError) => void;
	removeAbort: () => void;
}

export interface LocalAsrManagerDependencies {
	probe: LocalAsrProbe;
	runCommand: LocalAsrCommandRunner;
	clock: LocalAsrClock;
	timers: LocalAsrTimers;
	notify?: LocalAsrNoticeSink;
	/** 探测就绪响应体，用于捕获 instance_id。 */
	readBody?: (url: string, signal?: AbortSignal) => Promise<{ status: number; bodyText: string }>;
}

/**
 * 插件生命周期内唯一管理器（design.md）。按规范化 origin 串行启停；
 * 实现 8 条管理规则：共享启动、就绪等待、空闲倒计时、实例校验、关闭确认等。
 */
export class LocalAsrLifecycleManager {
	private readonly services = new Map<string, ServiceRuntime>();
	private readonly acquisitions = new Map<string, number>();
	private disposed = false;

	constructor(private readonly deps: LocalAsrManagerDependencies) {}

	getState(origin: string): LocalAsrServiceState {
		return this.services.get(normalizeLocalAsrOrigin(origin))?.state ?? "unmanaged";
	}

	/** 规则1：真实转写前的 acquire。signal 中止抛 aborted。 */
	async acquire(spec: LocalAsrCommandSpec, signal?: AbortSignal, progress?: (stage: string) => void): Promise<LocalAsrLease> {
		if (this.disposed) throw new LocalAsrAcquireError("aborted", "插件正在卸载，本地服务管理已停止。");
		const origin = normalizeLocalAsrOrigin(spec.baseUrl);
		this.clearIdle(origin);
		let runtime = this.services.get(origin);
		if (runtime?.state === "stopping" || runtime?.state === "stop-failed") {
			// 规则6：stopping 期间新 acquire 等待停止完成后重新探测启动。
			await this.waitForStop(runtime);
			runtime = this.services.get(origin);
		}
		if (!runtime) {
			runtime = this.createRuntime(origin, spec);
			this.services.set(origin, runtime);
		}
		return this.joinRuntime(runtime, spec, signal, progress);
	}

	/** 规则6：空闲倒计时开始前复核 generation/租约/阻塞/所有权。 */
	scheduleIdleCheck(origin: string, delayMs: number): void {
		const runtime = this.services.get(normalizeLocalAsrOrigin(origin));
		if (!runtime || this.disposed) return;
		this.clearIdle(runtime.origin);
		if (delayMs <= 0) {
			this.beginIdleShutdown(runtime);
			return;
		}
		const generation = runtime.generation;
		const timer = this.deps.timers.setTimeout(() => {
			runtime.idleTimer = undefined;
			const current = this.services.get(runtime.origin);
			if (current !== runtime || current.generation !== generation || current.state !== "idle" || this.disposed) return;
			this.beginIdleShutdown(current);
		}, delayMs);
		runtime.idleTimer = timer;
	}

	/** 卸载补偿：取消计时器；未完成/未知任务保留服务；空闲且有所有权尝试有限关闭。 */
	async dispose(options: { forceStop?: boolean } = {}): Promise<void> {
		this.disposed = true;
		const pending: Promise<void>[] = [];
		for (const runtime of this.services.values()) {
			this.clearIdle(runtime.origin);
			if (runtime.session && !runtime.session.external && (options.forceStop === true || (runtime.state === "idle" && this.acquisitions.get(runtime.origin) === 0))) {
				pending.push(this.stopService(runtime).catch(() => undefined));
			}
		}
		await Promise.all(pending);
	}

	get isDisposed(): boolean { return this.disposed; }

	private createRuntime(origin: string, spec: LocalAsrCommandSpec): ServiceRuntime {
		return {
			origin,
			state: "unmanaged",
			generation: 0,
			leases: new Set<LeaseToken>(),
			waiters: [],
			session: undefined,
			idleTimer: undefined,
			stopPromise: undefined,
			startPromise: undefined
		};
	}

	private async joinRuntime(
		runtime: ServiceRuntime,
		spec: LocalAsrCommandSpec,
		signal: AbortSignal | undefined,
		progress: ((stage: string) => void) | undefined
	): Promise<LocalAsrLease> {
		// 规则：相同 origin 运行中禁止套用不同启停快照 → 配置冲突。
		if (runtime.session && !runtime.session.external && snapshotKey(runtime.session.spec) !== snapshotKey(spec)) {
			throw new LocalAsrAcquireError("config-conflict", "该服务地址已有不同启停配置在运行；请等待当前任务结束或先在任务中心处理。");
		}
		// 已有会话且启动链已结束：服务已确认运行，直接附加租约；
		// 重新探测会把自托管服务误判为外部服务，导致空闲关闭永久失效。
		if (runtime.session && !runtime.startPromise) {
			const lease = await this.attachLease(runtime, Promise.resolve(), signal, progress);
			return lease;
		}
		const ready = runtime.startPromise ?? this.startService(runtime, spec, progress);
		const lease = await this.attachLease(runtime, ready, signal, progress);
		return lease;
	}

	private async attachLease(
		runtime: ServiceRuntime,
		ready: Promise<void>,
		signal: AbortSignal | undefined,
		progress: ((stage: string) => void) | undefined
	): Promise<LocalAsrLease> {
		const token: LeaseToken = { origin: runtime.origin, generation: runtime.generation, released: false };
		const waiters = runtime.waiters;
		const pending: PendingAcquire = {
			signal,
			progress,
			release: () => undefined,
			removeAbort: () => undefined
		};
		const waiter = new Promise<LocalAsrLease | LocalAsrAcquireError>((resolve) => {
			pending.release = resolve;
		});
		waiters.push(pending);
		const abort = () => {
			// 规则5：单个等待者取消不中止其他等待者；仅注销自己。
			const index = waiters.indexOf(pending);
			if (index >= 0) waiters.splice(index, 1);
			pending.removeAbort();
			pending.release(new LocalAsrAcquireError("aborted", "转写请求已取消。"));
			this.recheckIdle(runtime);
		};
		if (signal) {
			if (signal.aborted) { abort(); return waiterthen(waiter); }
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		void ready.then(() => {
			const index = waiters.indexOf(pending);
			if (index < 0) return;
			waiters.splice(index, 1);
			pending.removeAbort();
			runtime.leases.add(token);
			this.acquisitions.set(runtime.origin, runtime.leases.size);
			// 外部服务保持 external 语义：被使用但不被托管。
			runtime.state = runtime.session?.external ? "external" : "in-use";
			this.clearIdle(runtime.origin);
			pending.release(this.createLease(runtime, token));
		}, (error: unknown) => {
			const index = waiters.indexOf(pending);
			if (index >= 0) waiters.splice(index, 1);
			pending.removeAbort();
			pending.release(error instanceof LocalAsrAcquireError ? error
				: new LocalAsrAcquireError("start-failed", error instanceof Error ? error.message : "本地服务启动失败。"));
			this.recheckIdle(runtime);
		});
		return waiterthen(waiter);
	}

	private createLease(runtime: ServiceRuntime, token: LeaseToken): LocalAsrLease {
		const manager = this;
		return {
			origin: runtime.origin,
			generation: token.generation,
			async release(outcome) {
				if (token.released) return;
				token.released = true;
				const current = manager.services.get(runtime.origin);
				if (!current || current.generation !== token.generation) return;
				current.leases.delete(token);
				manager.acquisitions.set(current.origin, current.leases.size);
				if (outcome !== "safe-terminal") {
					// server-work-pending / result-unknown：保持阻塞，不进入空闲计时。
					current.state = current.session?.external ? "external"
						: current.waiters.length > 0 ? "in-use" : "blocked";
					manager.deps.notify?.notify(current.state === "blocked" ? "blocked" : current.state === "in-use" ? "in-use" : "external-service");
					return;
				}
				manager.recheckIdle(current);
			}
		};
	}

	/** 最后 lease 安全释放且无任务阻塞才计空闲（规则6）。 */
	private recheckIdle(runtime: ServiceRuntime): void {
		if (this.disposed || runtime.state === "stopping" || runtime.state === "stop-failed") return;
		if (runtime.leases.size > 0 || runtime.waiters.length > 0) return;
		if (!runtime.session) { runtime.state = "unmanaged"; return; }
		if (runtime.session.external) { runtime.state = "external"; return; }
		const idleMs = runtime.session.spec.idleTimeoutSeconds * 1000;
		runtime.state = "idle";
		this.deps.notify?.notify("idle-countdown");
		this.scheduleIdleCheck(runtime.origin, idleMs);
	}

	private async startService(runtime: ServiceRuntime, spec: LocalAsrCommandSpec, progress: ((stage: string) => void) | undefined): Promise<void> {
		const attempt = (async () => {
			runtime.state = "probing";
			this.deps.notify?.notify("probing");
			progress?.("正在检查本地服务状态");
			const pre = await this.probeOnce(spec.readinessUrl);
			if (this.disposed) throw new LocalAsrAcquireError("aborted", "插件正在卸载。");
			if (pre.kind === "ready") {
				runtime.session = { origin: runtime.origin, generation: runtime.generation, spec, startedAt: this.deps.clock.now(), instanceId: pre.instanceId, external: true };
				runtime.state = "external";
				this.deps.notify?.notify("external-service");
				progress?.("复用已有本地服务");
				return;
			}
			if (pre.kind === "responding" || pre.kind === "network-error" || pre.kind === "invalid-config") {
				// 任意HTTP响应=已有服务（503 可等待）；timeout/DNS 不得判作未启动；401/403/404/重定向=配置错误。
				if (pre.kind === "invalid-config") throw new LocalAsrAcquireError("invalid-config", "就绪检查地址返回配置错误（鉴权/路径或重定向），请检查地址。");
				runtime.session = { origin: runtime.origin, generation: runtime.generation, spec, startedAt: this.deps.clock.now(), external: true };
				const ready = await this.waitForReadiness(runtime, spec, progress);
				runtime.session.external = false;
				runtime.session.instanceId = ready.instanceId;
				void ready;
				return;
			}
			// 仅 connection-refused 走启动。
			runtime.state = "starting";
			this.deps.notify?.notify("starting");
			progress?.("正在启动本地服务");
			const deadline = this.deps.clock.now() + spec.startupTimeoutSeconds * 1000;
			const handle = await this.launchCommand(spec, deadline).catch((error: unknown) => {
				throw error instanceof LocalAsrAcquireError ? error : new LocalAsrAcquireError("start-failed", "无法创建本地服务启动命令执行环境。");
			});
			void handle.exited.then((exit) => {
				// 非零退出不能被健康就绪竞态掩盖（规则：adapter）。
				if (exit.code !== null && exit.code !== 0 && runtime.session && !runtime.session.external) {
					runtime.startExitFailure = { code: exit.code };
				}
				return exit;
			}).catch(() => undefined);
			runtime.session = { origin: runtime.origin, generation: runtime.generation, spec, startedAt: this.deps.clock.now(), external: false };
			const ready = await this.waitForReadiness(runtime, spec, progress);
			runtime.session.instanceId = ready.instanceId;
			return;
		})();
		runtime.startPromise = attempt;
		const cleanup = () => { if (runtime.startPromise === attempt) runtime.startPromise = undefined; };
		// 规则5：最后一个等待者退出才中止启动等待并按托管证据清理。
		const watch = async (): Promise<void> => {
			try { await attempt; } catch { /* surfaced to waiters via attachLease */ }
			cleanup();
			if (runtime.waiters.length === 0 && runtime.leases.size === 0 && runtime.session && !runtime.session.external) {
				if (runtime.startExitFailure) {
					// 启动命令已失败：进入有限补偿清理（规则4/6：T06）。
					await this.compensateFailedStart(runtime);
				} else {
					this.recheckIdle(runtime);
				}
			}
		};
		void watch();
		return attempt;
	}

	private async waitForStop(runtime: ServiceRuntime): Promise<void> {
		if (runtime.stopPromise) await runtime.stopPromise.catch(() => undefined);
	}

	private async probeOnce(url: string, signal?: AbortSignal): Promise<LocalAsrProbeResult> {
		return this.deps.probe(url, signal);
	}

	private async launchCommand(spec: LocalAsrCommandSpec, deadlineMs: number): Promise<LocalAsrCommandHandle> {
		const remaining = deadlineMs - this.deps.clock.now();
		if (remaining <= 0) throw new LocalAsrAcquireError("start-timeout", "本地服务启动等待时间已用尽。");
		return this.deps.runCommand({
			command: spec.startCommand,
			workingDirectory: spec.workingDirectory,
			timeoutMs: remaining,
			signal: undefined
		});
	}

	private async waitForReadiness(runtime: ServiceRuntime, spec: LocalAsrCommandSpec, progress: ((stage: string) => void) | undefined): Promise<{ instanceId?: string }> {
		runtime.state = "waiting-ready";
		this.deps.notify?.notify("waiting-ready");
		progress?.(`等待本地服务就绪（最长 ${spec.startupTimeoutSeconds} 秒）`);
		const deadline = this.deps.clock.now() + spec.startupTimeoutSeconds * 1000;
		for (;;) {
			if (this.disposed) throw new LocalAsrAcquireError("aborted", "插件正在卸载。");
			const result = await this.probeOnce(spec.readinessUrl);
			if (result.kind === "ready") {
				if (runtime.startExitFailure) {
					// 非零退出不得被健康就绪竞态掩盖。
					const failure = runtime.startExitFailure;
					runtime.startExitFailure = undefined;
					await this.compensateFailedStart(runtime);
					throw new LocalAsrAcquireError("start-failed", `本地服务启动命令以退出码 ${failure.code} 结束，就绪探测不再可信。`);
				}
				return { instanceId: result.instanceId };
			}
			if (result.kind === "invalid-config") {
				await this.compensateFailedStart(runtime);
				throw new LocalAsrAcquireError("invalid-config", "就绪检查地址返回配置错误，请检查就绪地址。");
			}
			if (result.kind === "connection-refused") {
				const session = runtime.session;
				if (session?.external) {
					// 启动前已有服务但探测转为拒绝：外部服务正在停止，不接管。
					runtime.session = undefined;
					throw new LocalAsrAcquireError("start-failed", "已有服务在转写前停止响应；请手动确认服务状态后重试。");
				}
			}
			if (this.deps.clock.now() + LOCAL_ASR_PROBE_INTERVAL_MS >= deadline) {
				await this.compensateFailedStart(runtime);
				throw new LocalAsrAcquireError("start-timeout", `本地服务在 ${spec.startupTimeoutSeconds} 秒内未就绪。`);
			}
			await this.delay(LOCAL_ASR_PROBE_INTERVAL_MS);
			// 下一轮探测前的等待已过；就绪结果在下一次 probeOnce 评估。
			continue;
		}
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.deps.timers.setTimeout(() => resolve(), ms);
		});
	}

	/** 规则4/6：启动失败/超时的有限清理；只处理本次命令句柄及有所有权证据的服务。 */
	private async compensateFailedStart(runtime: ServiceRuntime): Promise<void> {
		if (!runtime.session || runtime.session.external) { runtime.session = undefined; runtime.state = "unmanaged"; return; }
		const instanceAtStart = runtime.session.instanceId;
		try {
			await this.confirmInstanceOrRelease(runtime, instanceAtStart);
		} catch { /* ownership unverifiable: leave service running, do not broad-kill */ }
		if (!runtime.session) { runtime.state = "unmanaged"; return; }
		// 有所有权证据才尝试停止；未知状态不重放命令（规则8）。
		if (runtime.session.instanceId !== undefined || instanceAtStart !== undefined) {
			await this.stopService(runtime).catch(() => undefined);
		} else {
			runtime.session = undefined;
			runtime.state = runtime.state === "stop-failed" ? "stop-failed" : "unmanaged";
		}
	}

	/** 规则7：关闭前复核服务实例；实例变化即解除托管并提示。 */
	private async confirmInstanceOrRelease(runtime: ServiceRuntime, previousInstance: string | undefined): Promise<void> {
		if (previousInstance === undefined) return;
		const current = await this.probeOnce(runtime.session!.spec.readinessUrl).catch(() => undefined);
		if (current?.kind === "ready" && current.instanceId && current.instanceId !== previousInstance) {
			runtime.session = undefined;
			runtime.state = "external";
			this.deps.notify?.notify("external-service");
			return;
		}
		if (current?.kind === "ready" && current.instanceId) runtime.session!.instanceId = current.instanceId;
	}

	/** 规则8：关闭命令退出0后继续探测，直到连接明确拒绝才确认停止。 */
	private async stopService(runtime: ServiceRuntime): Promise<void> {
		if (!runtime.session || runtime.session.external) return;
		const session = runtime.session;
		const attempt = (async () => {
			runtime.state = "stopping";
			this.deps.notify?.notify("stopping");
			const spec = session.spec;
			const instanceBefore = session.instanceId;
			await this.confirmInstanceOrRelease(runtime, instanceBefore);
			if (!runtime.session) return;
			const deadline = this.deps.clock.now() + spec.shutdownTimeoutSeconds * 1000;
			const handle = await this.deps.runCommand({
				command: spec.stopCommand, workingDirectory: spec.workingDirectory,
				timeoutMs: spec.shutdownTimeoutSeconds * 1000, signal: undefined
			}).catch(() => null);
			if (!handle) { runtime.state = "stop-failed"; this.deps.notify?.notify("stop-failed"); return; }
			const exit = await handle.exited.catch(() => ({ code: null, signal: null }));
			if (exit.code !== 0) {
				runtime.state = "stop-failed";
				this.deps.notify?.notify("stop-failed", `exit-${exit.code ?? "signal"}`);
				return;
			}
			for (;;) {
				const result = await this.probeOnce(spec.readinessUrl).catch(() => undefined);
				if (result?.kind === "connection-refused") {
					runtime.session = undefined;
					runtime.state = "unmanaged";
					runtime.generation += 1;
					this.deps.notify?.notify("stopped");
					return;
				}
				if (this.deps.clock.now() + LOCAL_ASR_PROBE_INTERVAL_MS >= deadline) break;
				await this.delay(LOCAL_ASR_PROBE_INTERVAL_MS);
			}
			runtime.state = "stop-failed";
			this.deps.notify?.notify("stop-failed", "still-responding");
		})();
		runtime.stopPromise = attempt;
		try { await attempt; } finally { if (runtime.stopPromise === attempt) runtime.stopPromise = undefined; }
	}

	private clearIdle(origin: string): void {
		const runtime = this.services.get(origin);
		if (runtime?.idleTimer !== undefined) {
			this.deps.timers.clearTimeout(runtime.idleTimer);
			runtime.idleTimer = undefined;
		}
	}

	private beginIdleShutdown(runtime: ServiceRuntime): void {
		if (runtime.leases.size > 0 || runtime.waiters.length > 0 || !runtime.session) return;
		void this.stopService(runtime).catch(() => undefined);
	}
}

interface LeaseToken {
	origin: string;
	generation: number;
	released: boolean;
}

interface ServiceRuntime {
	origin: string;
	state: LocalAsrServiceState;
	generation: number;
	leases: Set<LeaseToken>;
	waiters: PendingAcquire[];
	session?: ManagedSession;
	idleTimer?: unknown;
	stopPromise?: Promise<void>;
	startPromise?: Promise<void>;
	startExitFailure?: { code: number };
}

function snapshotKey(spec: LocalAsrCommandSpec): string {
	return JSON.stringify([spec.provider, spec.baseUrl, spec.startCommand, spec.stopCommand, spec.workingDirectory, spec.readinessUrl,
		spec.startupTimeoutSeconds, spec.idleTimeoutSeconds, spec.shutdownTimeoutSeconds]);
}

/** Flatten the waiter union without an async wrapper that swallows aborts. */
function waiterthen(waiter: Promise<LocalAsrLease | LocalAsrAcquireError>): Promise<LocalAsrLease> {
	return waiter.then((value) => {
		if (value instanceof LocalAsrAcquireError) throw value;
		return value;
	});
}

export { classifyLocalAsrHttpStatus, classifyLocalAsrNetworkError, parseLocalAsrInstanceId, LOCAL_ASR_PROBE_INTERVAL_MS, LOCAL_ASR_PROBE_TIMEOUT_MS };
