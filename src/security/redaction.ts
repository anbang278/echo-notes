const DEFAULT_MAX_LENGTH = 800;

export function sanitizeSensitiveText(input: string, maxLength = DEFAULT_MAX_LENGTH): string {
	const sanitized = input
		.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',;\\]+/gi, "$1[REDACTED]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
		.replace(/(["']?(?:api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2")
		.replace(/data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (match) => {
			const prefix = match.slice(0, match.indexOf(",") + 1);
			return `${prefix}[REDACTED]`;
		})
		.replace(/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, "[REDACTED_LONG_TOKEN]");

	if (sanitized.length <= maxLength) {
		return sanitized;
	}

	return `${sanitized.slice(0, maxLength)}...（已截断）`;
}

export function getSanitizedErrorMessage(error: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
	const message = error instanceof Error ? error.message : String(error);
	return sanitizeSensitiveText(message, maxLength);
}

export function sanitizeLogValue(value: unknown): unknown {
	if (typeof value === "string") {
		return sanitizeSensitiveText(value, 1200);
	}

	if (value instanceof Error) {
		return {
			name: value.name,
			message: sanitizeSensitiveText(value.message, 1200),
			stack: value.stack ? sanitizeSensitiveText(value.stack, 2000) : undefined
		};
	}

	return value;
}
