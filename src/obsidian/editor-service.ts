import type { Editor, EditorPosition } from "obsidian";

export interface EditorTextRange {
	text: string;
	from: EditorPosition;
	to: EditorPosition;
	lineStart: number;
	lineEnd: number;
}

export class EditorService {
	getSelectionOrCurrentLine(editor: Editor): EditorTextRange {
		const selection = editor.getSelection();
		if (selection) {
			const from = editor.getCursor("from");
			const to = editor.getCursor("to");
			return {
				text: selection,
				from,
				to,
				lineStart: from.line,
				lineEnd: to.line
			};
		}

		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		return {
			text: line,
			from: {
				line: cursor.line,
				ch: 0
			},
			to: {
				line: cursor.line,
				ch: line.length
			},
			lineStart: cursor.line,
			lineEnd: cursor.line
		};
	}

	insertAfterLine(editor: Editor, lineNumber: number, text: string): void {
		const targetLine = Math.min(lineNumber, editor.lineCount() - 1);
		const targetLineText = editor.getLine(targetLine);
		editor.replaceRange(`\n${text}`, {
			line: targetLine,
			ch: targetLineText.length
		});
	}
}
