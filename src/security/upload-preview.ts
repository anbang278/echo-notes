export interface UploadPreviewSettings {
	provider: string;
	baseUrl: string;
	model: string;
	analysisEnabled: boolean;
	analysisProvider: string;
	analysisBaseUrl: string;
	analysisModel: string;
}

export interface UploadPreviewAudioFile {
	name: string;
	path: string;
	stat: {
		size: number;
	};
}

export interface UploadPreviewRow {
	label: string;
	value: string;
}

export interface UploadPreview {
	rows: UploadPreviewRow[];
	warnings: string[];
}

export function buildTranscriptionUploadPreview(
	settings: UploadPreviewSettings,
	audioFile: UploadPreviewAudioFile
): UploadPreview {
	const warnings: string[] = [];
	if (isInsecureRemoteBaseUrl(settings.baseUrl)) {
		warnings.push("当前转写 Base URL 使用 HTTP 且不是本地地址，音频可能通过未加密连接发送。");
	}
	if (settings.analysisEnabled && isInsecureRemoteBaseUrl(settings.analysisBaseUrl)) {
		warnings.push("当前 AI 分析 Base URL 使用 HTTP 且不是本地地址，转写文本可能通过未加密连接发送。");
	}

	const rows: UploadPreviewRow[] = [
		{ label: "音频文件", value: audioFile.name },
		{ label: "Vault 路径", value: audioFile.path },
		{ label: "文件大小", value: formatFileSize(audioFile.stat.size) },
		{ label: "转写 Provider", value: settings.provider },
		{ label: "转写 Base URL", value: settings.baseUrl || "未配置" },
		{ label: "转写模型", value: settings.model || "未配置" }
	];

	if (settings.analysisEnabled) {
		rows.push(
			{ label: "AI 分析 Provider", value: settings.analysisProvider },
			{ label: "AI 分析 Base URL", value: settings.analysisBaseUrl || "未配置" },
			{ label: "AI 分析模型", value: settings.analysisModel || "未配置" }
		);
	}

	return {
		rows,
		warnings
	};
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}

	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	for (const unit of units) {
		if (value < 1024 || unit === units[units.length - 1]) {
			return `${formatDecimal(value)} ${unit}`;
		}
		value /= 1024;
	}

	return `${bytes} B`;
}

export function isInsecureRemoteBaseUrl(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "http:") {
			return false;
		}

		return !isLocalHost(url.hostname);
	} catch {
		return false;
	}
}

function isLocalHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized.endsWith(".local");
}

function formatDecimal(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
