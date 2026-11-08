import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Exercise the running plugin's stop entry point with disposable in-memory devices. */
export async function verifyWorkspaceRealtimeStop(page, { pluginId, validationVault, outputDir }) {
	assert(validationVault && /echo-notes-settings-ui-[^/\\]+[/\\]vault$/.test(validationVault), "实时停止验证需要明确的隔离 Vault");
	const report = { status: "RUNNING", validationScope: "isolated-obsidian-realtime-stop-entry", cases: [] };
	try {
		report.cases = await page.evaluate(async ({ id, expectedVault }) => {
			const app = window.app;
			if (app.vault.adapter.getBasePath() !== expectedVault) throw new Error("实时停止验证的 Vault 与隔离目标不一致");
			const plugin = app.plugins.plugins[id];
			if (!plugin || typeof plugin.stopRealtimeTranscription !== "function") throw new Error("实时停止入口未加载");
			if (plugin.activeRealtimeRecording || plugin.realtimeStarting || plugin.realtimeStatusTimer !== null) throw new Error("实时停止验证要求没有运行中的录音");
			const check = (condition, message) => { if (!condition) throw new Error(message); };
			const definitions = [
				{ name: "normal-clock", wallOffset: 0, timingExpected: true },
				{ name: "forward-clock-jump", wallOffset: -3_600_000 },
				{ name: "backward-clock-jump", wallOffset: 3_600_000 },
				{ name: "recording-save-registration-fails", wallOffset: 0, timingExpected: true, registrationFails: true, pcmFails: true },
				{ name: "missing-recording-identity", wallOffset: 0, missingRecordingId: true }
			];
			const results = [];
			for (const definition of definitions) {
				const root = `实时停止隔离构造-${crypto.randomUUID()}`;
				const audioFile = { path: `${root}/recording.wav`, name: "recording.wav" };
				const sourceNote = { path: `${root}/note.md`, name: "note.md" };
				const transcriptFile = { path: `${root}/recording.transcript.md`, name: "recording.transcript.md" };
				const calls = { saved: [], sources: [], failedWrites: 0, pendingWrites: 0, trackStops: 0, asrFinishes: 0, pcmStops: 0, tasks: [], completions: [] };
				const restorers = [];
				const replace = (owner, name, value) => {
					const descriptor = Object.getOwnPropertyDescriptor(owner, name);
					owner[name] = value;
					restorers.push(() => { if (descriptor) Object.defineProperty(owner, name, descriptor); else delete owner[name]; });
				};
				const recording = {
					catalogRecordingId: definition.missingRecordingId ? undefined : `${root}-recording`,
					audioFile, sourceNote, transcriptFile,
					transcriptService: {
						async writeTranscribingTranscript() { calls.pendingWrites++; return transcriptFile; },
						async writeFailedTranscript() { calls.failedWrites++; return transcriptFile; },
						async writeSuccessTranscript() { throw new Error("构造失败 ASR 意外进入成功写入分支"); }
					},
					provider: "isolated-stub", model: "isolated-stub",
					mediaStream: { getTracks: () => [{ stop() { calls.trackStops++; } }] },
					mediaRecorder: { async stop() { return 44; } },
					pcmCapture: { async stop() { calls.pcmStops++; if (definition.pcmFails) throw new Error("isolated PCM failure"); return null; } },
					agentPlanSession: {
						pushPcm() { throw new Error("构造 PCM 不应产生剩余音频"); },
						async finish() { calls.asrFinishes++; throw new Error("isolated ASR failure"); }
					},
					startedAt: Date.now() - 5000 + definition.wallOffset,
					startedMonotonic: performance.now() - 5000,
					streamingState: { text: "", provisionalText: "", utterances: [] },
					stopping: false, writeQueue: Promise.resolve(),
					taskId: `${root}-task`, diagnosticSessionId: `${root}-diagnostic`, diagnosticChainId: `${root}-chain`
				};
				try {
					replace(plugin.meetingWorkspace, "recordingSaved", async (...args) => {
						calls.saved.push(args);
						if (definition.registrationFails) throw new Error("isolated recordingSaved failure");
					});
					replace(plugin.meetingWorkspace, "registerTranscript", async (...args) => { calls.sources.push(args); return `${root}/meeting.md`; });
					replace(plugin.taskCenter, "updateTask", (...args) => { calls.tasks.push(args); });
					replace(plugin.diagnostics, "complete", (...args) => { calls.completions.push(args); });
					plugin.realtimeAudioPaths.add(audioFile.path);
					plugin.activeRealtimeRecording = recording;
					await plugin.stopRealtimeTranscription();
					const context = `stopRealtimeTranscription/${definition.name}`;
					check(calls.saved.length === (definition.missingRecordingId ? 0 : 1), `${context} 录音登记次数错误`);
					if (!definition.missingRecordingId) {
						const args = calls.saved[0];
						check(args[0] === recording.catalogRecordingId && args[1] === audioFile.path, `${context} 稳定录音身份或音频路径错误`);
						if (definition.timingExpected) check(Number.isFinite(args[2]) && args[3] >= 5000 && args[3] < 7000, `${context} 正常时序未保留单调时钟时长`);
						else check(args[2] === undefined && args[3] === undefined, `${context} 墙钟跳变仍把结束时间或时长登记为确认值`);
					}
					check(calls.sources.length === 1 && calls.sources[0][0] === transcriptFile.path && calls.sources[0][1] === audioFile.path, `${context} 未独立登记转写来源`);
					check(calls.failedWrites === 1 && calls.pendingWrites === 1, `${context} 未完成真实停止入口的转写写入尾部`);
					check(calls.trackStops === 1 && calls.pcmStops === 1, `${context} 未结束构造采集设备`);
					check(calls.asrFinishes === (definition.pcmFails ? 0 : 1), `${context} ASR 失败路径不正确`);
					check(calls.tasks.length === 1 && calls.tasks[0][1].status === "failed" && calls.completions.length === 1, `${context} 未完成任务或诊断收尾`);
					check(plugin.activeRealtimeRecording === null && !plugin.realtimeAudioPaths.has(audioFile.path), `${context} 残留录音运行态`);
					check(recording.streamingState.processedSeconds >= 5 && recording.streamingState.processedSeconds < 7, `${context} 停止时长未使用单调时钟`);
					results.push({ name: definition.name, status: "PASS", timingForwarded: definition.timingExpected === true, sourceRegistered: true, stopTailCompleted: true });
				} finally {
					if (recording.writeTimer !== undefined) window.clearTimeout(recording.writeTimer);
					plugin.activeRealtimeRecording = null;
					plugin.realtimeAudioPaths.delete(audioFile.path);
					for (const restore of restorers.reverse()) restore();
					plugin.updateRealtimeUi();
				}
			}
			return results;
		}, { id: pluginId, expectedVault: validationVault });
		report.status = "PASS";
		return report;
	} catch (error) {
		report.status = "FAIL";
		report.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		report.checkedAt = new Date().toISOString();
		await mkdir(outputDir, { recursive: true });
		await writeFile(path.join(outputDir, "workspace-realtime-stop.json"), `${JSON.stringify(report, null, 2)}\n`);
	}
}
