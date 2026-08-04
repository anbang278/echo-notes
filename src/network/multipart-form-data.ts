export type MultipartFormDataPart =
	| {
			name: string;
			value: string;
	  }
	| {
			name: string;
			fileName: string;
			contentType: string;
			value: ArrayBuffer;
	  };

export function buildMultipartFormDataBody(
	boundary: string,
	parts: MultipartFormDataPart[]
): ArrayBuffer {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	for (const part of parts) {
		if (!("fileName" in part)) {
			chunks.push(
				encoder.encode(
					`--${boundary}\r\n` +
						`Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"\r\n\r\n` +
						`${part.value}\r\n`
				)
			);
			continue;
		}

		chunks.push(
			encoder.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"; filename="${createSafeUploadFileName(part.fileName)}"\r\n` +
					`Content-Type: ${part.contentType}\r\n\r\n`
			)
		);
		chunks.push(new Uint8Array(part.value));
		chunks.push(encoder.encode("\r\n"));
	}

	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const combined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return combined.buffer;
}

export function createSafeUploadFileName(fileName: string): string {
	const extension = /\.([A-Za-z0-9]{1,16})$/.exec(fileName)?.[1];
	return extension ? `audio.${extension.toLowerCase()}` : "audio";
}

function escapeHeaderValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
