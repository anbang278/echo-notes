import { TranscriptionError } from "../providers/transcription-provider";
import { LOCAL_UPLOAD_CHUNK_BYTES } from "./local-http";
import { verifyLocalSource, type LocalSourceIdentity, type LocalVaultFileHandle } from "./local-desktop-files";

export interface StreamingMultipart {
	contentType: string;
	contentLength: number;
	headerBytes: number;
	body: AsyncIterable<Uint8Array>;
}

/** Multipart envelope is small; audio is pulled only when the previous socket write drained. */
export function createStreamingMultipart(
	handle: LocalVaultFileHandle,
	source: LocalSourceIdentity,
	options: { model: string; language: string; fileName: string; mediaType: string; signal?: AbortSignal }
): StreamingMultipart {
	const boundary = `----EchoNotes${crypto.randomUUID().replace(/-/g, "")}`;
	const encoder = new TextEncoder();
	const fields: Array<[string, string]> = [["model", options.model]];
	if (options.language !== "auto" && options.language) fields.push(["language", options.language]);
	const fileName = options.fileName.replace(/[\r\n"\\]/g, "_");
	let header = fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("");
	header += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${options.mediaType}\r\n\r\n`;
	const prefix = encoder.encode(header);
	const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
	const contentLength = prefix.byteLength + source.sourceSize + suffix.byteLength;
	if (!Number.isSafeInteger(contentLength) || prefix.byteLength > LOCAL_UPLOAD_CHUNK_BYTES) {
		throw new TranscriptionError("unsupported_audio", "音频长度或模型配置无效。");
	}
	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		contentLength,
		headerBytes: prefix.byteLength,
		body: (async function* () {
			await verifyLocalSource(handle, source);
			yield prefix;
			for (let offset = 0; offset < source.sourceSize; offset += LOCAL_UPLOAD_CHUNK_BYTES) {
				if (options.signal?.aborted) throw new TranscriptionError("cancelled", "客户端连接已中断；标准接口的服务端结果未知。");
				await verifyLocalSource(handle, source);
				const length = Math.min(LOCAL_UPLOAD_CHUNK_BYTES, source.sourceSize - offset);
				const chunk = await handle.readRange(offset, length);
				if (chunk.byteLength !== length) throw new TranscriptionError("source_changed", "音频读取不完整，请重新发起转写。");
				yield chunk;
			}
			await verifyLocalSource(handle, source);
			yield suffix;
		})()
	};
}
