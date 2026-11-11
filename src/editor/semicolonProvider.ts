import * as vscode from 'vscode';
import { semicolonOffset } from './context';
import { timed } from './performance';

/** Native on-type formatting preserves Enter, indentation and undo; no keybinding. */
export class MioSemicolonProvider implements vscode.OnTypeFormattingEditProvider {
  provideOnTypeFormattingEdits(document: vscode.TextDocument, position: vscode.Position, ch: string): vscode.TextEdit[] {
    return timed('semicolon', () => {
      if (ch !== '\n' || position.line === 0 || !vscode.workspace.getConfiguration('mio', document.uri).get('editing.autoInsertSemicolon', false)) { return []; }
      const editor = vscode.window.activeTextEditor;
      if (editor?.document !== document || editor.selections.length !== 1 || !editor.selection.isEmpty) { return []; }
      // A newline in the middle of a statement or a snippet body is not a completed statement.
      if (document.lineAt(position.line).text.trim()) { return []; }
      const previous = document.lineAt(position.line - 1);
      const text = document.getText(new vscode.Range(new vscode.Position(0, 0), previous.range.end));
      const offset = semicolonOffset(text);
      return offset === undefined ? [] : [vscode.TextEdit.insert(document.positionAt(offset), ';')];
    });
  }
}
