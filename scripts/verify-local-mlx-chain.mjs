import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";

/** Explicit real-service acceptance, never used implicitly by ordinary npm package. */
export async function verifyRealLocalMLXChain(page, vault, outputDir) {
	const fixture = process.env.ECHO_NOTES_REAL_LOCAL_FIXTURE;
	if (!fixture) return undefined;
	assert(path.isAbsolute(fixture) && !fixture.split(path.sep).includes("lifeos-obsidian"), "真实验收只接受显式非生产样本路径");
	const sha = createHash("sha256");
	for await (const chunk of createReadStream(fixture)) sha.update(chunk);
	const sourceSha256 = sha.digest("hex");
	assert.equal(sourceSha256, "f5a719e6b9d9d69b3f00d0447922c09e71320724afeefd3070d25a64b7f1dcf1", "仅允许已批准的公开自然会议输入");
	const audioPath = "local-real-meeting.wav";
	// User explicitly curtailed long stress testing: only a 12.4-second public excerpt.
	execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-ss", "60", "-i", fixture, "-t", "12.4", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path.join(vault, audioPath)], { timeout: 30000 });
	await page.waitForFunction(file => Boolean(window.app.vault.getAbstractFileByPath(file)), audioPath, { timeout: 30000 });
	const reports = [];
	await mkdir(path.join(outputDir, "real-local"), { recursive: true });
	for (const [mode, model] of [["ordinary", "mlx-community/Qwen3-ASR-0.6B-8bit"], ["diarized", "local/qwen3-asr-0.6b-sortformer-4spk"]]) {
		const started = Date.now();
		await page.evaluate(async ({ audioPath, model }) => {
			const plugin = window.app.plugins.plugins["echo-notes"];
			plugin.settings.offlineTranscription = { provider: "local-openai-compatible", baseUrl: "http://127.0.0.1:18081/v1", model, language: "auto" };
			plugin.settings.confirmBeforeTranscription = false;
			plugin.settings.analysisEnabled = false;
			await plugin.saveSettings();
			globalThis.__realLocalOutcome = null;
			globalThis.__realLocalRun = plugin.processAudioToTranscript(window.app.vault.getAbstractFileByPath(audioPath), undefined, { forceTranscription: true })
				.then(result => { globalThis.__realLocalOutcome = result ? { outputPath: result.transcriptFile.path, eligible: result.analysisEligible } : { error: "no-result" }; })
				.catch(error => { globalThis.__realLocalOutcome = { error: error.message }; });
		}, { audioPath, model });
		let lastStage;
		let outcome;
		while (Date.now() - started < 5 * 60 * 1000) {
			const current = await page.evaluate(audioPath => ({
				task: window.app.plugins.plugins["echo-notes"].taskCenter.getTasks().find(t => t.targetPath === audioPath), outcome: globalThis.__realLocalOutcome
			}), audioPath);
			if (lastStage !== current.task?.stage) { lastStage = current.task?.stage; console.log(`真实插件 ${mode}: ${lastStage}`); }
			if (current.outcome) { outcome = current; break; }
			await page.waitForTimeout(3000);
		}
		assert(outcome && !outcome.outcome.error && outcome.task.status === "success", JSON.stringify(outcome));
		assert.equal(outcome.task.localTask, undefined, "保存完成后应清理本地任务结果");
		assert(outcome.outcome.eligible, "成功转写应可供后续分析");
		const transcript = await readFile(path.join(vault, outcome.outcome.outputPath), "utf8");
		assert.match(transcript, /^status: done/m);
		const body = transcript.split(/^# .+$/m).slice(1).join("\n").replace(/<!--[^]*?-->/g, "").trim();
		assert(body.length >= 8, "短片段应保存实际转写正文");
		await writeFile(path.join(outputDir, "real-local", `${mode}.transcript.md`), transcript);
		reports.push({ mode, model, status: "PASS", durationMs: Date.now() - started, audioBytes: (await stat(path.join(vault, audioPath))).size,
			sourceSha256, outputCharacters: transcript.length, outputSha256: createHash("sha256").update(transcript).digest("hex"),
			outputPath: `real-local/${mode}.transcript.md`, taskStage: outcome.task.stage, resultCleanedAfterSave: true });
	}
	const report = { status: "PASS", source: "public-natural-meeting-excerpt", sourceStartSeconds: 60, durationSeconds: 12.4, reports, generatedAt: new Date().toISOString() };
	await writeFile(path.join(outputDir, "real-local", "report.json"), JSON.stringify(report, null, 2));
	return report;
}
