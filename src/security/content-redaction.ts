export function redactAnalysisInputText(input: string): string {
	return input
		.replace(/((?:客户名|客户|联系人|姓名|公司名|公司|企业|地址)\s*[:：]\s*)[^\n,，。；;]+/g, "$1[REDACTED_FIELD]")
		.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
		.replace(/\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, "[REDACTED_ID]")
		.replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d{4}){2}(?!\d)/g, "[REDACTED_PHONE]")
		.replace(/(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/g, "[REDACTED_PHONE]")
		.replace(/(?<!\d)\d{12,19}(?!\d)/g, "[REDACTED_NUMBER]")
		.replace(/(?:人民币|RMB|￥|¥)\s*\d+(?:,\d{3})*(?:\.\d+)?/gi, "[REDACTED_AMOUNT]")
		.replace(/(?<!\d)\d+(?:,\d{3})*(?:\.\d+)?\s*(?:万元|元|万|k|K)/g, "[REDACTED_AMOUNT]")
		.replace(/[\u4e00-\u9fa5]{2,}(?:省|市|区|县)[\u4e00-\u9fa5A-Za-z0-9\s-]{2,}(?:路|街|巷|弄|号|室)/g, "[REDACTED_ADDRESS]");
}
