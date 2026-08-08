import { FuzzySuggestModal, type App, type TFile } from "obsidian";

class GettingStartedTranscriptPicker extends FuzzySuggestModal<TFile> {
	private readonly files: TFile[];
	private readonly resolveSelection: (file: TFile | null) => void;
	private settled = false;

	constructor(
		app: App,
		files: TFile[],
		resolveSelection: (file: TFile | null) => void
	) {
		super(app);
		this.files = files;
		this.resolveSelection = resolveSelection;
		this.setPlaceholder("选择一份 Echo Notes 转写稿");
		this.setInstructions([
			{ command: "↑↓", purpose: "选择" },
			{ command: "↵", purpose: "确认" },
			{ command: "esc", purpose: "取消" }
		]);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.finish(file);
	}

	onClose(): void {
		super.onClose();
		this.finish(null);
	}

	private finish(file: TFile | null): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolveSelection(file);
	}
}

export function selectGettingStartedTranscript(
	app: App,
	files: TFile[]
): Promise<TFile | null> {
	return new Promise((resolve) => {
		new GettingStartedTranscriptPicker(app, files, resolve).open();
	});
}
