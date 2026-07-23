export class SequentialBlobWriteQueue {
	private writeBytes: (bytes: Uint8Array) => Promise<void>;
	private appendQueue = Promise.resolve();
	private appendError: Error | null = null;
	private byteCount = 0;

	constructor(writeBytes: (bytes: Uint8Array) => Promise<void>) {
		this.writeBytes = writeBytes;
	}

	append(blob: Blob): void {
		if (blob.size === 0 || this.appendError) {
			return;
		}
		this.appendQueue = this.appendQueue
			.then(async () => {
				const bytes = new Uint8Array(await blob.arrayBuffer());
				await this.writeBytes(bytes);
				this.byteCount += bytes.byteLength;
			})
			.catch((error) => {
				this.appendError = error instanceof Error ? error : new Error(String(error));
			});
	}

	async finish(): Promise<number> {
		await this.appendQueue;
		if (this.appendError) {
			throw this.appendError;
		}
		return this.byteCount;
	}
}
