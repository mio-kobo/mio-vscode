import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { MioCliService } from '../../cli/cliService';
import { ProcessRunner } from '../../cli/processRunner';
import { MioFormatter } from '../../editor/formatter';
import type { MioExtensionApi } from '../../extension';

const id = 'exmikupro.mio-language-support';
const target = vscode.ConfigurationTarget.Global;
const source = 'waza main()->unit{\n chant(1+2);\n}\n';
const formatted = 'waza main() -> unit {\n    chant(1 + 2);\n}\n';

const executable = process.env.MIO_FMT_TEST_CLI;
if (executable) { nativeFormatterSuite(executable); }

function nativeFormatterSuite(executable: string): void {
  suite('Native formatter integration', function () {
    let directory: string;
    let api: MioExtensionApi;
    let document: vscode.TextDocument;
    const settings = vscode.workspace.getConfiguration('mio');

    suiteSetup(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mio fmt '));
      api = await vscode.extensions.getExtension<MioExtensionApi>(id)!.activate();
      await settings.update('executablePath', executable, target);
      await settings.update('diagnostics.enabled', false, target);
      await settings.update('languageServer.enabled', true, target);
      await vscode.workspace.getConfiguration('editor', { languageId: 'mio' }).update('defaultFormatter', id, target, true);
    });

    suiteTeardown(async () => {
      if (!directory) { return; }
      await vscode.workspace.getConfiguration('editor', { languageId: 'mio' }).update('defaultFormatter', undefined, target, true);
      await settings.update('executablePath', undefined, target);
      await settings.update('diagnostics.enabled', undefined, target);
      await settings.update('languageServer.enabled', undefined, target);
      await fs.rm(directory, { recursive: true, force: true });
    });

    async function open(name: string, text: string): Promise<vscode.TextEditor> {
      const file = path.join(directory, name + '.mio');
      await fs.writeFile(file, text);
      document = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(document);
      await editorCommand('workbench.action.focusActiveEditorGroup');
      return editor;
    }

    async function ensureLanguageServer(): Promise<void> {
      const deadline = Date.now() + 15_000;
      while (api.getLanguageServerState() !== 'ready' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(api.getLanguageServerState(), 'ready');
    }

    async function editorCommand(command: string): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, 100));
      await vscode.commands.executeCommand(command);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    test('Format Document command uses unsaved content and keeps disk intact', async () => {
      const editor = await open('unsaved', '// disk\n');
      await editor.edit(edit => edit.replace(new vscode.Range(0, 0, 1, 0), source));
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider',
        document.uri, { tabSize: 4, insertSpaces: true });
      assert.ok(edits.length > 0, 'Mio provider did not return formatting edits');
      await editorCommand('mio.formatDocument');
      assert.equal(document.getText(), formatted);
      assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), '// disk\n');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    test('VS Code format on save uses the registered provider', async () => {
      const configuration = vscode.workspace.getConfiguration('editor', { languageId: 'mio' });
      await configuration.update('formatOnSave', true, target, true);
      try {
        const editor = await open('save', '// disk\n');
        await editor.edit(edit => edit.replace(new vscode.Range(0, 0, 1, 0), source));
        await editorCommand('workbench.action.files.save');
        assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), formatted);
      } finally {
        await configuration.update('formatOnSave', undefined, target, true);
      }
    });

    test('format executable override works with spaces and Unicode', async () => {
      const custom = path.join(directory, process.platform === 'win32' ? 'Mio 日本語.exe' : 'Mio 日本語');
      await fs.copyFile(executable, custom);
      if (process.platform !== 'win32') { await fs.chmod(custom, 0o755); }
      await settings.update('format.executable', custom, target);
      try {
        await open('custom', source);
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider',
          document.uri, { tabSize: 4, insertSpaces: true });
        assert.ok(edits.length > 0);
        await editorCommand('mio.formatDocument');
        assert.equal(document.getText(), formatted);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      } finally {
        await settings.update('format.executable', undefined, target);
      }
    });

    test('formatter nonzero exit leaves a malformed buffer untouched', async () => {
      const invalid = 'waza broken( {';
      await open('broken', invalid);
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider',
        document.uri, { tabSize: 4, insertSpaces: true });
      assert.equal(edits?.length ?? 0, 0);
      assert.equal(document.getText(), invalid);
    });

    if (process.platform !== 'win32') {
      test('formatter timeout and cancellation terminate a real child process', async () => {
        const slow = path.join(directory, 'Mio slow');
        await fs.writeFile(slow, '#!/bin/sh\nif [ "$1" = version ]; then printf "mio v9.0\\n"; else exec /bin/sleep 60; fi\n', { mode: 0o755 });
        const cli = new MioCliService();
        const runner = new ProcessRunner();
        const channel = vscode.window.createOutputChannel('Mio formatter test');
        const formatter = new MioFormatter(cli, runner, channel);
        const token = new vscode.CancellationTokenSource();
        const options = { tabSize: 4, insertSpaces: true };
        try {
          await settings.update('format.executable', slow, target);
          await settings.update('format.timeout', 250, target);
          await open('deadline', source);
          const start = Date.now();
          assert.deepEqual(await formatter.provideDocumentFormattingEdits(document, options, token.token), []);
          assert.ok(Date.now() - start < 4_000);
          await settings.update('format.timeout', 10_000, target);
          const cancel = setTimeout(() => token.cancel(), 100);
          try {
            const started = Date.now();
            assert.deepEqual(await formatter.provideDocumentFormattingEdits(document, options, token.token), []);
            assert.ok(Date.now() - started < 4_000);
            assert.equal(document.getText(), source);
          } finally {
            clearTimeout(cancel);
          }
        } finally {
          token.dispose();
          runner.dispose();
          cli.dispose();
          channel.dispose();
          await settings.update('format.executable', undefined, target);
          await settings.update('format.timeout', undefined, target);
        }
      });
    }

    test('Organize Imports command uses the standard source action', async () => {
      await ensureLanguageServer();
      await open('organize', 'waza main() -> unit { chant(convert.format_int(42)); }\n');
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 0, 0, 0), 'source.organizeImports',
      );
      assert.ok(actions.some(action => action.kind?.value === 'source.organizeImports'));
      await editorCommand('mio.organizeImports');
      assert.ok(document.getText().startsWith('yobu "kiso/convert";\n'));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });

    test('VS Code code actions on save organize imports independently', async () => {
      await ensureLanguageServer();
      const configuration = vscode.workspace.getConfiguration('editor', { languageId: 'mio' });
      await configuration.update('codeActionsOnSave', { 'source.organizeImports': 'explicit' }, target, true);
      try {
        const editor = await open('save-imports', '// before save\n');
        await editor.edit(edit => edit.replace(new vscode.Range(0, 0, 1, 0),
          'waza main() -> unit { chant(convert.format_int(42)); }\n'));
        await editorCommand('workbench.action.files.save');
        assert.ok((await fs.readFile(document.uri.fsPath, 'utf8')).startsWith('yobu "kiso/convert";\n'));
      } finally {
        await configuration.update('codeActionsOnSave', undefined, target, true);
      }
    });

    test('completion applies the member and its additional yobu edit', async () => {
      await ensureLanguageServer();
      const text = 'waza main() -> unit {\n    os.monotonic_m\n}\n';
      const editor = await open('completion', text);
      const end = new vscode.Position(1, 18);
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider', document.uri, end,
      );
      const item = list.items.find(candidate => candidate.label === 'monotonic_ms');
      assert.ok(item?.additionalTextEdits?.length);
      editor.selection = new vscode.Selection(end, end);
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand('editor.action.triggerSuggest');
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !document.getText().startsWith('yobu "kiso/os";')) {
        await new Promise(resolve => setTimeout(resolve, 100));
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
      }
      assert.ok(document.getText().startsWith('yobu "kiso/os";\n'));
      assert.ok(document.getText().includes('os.monotonic_ms'));
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
  });
}
