import * as vscode from 'vscode';
import { importPrefix, smartCandidates, type EditingOptions } from './context';

const cache = new WeakMap<vscode.TextDocument, {
  version: number; offset: number; settings: string;
  imported: ReturnType<typeof importPrefix>; word: string;
  candidates: ReturnType<typeof smartCandidates>;
}>();
/** Shared by local completion and LSP duplicate filtering; cached lexical work per position/version/settings. */
export function completionContext(document: vscode.TextDocument, position: vscode.Position, options: EditingOptions): NonNullable<ReturnType<typeof cache.get>> {
  const offset = document.offsetAt(position);
  const settings = `${options.smartSnippets}:${options.autoInsertParentheses}`;
  const previous = cache.get(document);
  if (previous?.version === document.version && previous.offset === offset && previous.settings === settings) { return previous; }
  const text = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
  const word = /[\p{L}_][\p{L}\p{N}_]*$/u.exec(text)?.[0] ?? '';
  const result = {
    version: document.version, offset, settings, word, imported: importPrefix(text),
    candidates: smartCandidates(text.slice(0, text.length - word.length), word, document.lineAt(position.line).text.slice(position.character), options),
  };
  cache.set(document, result);
  return result;
}
