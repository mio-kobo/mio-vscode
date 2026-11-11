import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as vscode from 'vscode';
import type { MioExtensionApi } from '../../extension';

function summary(values: number[]): object {
  values.sort((a, b) => a - b);
  return { n: values.length, median: values[Math.floor(values.length / 2)], p95: values[Math.ceil(values.length * 0.95) - 1], max: values.at(-1) };
}

if (process.env.MIO_BENCHMARK) {
suite('Editing performance', () => {
  test('records repeatable end-to-end completion and diagnostic latency', async function () {
    this.timeout(120000);
    const extension = vscode.extensions.getExtension<MioExtensionApi>('exmikupro.mio-language-support')!;
    const api = await extension.activate();
    const config = vscode.workspace.getConfiguration('mio');
    await config.update('languageServer.enabled', false, vscode.ConfigurationTarget.Global);
    await new Promise(r => setTimeout(r, 500));
    await config.update('executablePath', process.env.MIO_TEST_CLI, vscode.ConfigurationTarget.Global);
    await new Promise(r => setTimeout(r, 500));
    await config.update('languageServer.enabled', true, vscode.ConfigurationTarget.Global);
    const deadline = Date.now() + 30000;
    while (api.getLanguageServerState() !== 'ready' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 50)); }
    assert.equal(api.getLanguageServerState(), 'ready');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-bench-'));
    const rows: object[] = [];
    const editing = fs.existsSync(path.resolve(__dirname, '../../editor/completionProvider.js')) ? await import('../../editor/completionProvider') : undefined;
    const instrumentation = fs.existsSync(path.resolve(__dirname, '../../editor/performance.js')) ? await import('../../editor/performance') : undefined;
    const local = editing ? new editing.MioCompletionProvider() : undefined;
    try {
      for (const lines of [20, 1000]) {
        const uri = vscode.Uri.file(path.join(directory, `size${lines}.mio`));
        fs.writeFileSync(uri.fsPath, 'waza main() -> unit {\n' + Array.from({ length: lines }, (_, i) => `  kaku value${i} = 42;\n`).join('') + '  cha\n}\n');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        const timings: number[] = [];
        for (let i = 0; i < 55; i++) {
          const start = performance.now();
          await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, new vscode.Position(lines + 1, 5));
          if (i >= 5) { timings.push(performance.now() - start); }
        }
        rows.push({ operation: 'completion API including LSP', lines, ...summary(timings) });
        if (local) {
        const cold: number[] = [];
        const warm: number[] = [];
        for (let i = 0; i < 50; i++) {
          const line = lines + 1;
          const prefix = i % 2 ? '  chan' : '  cha';
          await editor.edit(edit => edit.replace(doc.lineAt(line).range, prefix));
          const position = new vscode.Position(line, prefix.length);
          let start = performance.now();
          local.provideCompletionItems(doc, position);
          cold.push(performance.now() - start);
          start = performance.now();
          local.provideCompletionItems(doc, position);
          warm.push(performance.now() - start);
        }
        rows.push({ operation: 'local completion cold after edit', lines, ...summary(cold) });
        rows.push({ operation: 'local completion cached', lines, ...summary(warm) });
        }
        // Every iteration introduces a unique undefined name in the unsaved buffer.
        const diagnostics: number[] = [];
        for (let i = 0; i < 10; i++) {
          const name = `benchmark_missing_${i}`;
          const started = performance.now();
          await editor.edit(edit => edit.replace(new vscode.Range(lines + 1, 0, lines + 1, doc.lineAt(lines + 1).text.length), `  chant(${name});`));
          while (!vscode.languages.getDiagnostics(uri).some(d => d.message.includes(name))) {
            assert.ok(performance.now() - started < 10000, 'diagnostics timeout');
            await new Promise(r => setTimeout(r, 5));
          }
          diagnostics.push(performance.now() - started);
        }
        rows.push({ operation: 'unsaved edit to LSP diagnostic (5ms polling)', lines, ...summary(diagnostics) });
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
      const result = { platform: `${os.platform()} ${os.arch()} ${os.release()}`, vscode: vscode.version, node: process.version, extensionInstrumentation: Object.fromEntries([...(instrumentation?.editingTimings ?? [])].map(([key, values]) => [key, summary(values)])), lsp: api.getLanguageServerState(), rows };
      console.log('MIO_BENCHMARK ' + JSON.stringify(result));
      fs.writeFileSync(path.join(process.env.MIO_TEST_PLUGIN_ROOT!, '.test-tmp', `benchmark-${process.env.MIO_BENCHMARK}.json`), JSON.stringify(result, null, 2));
    } finally {
      local?.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
}
