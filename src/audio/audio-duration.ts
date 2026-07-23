const DEFAULT_DURATION_PROBE_TIMEOUT_MS = 10000;

export async function probeAudioDurationSeconds(
	audioBuffer: ArrayBuffer,
	mimeType: string,
	timeoutMs = DEFAULT_DURATION_PROBE_TIMEOUT_MS
): Promise<number | undefined> {
	if (
		typeof document === "undefined" ||
		typeof URL === "undefined" ||
		typeof URL.createObjectURL !== "function"
	) {
		return undefined;
	}

	const audio = document.createElement("audio");
	const objectUrl = URL.createObjectURL(new Blob([audioBuffer], { type: mimeType }));
	audio.preload = "metadata";

	try {
		return await new Promise<number | undefined>((resolve) => {
			let settled = false;
			const finish = (duration?: number) => {
				if (settled) {
					return;
				}
				settled = true;
				globalThis.clearTimeout(timeoutId);
				resolve(
					duration !== undefined && Number.isFinite(duration) && duration > 0
						? duration
						: undefined
				);
			};
			const timeoutId = globalThis.setTimeout(() => finish(), Math.max(250, timeoutMs));
			audio.addEventListener("loadedmetadata", () => finish(audio.duration), { once: true });
			audio.addEventListener("durationchange", () => {
				if (Number.isFinite(audio.duration) && audio.duration > 0) {
					finish(audio.duration);
				}
			});
			audio.addEventListener("error", () => finish(), { once: true });
			audio.src = objectUrl;
			audio.load();
		});
	} catch {
		return undefined;
	} finally {
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		URL.revokeObjectURL(objectUrl);
	}
}
