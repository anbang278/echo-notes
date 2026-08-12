export interface DiagnosticFolderRevealShell {
	showItemInFolder(fullPath: string): void;
}

export interface DiagnosticFolderRevealAdapter {
	getFullPath(normalizedPath: string): string;
}

export interface DiagnosticFolderRevealRequest {
	shell: DiagnosticFolderRevealShell;
	adapter: DiagnosticFolderRevealAdapter;
	vaultPath: string;
}

/**
 * Electron 会按当前系统调用 Finder 或文件资源管理器，并选中目标文件。
 * 该模块不引入 Electron，便于移动端安全加载并可独立测试。
 */
export function getDiagnosticFolderRevealLabel(platform: string): string {
	if (platform === "darwin") {
		return "在访达中打开";
	}
	if (platform === "win32") {
		return "在文件资源管理器中打开";
	}
	return "在文件管理器中打开";
}

export function revealDiagnosticExportInFolder(request: DiagnosticFolderRevealRequest): void {
	const fullPath = request.adapter.getFullPath(request.vaultPath);
	if (!fullPath) {
		throw new Error("无法获取诊断包所在的本地文件夹");
	}
	request.shell.showItemInFolder(fullPath);
}
