import * as vscode from 'vscode';
import { completionContext } from './completionContext';
import { ImportIndex } from './imports';
import { timed } from './performance';

export class MioCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  readonly imports = new ImportIndex();
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionList {
    return timed('localCompletion', () => {
      const config = vscode.workspace.getConfiguration('mio', document.uri);
      const context = completionContext(document, position, {
        smartSnippets: config.get('editing.smartSnippets', true),
        autoInsertParentheses: config.get('editing.autoInsertParentheses', true),
      });
      const imported = context.imported;
      const items: vscode.CompletionItem[] = [];
      if (imported && config.get('completion.importPaths', true)) {
        // Replace the whole path (also its right-hand suffix), never delimiters.
        const after = document.lineAt(position.line).text.slice(position.character);
        const suffix = /^[^"\r\n]*/u.exec(after)?.[0] ?? '';
        const range = new vscode.Range(document.positionAt(imported.start), position.translate(0, suffix.length));
        for (const module of this.imports.candidates(imported.prefix)) {
          const item = new vscode.CompletionItem(module, vscode.CompletionItemKind.Module);
          item.range = range; item.insertText = module; item.detail = 'Mio local import path (v2.1.2 catalog / workspace)';
          items.push(item);
        }
        return new vscode.CompletionList(items, true);
      }
      // Native snippets are safe at multiple cursors only when their contexts match. Decline.
      const editor = vscode.window.activeTextEditor;
      if (editor?.document === document && editor.selections.length !== 1) { return new vscode.CompletionList([], false); }
      for (const candidate of context.candidates) {
        const item = new vscode.CompletionItem(candidate.label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(candidate.insert);
        item.range = new vscode.Range(position.translate(0, -context.word.length), position);
        item.detail = 'Mio smart snippet'; item.sortText = '0' + candidate.label;
        items.push(item);
      }
      return new vscode.CompletionList(items, false);
    });
  }
  dispose(): void { this.imports.dispose(); }
}
