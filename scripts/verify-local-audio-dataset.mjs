import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	isPathInsideOrEqual,
	loadLocalAudioDataset,
	selectLocalAudioDatasetCases
} from "./local-audio-dataset.mjs";

const execFileAsync = promisify(execFile);
const ffprobeOutputLimit = 1024 * 1024;

if (isDirectExecution()) {
	await main();
}

async function main() {
	const projectRoot = process.cwd();
	const dataset = await loadLocalAudioDataset({ projectRoot });
	await assertDatasetIgnoredByGit(projectRoot, dataset);
	const selectedCases = selectLocalAudioDatasetCases(dataset, process.argv.slice(2));
	const results = [];

	for (const entry of selectedCases) {
		const probe = await probeAudioBytes(entry.verifiedBytes, entry.id);
		const expectedDuration = entry.expected?.durationSeconds;
		const toleranceSeconds = entry.expected?.durationToleranceSeconds ?? 0.2;
		if (
			expectedDuration !== undefined &&
			Math.abs(probe.durationSeconds - expectedDuration) > toleranceSeconds
		) {
			throw new Error(
				`样本时长不匹配：${entry.id}，预期 ${expectedDuration} 秒，实际 ${probe.durationSeconds} 秒`
			);
		}
		results.push({
			ID: entry.id,
			文件名: entry.file,
			编码: probe.codec,
			声道: probe.channels,
			时长秒: probe.durationSeconds.toFixed(3),
			大小MB: (entry.bytes / 1024 / 1024).toFixed(2),
			标签: entry.tags.join(",")
		});
	}

	console.log(`本地音频数据集离线校验通过：${dataset.root}`);
	console.table(results);
}

export function shouldCheckGitIgnore(root, filePath) {
	return isPathInsideOrEqual(root, filePath);
}

export async function probeAudioBytes(audioBytes, label = "unknown") {
	const stdout = await runFfprobe(audioBytes, label);
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(`ffprobe 返回的 JSON 无效：${label}`, { cause: error });
	}
	const stream = parsed.streams?.find((candidate) => candidate.codec_type === "audio");
	const durationSeconds = Number(parsed.format?.duration);
	if (
		!stream?.codec_name ||
		!Number.isInteger(stream.channels) ||
		stream.channels <= 0 ||
		!Number.isFinite(durationSeconds) ||
		durationSeconds <= 0
	) {
		throw new Error(`ffprobe 返回的音频元数据不完整：${label}`);
	}
	return {
		codec: stream.codec_name,
		channels: stream.channels,
		durationSeconds
	};
}

async function assertDatasetIgnoredByGit(projectRoot, dataset) {
	if (!shouldCheckGitIgnore(projectRoot, dataset.root)) {
		return;
	}
	for (const filePath of [dataset.manifestPath, ...dataset.cases.map((entry) => entry.absolutePath)]) {
		await assertIgnoredByGit(projectRoot, filePath);
	}
}

async function assertIgnoredByGit(projectRoot, filePath) {
	try {
		await execFileAsync("git", ["check-ignore", "-q", filePath], { cwd: projectRoot });
	} catch {
		throw new Error(`本地数据集文件未被 Git 忽略，已停止验证：${filePath}`);
	}
}

function runFfprobe(audioBytes, label) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"format=duration:stream=codec_type,codec_name,channels",
				"-of",
				"json",
				"-i",
				"pipe:0"
			],
			{ stdio: ["pipe", "pipe", "pipe"] }
		);
		const stdoutChunks = [];
		const stderrChunks = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;

		const fail = (error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
		};
		const collect = (chunk, chunks, currentBytes) => {
			const nextBytes = currentBytes + chunk.byteLength;
			if (nextBytes > ffprobeOutputLimit) {
				child.kill("SIGKILL");
				fail(new Error(`ffprobe 输出超过限制：${label}`));
				return currentBytes;
			}
			chunks.push(chunk);
			return nextBytes;
		};

		child.stdout.on("data", (chunk) => {
			stdoutBytes = collect(chunk, stdoutChunks, stdoutBytes);
		});
		child.stderr.on("data", (chunk) => {
			stderrBytes = collect(chunk, stderrChunks, stderrBytes);
		});
		child.once("error", (error) => {
			fail(new Error(`无法启动 ffprobe：${label}`, { cause: error }));
		});
		child.stdin.once("error", (error) => {
			if (error.code !== "EPIPE") {
				fail(new Error(`无法向 ffprobe 写入已校验音频：${label}`, { cause: error }));
			}
		});
		child.once("close", (code, signal) => {
			if (settled) {
				return;
			}
			if (code !== 0) {
				const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 500);
				fail(new Error(
					`ffprobe 无法读取已校验音频：${label}` +
					`${signal ? `，信号 ${signal}` : `，退出码 ${code ?? "未知"}`}` +
					`${stderr ? `，${stderr}` : ""}`
				));
				return;
			}
			settled = true;
			resolve(Buffer.concat(stdoutChunks).toString("utf8"));
		});
		child.stdin.end(Buffer.from(audioBytes));
	});
}

function isDirectExecution() {
	return Boolean(
		process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
	);
}
