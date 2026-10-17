import type { LocalAsrCommandHandle, LocalAsrCommandRunner } from "./lifecycle-contracts";

/**
 * 惰性桌面命令适配器：先检查桌面环境，再运行时 require child_process/os。
 * 禁止顶层 Node/Electron 导入；移动端调用返回 rejected Promise，不触发模块加载。
 * 命令原样交 shell，无任何插值；消耗但不记录 stdout/stderr。
 */
export function createDesktopCommandRunner(): LocalAsrCommandRunner {
	return async (spec) => {
		if (typeof window === "undefined") throw new Error("仅桌面版支持本地服务命令执行。");
		const runtime = window as Window & { require?: (name: string) => unknown };
		if (typeof runtime.require !== "function") throw new Error("仅桌面版支持本地服务命令执行。");
		let childProcess: typeof import("child_process");
		let os: typeof import("os");
		try {
			childProcess = runtime.require("child_process") as typeof import("child_process");
			os = runtime.require("os") as typeof import("os");
		} catch {
			throw new Error("无法加载桌面命令执行环境。");
		}
		if (typeof childProcess?.spawn !== "function" || typeof os?.homedir !== "function") {
			throw new Error("桌面命令执行环境不可用。");
		}
		return spawnManaged(childProcess, os, spec);
	};
}

function spawnManaged(
	childProcess: typeof import("child_process"),
	os: typeof import("os"),
	spec: { command: string; workingDirectory: string; timeoutMs: number; signal?: AbortSignal }
): LocalAsrCommandHandle {
	const platform = (window as Window & { activeWindow?: { process?: { platform?: unknown } } }).activeWindow?.process?.platform;
	const isWindows = platform === "win32";
	const comSpec = (window as Window & { activeWindow?: { process?: { env?: { ComSpec?: unknown } } } }).activeWindow?.process?.env?.ComSpec;
	const shell = isWindows ? (typeof comSpec === "string" && comSpec.trim() ? comSpec : "cmd.exe") : "/bin/sh";
	const args = isWindows ? ["/d", "/s", "/c", spec.command] : ["-c", spec.command];
	const child = childProcess.spawn(shell, args, {
		cwd: spec.workingDirectory.trim() || os.homedir(),
		stdio: ["ignore", "ignore", "ignore"],
		detached: false,
		windowsHide: true
	});
	let settled = false;
	const timeoutHandle = registerCommandTimeout(child, isWindows, spec.timeoutMs);
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		const finish = (code: number | null, signal: string | null) => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeoutHandle);
			resolve({ code, signal });
		};
		child.once("error", () => finish(null, null));
		child.once("exit", (code, signal) => finish(code, signal));
	});
	const abort = () => {
		if (!settled) {
			try { child.kill(isWindows ? undefined : "SIGTERM"); } catch { /* already exited */ }
		}
	};
	spec.signal?.addEventListener("abort", abort, { once: true });
	void exited.finally(() => spec.signal?.removeEventListener("abort", abort));
	return { cancel: abort, exited };
}

/** 超时只终止本次启动命令句柄；无 broad kill。 */
function registerCommandTimeout(
	child: import("child_process").ChildProcess,
	isWindows: boolean,
	timeoutMs: number
): number {
	return window.setTimeout(() => {
		try { child.kill(isWindows ? undefined : "SIGTERM"); } catch { /* already exited */ }
	}, timeoutMs);
}
