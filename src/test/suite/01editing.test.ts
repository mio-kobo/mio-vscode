import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MioCompletionProvider } from '../../editor/completionProvider';
import { MioSemicolonProvider } from '../../editor/semicolonProvider';
import { MioPushDiagnostics } from '../../diagnostics/pushDiagnostics';
import { MioDiagnosticManager } from '../../diagnostics/diagnosticManager';
import { MioCliService } from '../../cli/cliService';
import type { ProcessRunner, ProcessRunResult } from '../../cli/processRunner';
async function editorCommand(command: string, args?: unknown): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await new Promise(resolve => setTimeout(resolve, 50));
  await vscode.commands.executeCommand(command, args);
  // Editor commands run in the renderer; wait for mirrored selections and undo state.
  await new Promise(resolve => setTimeout(resolve, 40));
}
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
async function select(editor: vscode.TextEditor, selection: vscode.Selection): Promise<void> {
  if (editor.selection.isEqual(selection)) { return; }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { listener.dispose(); reject(new Error('selection acknowledgement timeout')); }, 5000);
    const listener = vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor.document === editor.document && event.selections[0]?.isEqual(selection)) {
        clearTimeout(timeout); listener.dispose(); resolve();
      }
    });
    editor.selection = selection;
  });
}
async function open(text: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({ language: 'mio', content: text });
  const editor = await vscode.window.showTextDocument(document);
  if (document.eol !== vscode.EndOfLine.LF) {
    await editor.edit(edit => edit.setEndOfLine(vscode.EndOfLine.LF));
  }
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  await delay(100);
  const end = document.positionAt(text.length);
  await select(editor, new vscode.Selection(end, end));
  await delay(100);
  return editor;
}
async function items(editor: vscode.TextEditor): Promise<vscode.CompletionItem[]> {
  const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor.document.uri, editor.selection.active);
  return list.items;
}
const label = (item: vscode.CompletionItem): string => typeof item.label === 'string' ? item.label : item.label.label;

suite('Native smart editing', () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension('exmikupro.mio-language-support')!.activate();
    await vscode.workspace.getConfiguration('mio').update('languageServer.enabled', false, vscode.ConfigurationTarget.Global);
    await delay(300);
  });
  teardown(async () => {
    await editorCommand('leaveSnippet');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });
  for (const name of ['moshi', 'aida', 'chant', 'len']) {
    test(`${name}: native cursor navigation, final position, undo and redo`, async () => {
      const editor = await open(name);
      editor.options = { insertSpaces: true, tabSize: 4 };
      const candidate = (await items(editor)).find(item => label(item) === name && item.detail === 'Mio smart snippet');
      assert.ok(candidate, `missing ${name}`);
      assert.ok(candidate.insertText instanceof vscode.SnippetString);
      assert.ok(candidate.range instanceof vscode.Range);
      await select(editor, new vscode.Selection(candidate.range.start, candidate.range.end));
      await editorCommand('editor.action.insertSnippet', { snippet: candidate.insertText.value });
      await delay(100);
      const expanded = editor.document.getText();
      assert.ok(expanded.startsWith(name + (['moshi', 'aida'].includes(name) ? ' (' : '(')));
      if (['moshi', 'aida'].includes(name)) {
        assert.equal(editor.document.getText(editor.selection), 'condition');
        await editorCommand('jumpToNextSnippetPlaceholder');
        assert.equal(editor.selection.active.line, 1);
        assert.equal(editor.selection.active.character, 4);
        await editorCommand('jumpToPrevSnippetPlaceholder');
        assert.equal(editor.document.getText(editor.selection), 'condition');
        await editorCommand('jumpToNextSnippetPlaceholder');
      } else { assert.equal(editor.selection.active.character, name.length + 1); }
      await editorCommand('jumpToNextSnippetPlaceholder');
      assert.equal(editor.document.offsetAt(editor.selection.active), expanded.length);
      await editorCommand('undo');
      assert.equal(editor.document.getText(), name);
      await editorCommand('redo');
      assert.equal(editor.document.getText(), expanded);
    });
  }
  test('provider preserves calls, identifiers, strings, comments and multiple cursors', async () => {
    const provider = new MioCompletionProvider();
    try {
      for (const [text, offset] of [['moshi () {}', 5], ['chant()', 5], ['len()', 3], ['// moshi', 8], ['"moshi', 6], ['my_moshi', 8], ['moshiName', 5]] as const) {
        const editor = await open(text);
        const list = provider.provideCompletionItems(editor.document, editor.document.positionAt(offset));
        assert.ok(!list.items.some(item => item.insertText instanceof vscode.SnippetString && item.insertText.value.includes('$1')), text);
      }
      const editor = await open('moshi\nmoshi');
      editor.selections = [new vscode.Selection(0, 5, 0, 5), new vscode.Selection(1, 5, 1, 5)];
      assert.equal(provider.provideCompletionItems(editor.document, new vscode.Position(1, 5)).items.length, 0);
    } finally { provider.dispose(); }
  });
  test('conversions and imports edit only the intended range', async () => {
    const editor = await open('kaku x = uint8');
    const candidate = (await items(editor)).find(item => label(item) === 'uint8')!;
    assert.equal((candidate.insertText as vscode.SnippetString).value, 'uint8($1)$0');
    await editor.insertSnippet(candidate.insertText as vscode.SnippetString, candidate.range as vscode.Range);
    assert.equal(editor.document.getText(), 'kaku x = uint8()');
    assert.equal(editor.selection.active.character, 15);
    const imported = await open('yobu "kiso/ma";');
    imported.selection = new vscode.Selection(0, 13, 0, 13);
    const math = (await items(imported)).find(item => label(item) === 'kiso/math')!;
    assert.ok(math);
    await imported.edit(edit => edit.replace(math.range as vscode.Range, math.insertText as string));
    assert.equal(imported.document.getText(), 'yobu "kiso/math";');
  });
  test('workspace Unicode packages refresh after create/delete and missing roots are harmless', async () => {
    const provider = new MioCompletionProvider();
    const folder = vscode.workspace.workspaceFolders![0].uri;
    const directory = vscode.Uri.joinPath(folder, '本地', '日本語');
    const file = vscode.Uri.joinPath(directory, 'module.mio');
    try {
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(file, Buffer.from('koukai waza value() -> int64 { kaesu 1; }'));
      await delay(300);
      await provider.imports.refresh();
      assert.ok(provider.imports.candidates('本地/').includes('本地/日本語'));
      assert.ok(provider.imports.candidates('kiso/net/').includes('kiso/net/tcp'));
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(folder, '本地'), { recursive: true });
      await delay(300);
      await provider.imports.refresh();
      assert.ok(!provider.imports.candidates('本地/').length);
    } finally { provider.dispose(); }
  });
  test('configured external Bunko roots and unavailable roots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-import-'));
    const packagePath = path.join(root, '外部', 'module');
    fs.mkdirSync(packagePath, { recursive: true });
    fs.writeFileSync(path.join(packagePath, 'module.mio'), 'koukai waza value() -> int64 { kaesu 1; }');
    const config = vscode.workspace.getConfiguration('mio');
    const old = config.get<string[]>('completion.bunkoRoots');
    await config.update('completion.bunkoRoots', [root, path.join(root, 'missing')], vscode.ConfigurationTarget.Global);
    const provider = new MioCompletionProvider();
    try {
      await provider.imports.refresh();
      assert.ok(provider.imports.candidates('外部/').includes('外部/module'));
      assert.ok(provider.imports.candidates('kiso/ma').includes('kiso/math'));
    } finally {
      provider.dispose();
      await config.update('completion.bunkoRoots', old, vscode.ConfigurationTarget.Global);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test('on-type semicolons preserve trailing comments and decline multiple cursors', async () => {
    await vscode.workspace.getConfiguration('mio').update('editing.autoInsertSemicolon', true, vscode.ConfigurationTarget.Global);
    try {
      const editor = await open('chant("hello") // comment\n');
      const provider = new MioSemicolonProvider();
      const edits = provider.provideOnTypeFormattingEdits(editor.document, editor.selection.active, '\n');
      assert.equal(edits.length, 1);
      await editor.edit(edit => edit.insert(edits[0].range.start, edits[0].newText));
      assert.equal(editor.document.getText(), 'chant("hello"); // comment\n');
      assert.equal(provider.provideOnTypeFormattingEdits(editor.document, editor.selection.active, '\n').length, 0);
      editor.selections = [new vscode.Selection(0, 0, 0, 0), new vscode.Selection(1, 0, 1, 0)];
      assert.equal(provider.provideOnTypeFormattingEdits(editor.document, new vscode.Position(1, 0), '\n').length, 0);
    } finally { await vscode.workspace.getConfiguration('mio').update('editing.autoInsertSemicolon', undefined, vscode.ConfigurationTarget.Global); }
  });
  test('real Enter formatting, paste, repeated Enter, undo and redo', async () => {
    const config = vscode.workspace.getConfiguration('mio');
    await config.update('editing.autoInsertSemicolon', true, vscode.ConfigurationTarget.Global);
    const editorConfig = vscode.workspace.getConfiguration('editor', { languageId: 'mio' });
    await editorConfig.update('formatOnType', true, vscode.ConfigurationTarget.Global, true);
    try {
      const editor = await open('kaku x = 42');
      await vscode.commands.executeCommand('type', { text: '\n' });
      for (let i = 0; i < 40 && !editor.document.getText().includes(';'); i++) { await delay(25); }
      assert.equal(editor.document.getText(), 'kaku x = 42;\n');
      assert.equal(editor.selection.active.line, 1);
      await editorCommand('undo');
      // VS Code records the on-type edit and Enter as native undo steps.
      if (editor.document.getText() === 'kaku x = 42\n') {
        await editorCommand('undo');
        assert.equal(editor.document.getText(), 'kaku x = 42');
        await editorCommand('redo');
      } else { assert.equal(editor.document.getText(), 'kaku x = 42'); }
      await editorCommand('redo');
      assert.equal(editor.document.getText(), 'kaku x = 42;\n');
      await vscode.commands.executeCommand('type', { text: '\n' });
      await delay(150);
      assert.equal(editor.document.getText(), 'kaku x = 42;\n\n');
      await editor.edit(edit => edit.insert(editor.selection.active, 'chant(1)\nchant(2)\n'));
      await delay(150);
      assert.ok(editor.document.getText().endsWith('chant(1)\nchant(2)\n'));
    } finally {
      await config.update('editing.autoInsertSemicolon', undefined, vscode.ConfigurationTarget.Global);
      await editorConfig.update('formatOnType', undefined, vscode.ConfigurationTarget.Global, true);
    }
  });
});

suite('Diagnostic response lifecycle', () => {
  test('versioned push diagnostics discard stale and out-of-order conversions, clear on edit/close', async () => {
    const editor = await open('kaku x = missing;');
    const document = editor.document;
    const push = new MioPushDiagnostics();
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'E0101 real syntax error');
    const params = { uri: document.uri.toString(), version: document.version, diagnostics: [] };
    try {
      let finish!: (value: vscode.Diagnostic[]) => void;
      const old = push.accept(params, () => new Promise(resolve => { finish = resolve; }), () => true);
      await push.accept(params, () => Promise.resolve([]), () => true);
      finish([diagnostic]); await old;
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      await push.accept(params, () => Promise.resolve([diagnostic]), () => true);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 1);
      await editor.edit(edit => edit.insert(new vscode.Position(0, 0), ' '));
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      await push.accept(params, () => Promise.resolve([diagnostic]), () => true);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      await push.accept({ ...params, version: document.version }, () => Promise.resolve([diagnostic]), () => true);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 1);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await delay(100);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
    } finally { push.dispose(); }
  });
  test('real LSP keeps E0101 for incomplete imports, resolves rapid edits, deduplicates completion and reopens documents', async () => {
    const config = vscode.workspace.getConfiguration('mio');
    await config.update('executablePath', process.env.MIO_TEST_CLI, vscode.ConfigurationTarget.Global);
    await delay(250);
    await config.update('languageServer.enabled', true, vscode.ConfigurationTarget.Global);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-import-diagnostics-'));
    const file = path.join(directory, 'test.mio'); fs.writeFileSync(file, 'yobu ');
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    const wait = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 15000;
      while (!predicate()) { assert.ok(Date.now() < deadline, 'timed out waiting for LSP'); await delay(25); }
    };
    try {
      await wait(() => vscode.languages.getDiagnostics(document.uri).some(d => String(d.code) === 'E0101'));
      const replace = async (text: string): Promise<void> => {
        await editor.edit(edit => edit.replace(new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), text));
      };
      for (const text of ['yobu "k', 'yobu "kiso/', 'waza main() -> unit { chant(missing); }', 'waza main() -> unit { chant(42); }']) { await replace(text); }
      await wait(() => vscode.languages.getDiagnostics(document.uri).length === 0);
      await delay(400);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      await replace('waza main() -> unit {\n  cha\n}');
      editor.selection = new vscode.Selection(1, 5, 1, 5);
      const candidates = await items(editor);
      assert.equal(candidates.filter(item => label(item) === 'chant').length, 1);
      await replace('waza main() -> unit { chant(missing); }');
      await wait(() => vscode.languages.getDiagnostics(document.uri).some(d => String(d.code) === 'E0201'));
      const uri = document.uri;
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await delay(200);
      assert.equal(vscode.languages.getDiagnostics(uri).length, 0);
      await config.update('languageServer.enabled', false, vscode.ConfigurationTarget.Global);
      await delay(500);
      assert.equal(vscode.languages.getDiagnostics(uri).length, 0);
      const reopened = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(reopened);
      await config.update('languageServer.enabled', true, vscode.ConfigurationTarget.Global);
      await wait(() => vscode.languages.getDiagnostics(uri).some(d => String(d.code) === 'E0101'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await config.update('languageServer.enabled', false, vscode.ConfigurationTarget.Global);
      await delay(250);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  test('CLI fallback rejects a result from an edited unsaved buffer and ownership switches', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-stale-'));
    const file = path.join(directory, 'test.mio'); fs.writeFileSync(file, 'kaku x = missing;');
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    const output = vscode.window.createOutputChannel('Mio stale test');
    const cli = new MioCliService();
    cli.resolve = () => ({ kind: 'found', executable: process.execPath, source: 'configured' } as ReturnType<MioCliService['resolve']>);
    let finish!: (value: ProcessRunResult) => void;
    const runner = { run: () => new Promise<ProcessRunResult>(resolve => { finish = resolve; }) } as unknown as ProcessRunner;
    const manager = new MioDiagnosticManager({ output, runner, cli });
    try {
      const pending = manager.checkNow(document);
      while (!finish) { await delay(10); }
      await editor.edit(edit => edit.replace(new vscode.Range(0, 0, 0, 17), 'kaku x = 42;'));
      manager.onDidChange(document);
      finish({ code: 1, stdout: '', stderr: 'old compiler error', timedOut: false, cancelled: false } as ProcessRunResult);
      assert.equal(await pending, false);
      assert.equal(vscode.languages.getDiagnostics(document.uri).length, 0);
      await delay(100);
      manager.setFallbackEnabled(false);
      assert.equal(manager.diagnosticsOwner, 'lsp');
      manager.setFallbackEnabled(true);
      assert.equal(manager.diagnosticsOwner, 'cli');
    } finally {
      manager.dispose(); cli.dispose(); output.dispose();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
