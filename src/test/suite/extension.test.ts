import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';
import { MioCliService } from '../../cli/cliService';
import type { MioExtensionApi } from '../../extension';
import { MioLanguageClient } from '../../lsp/client';
import { samePath } from '../../util/paths';

const extensionId = 'exmikupro.mio-language-support';

const expectedCommands = [
  'mio.checkCurrentFile',
  'mio.runCurrentFile',
  'mio.buildCurrentFile',
  'mio.showCompilerVersion',
  'mio.openOutput',
  'mio.restartLanguageServer',
  'mioGraph.generateSource',
];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder === undefined) {
    throw new Error('test workspace is not open');
  }
  return folder;
}

async function setExecutablePath(value: string | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration('mio')
    .update(
      'executablePath',
      value,
      vscode.ConfigurationTarget.Global,
    );
  await delay(150);
}

async function openDocument(
  filePath: string,
): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(filePath),
  );
  await vscode.window.showTextDocument(document, { preview: false });
  return document;
}

async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await delay(150);
}

async function setLanguageServerEnabled(value: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('mio')
    .update(
      'languageServer.enabled',
      value,
      vscode.ConfigurationTarget.Global,
    );
  await delay(200);
}

async function waitFor<T>(
  description: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await delay(100);
  }
}


function hoverText(hovers: vscode.Hover[] | undefined): string {
  const values: string[] = [];
  for (const hover of hovers ?? []) {
    for (const content of hover.contents) {
      values.push(typeof content === 'string' ? content : content.value);
    }
  }
  return values.join('\n');
}

function documentOffset(
  document: vscode.TextDocument,
  needle: string,
  delta = 0,
): vscode.Position {
  const index = document.getText().indexOf(needle);
  assert.ok(index >= 0, `missing ${needle}`);
  return document.positionAt(index + delta);
}

function completionLabels(
  list: vscode.CompletionList | vscode.CompletionItem[] | undefined,
): string[] {
  const items = Array.isArray(list) ? list : (list?.items ?? []);
  return items.map((item) =>
    typeof item.label === 'string' ? item.label : item.label.label,
  );
}

function testCliPath(): string | undefined {
  const fromEnvironment = process.env.MIO_TEST_CLI;
  const candidate =
    fromEnvironment ??
    path.resolve(
      __dirname,
      '../../../.test-tmp',
      process.platform === 'win32' ? 'mio.exe' : 'mio',
    );
  return fs.existsSync(candidate) ? candidate : undefined;
}

suite('Mio extension host', () => {
  let extension: vscode.Extension<unknown>;
  let api: MioExtensionApi;

  suiteSetup(async () => {
    const found = vscode.extensions.getExtension(extensionId);
    assert.ok(found, `extension ${extensionId} was not found`);
    extension = found;
    await extension.activate();
    assert.equal(extension.isActive, true);
    api = extension.exports as MioExtensionApi;
    assert.ok(api, 'extension API was not returned');
    await setExecutablePath(undefined);
  });

  suiteTeardown(async () => {
    await setExecutablePath(undefined);
    await closeAllEditors();
  });

  test('activates and registers all Mio commands', async () => {
    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    for (const command of expectedCommands) {
      assert.ok(
        commands.includes(command),
        `missing command ${command}`,
      );
    }
  });

  test('opens .mio files with the Mio language id', async () => {
    const document = await openDocument(
      path.join(workspaceRoot(), 'sample.mio'),
    );
    assert.equal(document.languageId, 'mio');
    assert.equal(document.uri.fsPath.endsWith('.mio'), true);
  });

  test('contributes usable Mio snippets', async () => {
    const document = await vscode.workspace.openTextDocument({
      language: 'mio',
      content: '',
    });
    await vscode.window.showTextDocument(document, { preview: false });
    const expectedPrefixes = [
      'kaku', 'kaku-typed', 'waza', 'moshi-sore',
      'kaesu', 'yobu', 'kata', 'sentaku', 'awase', 'array', 'map',
    ];
    // A clean Extension Host loads contributed snippets asynchronously.
    // Wait for registration instead of asserting against its first partial result.
    await waitFor('all Mio snippet contributions', async () => {
      const list = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        new vscode.Position(0, 0),
      );
      const labels = new Set((list?.items ?? []).map((item) =>
        typeof item.label === 'string' ? item.label : item.label.label,
      ));
      return expectedPrefixes.every((prefix) => labels.has(prefix)) || undefined;
    });
  });

  test('provides syntax-based folding ranges', async () => {
    const document = await openDocument(
      path.join(workspaceRoot(), 'sample.mio'),
    );
    const ranges = await vscode.commands.executeCommand<
      vscode.FoldingRange[] | undefined
    >('vscode.executeFoldingRangeProvider', document.uri);
    assert.ok(ranges !== undefined && ranges.length > 0);
    assert.ok(
      ranges.some((range) => range.start === 0),
      `expected a fold starting at line 0, got ${JSON.stringify(ranges)}`,
    );
  });

  test('opens the Mio output channel', async () => {
    await vscode.commands.executeCommand('mio.openOutput');
  });

  test('does not crash when the Mio CLI is missing', async () => {
    const missing = path.join(
      os.tmpdir(),
      'mio missing 中文 日本語',
      process.platform === 'win32' ? 'mio.exe' : 'mio',
    );
    await setExecutablePath(missing);
    const document = await openDocument(
      path.join(workspaceRoot(), 'sample.mio'),
    );
    try {
      await vscode.commands.executeCommand('mio.checkCurrentFile');
      assert.equal(extension.isActive, true);
      assert.equal(document.languageId, 'mio');
      assert.equal(
        vscode.languages.getDiagnostics(document.uri).length,
        0,
      );
    } finally {
      await setExecutablePath(undefined);
    }
  });

  test('shows real CLI diagnostics for a path with spaces and Unicode', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }

    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio diag 中文 日本語-'),
    );
    const copiedCli = path.join(
      temporaryRoot,
      process.platform === 'win32' ? 'mio.exe' : 'mio',
    );
    fs.copyFileSync(cli, copiedCli);
    if (process.platform !== 'win32') {
      fs.chmodSync(copiedCli, 0o755);
    }

    const sourcePath = path.join(temporaryRoot, '集合 テスト.mio');
    fs.writeFileSync(
      sourcePath,
      [
        'waza main() -> int64 {',
        '    kaku message = "こんにちは, Mio!";',
        '    kaesu undefined_name + 1;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    await setLanguageServerEnabled(false);
    await setExecutablePath(copiedCli);
    const document = await openDocument(sourcePath);

    try {
      await waitFor('the diagnostic fixture to become active with CLI diagnostics', () =>
        vscode.window.activeTextEditor?.document === document && api.getDiagnosticsOwner() === 'cli');
      await vscode.commands.executeCommand('mio.checkCurrentFile');
      const diagnostics = await waitFor('the CLI diagnostic to be published', () => {
        const current = vscode.languages.getDiagnostics(document.uri);
        return current.length > 0 ? current : undefined;
      }, 5_000);

      const diagnostic = diagnostics.find(
        (item) => item.source === 'mio' && String(item.code) === 'E0201',
      );
      assert.ok(
        diagnostic,
        `expected E0201, got ${diagnostics
          .map((item) => `${item.source ?? ''}/${String(item.code)}/${item.message}`)
          .join('; ')}`,
      );
      assert.equal(diagnostic.range.start.line, 2);
      assert.equal(diagnostic.range.start.character, 10);
      assert.equal(diagnostic.range.end.line, 2);
      assert.equal(diagnostic.range.end.character, 24);
      assert.match(diagnostic.message, /undefined_name/u);
    } finally {
      // VS Code 测试宿主会保留 openTextDocument 打开的文档，因此直接调用
      // 与 onDidClose 相同的清理路径，验证诊断资源被释放。
      await closeAllEditors();
      await delay(200);
      api.clearDiagnostics(document.uri);
      assert.equal(
        vscode.languages.getDiagnostics(document.uri).length,
        0,
        'the cleanup path should clear diagnostics',
      );
      await setExecutablePath(undefined);
      await setLanguageServerEnabled(true);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('starts the MioCore language server and publishes live diagnostics', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }
    await setLanguageServerEnabled(true);
    await setExecutablePath(cli);
    await waitFor(
      'language server ready',
      () => api.getLanguageServerState() === 'ready',
    );
    assert.equal(api.getDiagnosticsOwner(), 'lsp');

    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio lsp live-'),
    );
    const sourcePath = path.join(temporaryRoot, 'live.mio');
    fs.writeFileSync(
      sourcePath,
      [
        'waza broken() -> int64 {',
        '    kaesu missing_value;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const document = await openDocument(sourcePath);
      const diagnostic = await waitFor('language server E0201', () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .find(
            (item) => item.source === 'mio' && String(item.code) === 'E0201',
          ),
      );
      assert.equal(diagnostic.range.start.line, 1);
      assert.equal(diagnostic.range.start.character, 10);
      assert.match(diagnostic.message, /missing_value/u);

      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, 'the test document should be active');
      const fixed = [
        'waza broken() -> int64 {',
        '    kaesu 1;',
        '}',
        '',
      ].join('\n');
      await editor.edit((builder) => {
        builder.replace(
          new vscode.Range(
            new vscode.Position(0, 0),
            document.positionAt(document.getText().length),
          ),
          fixed,
        );
      });
      await waitFor('language server diagnostics cleared', () => {
        const remaining = vscode.languages
          .getDiagnostics(document.uri)
          .filter((item) => item.source === 'mio');
        return remaining.length === 0;
      });
      await document.save();
    } finally {
      await closeAllEditors();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('mio.restartLanguageServer recovers after the CLI appears without a settings change', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mio restart-'));
    const lateCli = path.join(
      temporaryRoot,
      process.platform === 'win32' ? 'mio.exe' : 'mio',
    );
    try {
      await setLanguageServerEnabled(true);
      await setExecutablePath(lateCli);
      await waitFor(
        'language server failed (CLI missing)',
        () => api.getLanguageServerState() === 'failed',
      );
      assert.equal(api.getDiagnosticsOwner(), 'cli');

      // Install the CLI at the configured path; nothing restarts on its own.
      fs.copyFileSync(cli, lateCli);
      if (process.platform !== 'win32') {
        fs.chmodSync(lateCli, 0o755);
      }
      await delay(500);
      assert.equal(api.getLanguageServerState(), 'failed');

      await vscode.commands.executeCommand('mio.restartLanguageServer');
      await waitFor(
        'language server ready after restart command',
        () => api.getLanguageServerState() === 'ready',
      );
      assert.equal(api.getDiagnosticsOwner(), 'lsp');
    } finally {
      await setExecutablePath(cli);
      await waitFor(
        'language server ready on the test CLI',
        () => api.getLanguageServerState() === 'ready',
      );
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('a missing CLI is reported to the user once per session, not only logged', async () => {
    await setLanguageServerEnabled(true);
    const shown: string[] = [];
    const missing = {
      kind: 'notFound' as const,
      message: 'Mio CLI was not found (test stub).',
    };
    const stubCli = {
      resolve: () => missing,
      invalidate: () => undefined,
      showProblem: (resolution: { message?: string }) => {
        shown.push(resolution.message ?? '');
      },
      dispose: () => undefined,
    } as unknown as MioCliService;
    // Reuse the extension's channel: creating and immediately disposing a
    // channel races the host's async channel creation and leaks a disposable.
    const host = new MioLanguageClient({ output: api.outputChannel, cli: stubCli });
    try {
      const context = {} as vscode.ExtensionContext;
      await host.start(context);
      assert.equal(host.state, 'failed');
      await host.restart(context);
      await host.restart(context);
      assert.equal(host.state, 'failed');
      assert.deepEqual(shown, [missing.message]);
    } finally {
      await host.disposeAsync();
    }
  });

  test('disposeAsync resolves only after the language server process has stopped', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }
    await setLanguageServerEnabled(true);
    await setExecutablePath(cli);
    const host = new MioLanguageClient({ output: api.outputChannel, cli: new MioCliService() });
    try {
      await host.start({} as vscode.ExtensionContext);
      assert.equal(host.state, 'ready');
      // Internal handles, read only to observe the real process lifecycle.
      const inner = (host as unknown as { client?: LanguageClient }).client;
      assert.ok(inner, 'a LanguageClient should be running');
      const serverProcess = (inner as unknown as {
        _serverProcess?: { exitCode: number | null; signalCode: string | null };
      })._serverProcess;

      await host.disposeAsync();
      assert.equal(inner.state, State.Stopped);
      if (serverProcess !== undefined) {
        await waitFor(
          'mio lsp process exit',
          () => serverProcess.exitCode !== null || serverProcess.signalCode !== null,
          5_000,
        );
        // A signal here would mean the client had to kill the server
        // (checkProcessDied) instead of a graceful shutdown/exit.
        console.log(
          `[dispose-test] mio lsp exit code=${String(serverProcess.exitCode)} signal=${String(serverProcess.signalCode)}`,
        );
        assert.equal(serverProcess.signalCode, null);
      }
    } finally {
      // Idempotent: a second call returns the same settled shutdown.
      await host.disposeAsync();
    }
  });

  test('falls back to CLI diagnostics when the language server is disabled', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio lsp fallback-'),
    );
    const sourcePath = path.join(temporaryRoot, 'fallback.mio');
    fs.writeFileSync(
      sourcePath,
      [
        'waza broken() -> int64 {',
        '    kaesu missing_value;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      await setExecutablePath(cli);
      const document = await openDocument(sourcePath);
      await setLanguageServerEnabled(false);
      await waitFor(
        'language server disabled',
        () => api.getLanguageServerState() === 'disabled',
      );
      assert.equal(api.getDiagnosticsOwner(), 'cli');

      const diagnostic = await waitFor('CLI fallback E0201', () =>
        vscode.languages
          .getDiagnostics(document.uri)
          .find(
            (item) => item.source === 'mio' && String(item.code) === 'E0201',
          ),
      );
      assert.ok(diagnostic);

      await vscode.commands.executeCommand('mio.checkCurrentFile');
      await delay(500);
      const ours = vscode.languages
        .getDiagnostics(document.uri)
        .filter((item) => item.source === 'mio');
      assert.equal(
        ours.length,
        1,
        `expected exactly one Mio diagnostic, got ${ours.length}`,
      );

      await setLanguageServerEnabled(true);
      await waitFor(
        'language server ready again',
        () => api.getLanguageServerState() === 'ready',
      );
    } finally {
      await closeAllEditors();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('CLI fallback re-checks open saved files after diagnostics are re-enabled', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mio fallback config-'));
    const sourcePath = path.join(temporaryRoot, 'config.mio');
    fs.writeFileSync(
      sourcePath,
      ['waza broken() -> int64 {', '    kaesu missing_value;', '}', ''].join('\n'),
      'utf8',
    );
    const configuration = (): vscode.WorkspaceConfiguration =>
      vscode.workspace.getConfiguration('mio');
    const findE0201 = (document: vscode.TextDocument): vscode.Diagnostic | undefined =>
      vscode.languages
        .getDiagnostics(document.uri)
        .find((item) => item.source === 'mio' && String(item.code) === 'E0201');
    try {
      await setExecutablePath(cli);
      await setLanguageServerEnabled(false);
      await waitFor('language server disabled', () => api.getLanguageServerState() === 'disabled');
      const document = await openDocument(sourcePath);
      await vscode.commands.executeCommand('mio.checkCurrentFile');
      await waitFor('initial CLI E0201', () => findE0201(document));

      await configuration().update('diagnostics.enabled', false, vscode.ConfigurationTarget.Global);
      await waitFor('diagnostics cleared', () => findE0201(document) === undefined);

      // No save, no manual check: re-enabling alone must restore diagnostics.
      await configuration().update('diagnostics.enabled', true, vscode.ConfigurationTarget.Global);
      await waitFor('CLI E0201 after re-enable', () => findE0201(document), 15_000);
      assert.equal(document.isDirty, false);
    } finally {
      await configuration().update('diagnostics.enabled', undefined, vscode.ConfigurationTarget.Global);
      await closeAllEditors();
      await setLanguageServerEnabled(true);
      await waitFor('language server ready again', () => api.getLanguageServerState() === 'ready');
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });


  test('provides semantic navigation through the language server', async function () {
    const cli = testCliPath();
    if (cli === undefined) {
      this.skip();
      return;
    }
    await setLanguageServerEnabled(true);
    await setExecutablePath(cli);
    await waitFor(
      'language server ready',
      () => api.getLanguageServerState() === 'ready',
    );

    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio lsp semantic-'),
    );
    const sourcePath = path.join(temporaryRoot, 'semantic.mio');
    const source = [
      'kata Point {',
      '    x: int64;',
      '    y: int64;',
      '}',
      '',
      'sentaku Color {',
      '    Red;',
      '    Green;',
      '}',
      '',
      '// 两个数相加。',
      'waza add(a: int64, b: int64) -> int64 {',
      '    kaku sum = a + b;',
      '    kaesu sum;',
      '}',
      '',
      'waza main() -> int64 {',
      '    kaku point = Point { x: 1, y: 2 };',
      '    kaku color: Color = Color.Red();',
      '    kaesu add(point.x, point.y);',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(sourcePath, source, 'utf8');

    try {
      const document = await openDocument(sourcePath);
      const sumUse = documentOffset(document, 'kaesu sum;', 'kaesu '.length);

      const hover = await waitFor('semantic hover', async () => {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          document.uri,
          sumUse,
        );
        const text = hoverText(hovers);
        return text.includes('kaku sum') && text.includes('int64')
          ? text
          : undefined;
      });
      assert.ok(hover.length > 0);

      const definitions = await waitFor('semantic definition', async () => {
        const result = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          document.uri,
          sumUse,
        );
        return result !== undefined && result.length > 0 ? result : undefined;
      });
      assert.equal(definitions[0]?.range.start.line, 12);

      const references = await waitFor('semantic references', async () => {
        const result = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          document.uri,
          sumUse,
        );
        return result !== undefined && result.length >= 2 ? result : undefined;
      });
      assert.ok(references.length >= 2);

      const symbols = await waitFor('semantic document symbols', async () => {
        const result = await vscode.commands.executeCommand<
          vscode.DocumentSymbol[]
        >('vscode.executeDocumentSymbolProvider', document.uri);
        if (result === undefined) {
          return undefined;
        }
        const names = new Set(result.map((symbol) => symbol.name));
        const complete = ['Point', 'Color', 'add', 'main'].every((name) =>
          names.has(name),
        );
        return complete ? result : undefined;
      });
      const point = symbols.find((symbol) => symbol.name === 'Point');
      assert.ok(point);
      assert.deepEqual(
        (point?.children ?? []).map((child) => child.name),
        ['x', 'y'],
      );

      const memberPosition = documentOffset(
        document,
        'point.x',
        'point.'.length,
      );
      const completions = await waitFor('semantic completion', async () => {
        const list = await vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          document.uri,
          memberPosition,
        );
        const labels = completionLabels(list);
        return labels.includes('x') && labels.includes('y')
          ? labels
          : undefined;
      });
      assert.ok(completions.includes('x'));

      const signaturePosition = documentOffset(
        document,
        'add(point.x',
        'add('.length,
      );
      const signature = await waitFor('semantic signature help', async () => {
        const help = await vscode.commands.executeCommand<vscode.SignatureHelp>(
          'vscode.executeSignatureHelpProvider',
          document.uri,
          signaturePosition,
          '(',
        );
        if (help === undefined || help.signatures.length === 0) {
          return undefined;
        }
        return help.signatures[0]?.label.includes('add') ? help : undefined;
      });
      assert.equal(signature.activeParameter, 0);

      // 文档修改后语义结果必须更新。
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      const declarationLine = documentOffset(document, 'kaku sum = a + b;');
      await editor.edit((builder) => {
        builder.replace(
          new vscode.Range(
            declarationLine.line,
            0,
            declarationLine.line,
            'kaku sum = a + b;'.length,
          ),
          '    kaku sum = "text";',
        );
      });
      const updated = await waitFor('updated semantic hover', async () => {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          document.uri,
          sumUse,
        );
        const text = hoverText(hovers);
        return text.includes('kaku sum') && text.includes('string')
          ? text
          : undefined;
      });
      assert.ok(updated.includes('string'));
    } finally {
      await closeAllEditors();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('generates Mio source from a .miog graph through the extension API', async function () {
    const cli = testCliPath();
    const pluginRoot =
      process.env.MIO_TEST_PLUGIN_ROOT ?? path.resolve(__dirname, '../../..');
    const example = path.join(
      pluginRoot,
      'examples',
      'mio-graph',
      'score_report.miog',
    );
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio graph api-'),
    );
    const graphPath = path.join(temporaryRoot, 'score_report.miog');
    const targetPath = path.join(temporaryRoot, 'score_report.mio');
    fs.copyFileSync(example, graphPath);
    try {
      if (cli !== undefined) {
        await setExecutablePath(cli);
      }
      const outcome = await api.generateMioGraphSource(
        vscode.Uri.file(graphPath),
        { overwrite: 'always' },
      );
      assert.equal(outcome.ok, true, outcome.message);
      assert.equal(outcome.written, true);
      // VS Code normalizes Windows drive letters to lower case in Uri.fsPath.
      assert.ok(
        outcome.targetPath !== undefined &&
          samePath(outcome.targetPath, targetPath),
        `${String(outcome.targetPath)} != ${targetPath}`,
      );
      assert.ok(fs.existsSync(targetPath));
      const source = fs.readFileSync(targetPath, 'utf8');
      assert.ok(source.startsWith('// Generated by Mio Graph.'));
      assert.ok(source.includes('waza mio_graph_main() -> unit {'));
      assert.equal(
        outcome.validation,
        cli === undefined ? 'skipped' : 'passed',
        outcome.message,
      );

      // 相同内容再次生成时不应重写，也不应触发覆盖确认。
      const second = await api.generateMioGraphSource(
        vscode.Uri.file(graphPath),
      );
      assert.equal(second.ok, true, second.message);
      assert.equal(second.written, false);
      assert.equal(fs.readFileSync(targetPath, 'utf8'), source);
    } finally {
      await closeAllEditors();
      await setExecutablePath(undefined);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('never overwrites user code without explicit permission', async () => {
    const pluginRoot =
      process.env.MIO_TEST_PLUGIN_ROOT ?? path.resolve(__dirname, '../../..');
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio graph overwrite-'),
    );
    const graphPath = path.join(temporaryRoot, 'square.miog');
    const targetPath = path.join(temporaryRoot, 'square.mio');
    fs.copyFileSync(
      path.join(pluginRoot, 'examples', 'mio-graph', 'square.miog'),
      graphPath,
    );
    const userSource = '// handwritten code the user does not want to lose\n';
    fs.writeFileSync(targetPath, userSource, 'utf8');
    try {
      const refused = await api.generateMioGraphSource(
        vscode.Uri.file(graphPath),
      );
      assert.equal(refused.ok, false);
      assert.match(refused.message ?? '', /already exists/u);
      assert.equal(fs.readFileSync(targetPath, 'utf8'), userSource);

      const forced = await api.generateMioGraphSource(
        vscode.Uri.file(graphPath),
        { overwrite: 'always', validate: false },
      );
      assert.equal(forced.ok, true, forced.message);
      assert.equal(forced.written, true);
      assert.ok(
        fs.readFileSync(targetPath, 'utf8').startsWith('// Generated by Mio Graph.'),
      );
    } finally {
      await closeAllEditors();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('publishes structured graph diagnostics on the .miog document', async () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio graph diagnostics-'),
    );
    const graphPath = path.join(temporaryRoot, 'broken.miog');
    fs.writeFileSync(
      graphPath,
      JSON.stringify({
        formatVersion: 1,
        id: 'broken',
        version: 1,
        kind: 'program',
        metadata: { variables: [], imports: [], functions: [] },
        nodes: [
          { id: 'entry', type: 'Entry', params: {} },
          { id: 'boom', type: 'Explode', params: {} },
        ],
        connections: [],
      }),
      'utf8',
    );
    try {
      const outcome = await api.generateMioGraphSource(
        vscode.Uri.file(graphPath),
      );
      assert.equal(outcome.ok, false);
      assert.ok(
        outcome.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === 'MIOG0007' && diagnostic.nodeId === 'boom',
        ),
        JSON.stringify(outcome.diagnostics),
      );
      const published = vscode.languages.getDiagnostics(
        vscode.Uri.file(graphPath),
      );
      const graphDiagnostic = published.find(
        (diagnostic) => diagnostic.source === 'mio-graph',
      );
      assert.ok(graphDiagnostic, 'expected a mio-graph diagnostic');
      assert.equal(String(graphDiagnostic.code), 'MIOG0007');
      assert.equal(
        graphDiagnostic.severity,
        vscode.DiagnosticSeverity.Error,
      );
      assert.ok(graphDiagnostic.message.includes('Explode'));
    } finally {
      await closeAllEditors();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('runs the Generate Mio Source command from an active .miog editor', async () => {
    const pluginRoot =
      process.env.MIO_TEST_PLUGIN_ROOT ?? path.resolve(__dirname, '../../..');
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mio graph command-'),
    );
    const graphPath = path.join(temporaryRoot, 'score_report.miog');
    const targetPath = path.join(temporaryRoot, 'score_report.mio');
    fs.copyFileSync(
      path.join(pluginRoot, 'examples', 'mio-graph', 'score_report.miog'),
      graphPath,
    );
    try {
      const document = await openDocument(graphPath);
      assert.equal(document.languageId, 'mio-graph');
      await vscode.commands.executeCommand('mioGraph.generateSource');
      await waitFor('generated Mio source', () =>
        fs.existsSync(targetPath) ? true : undefined,
      );
      const source = fs.readFileSync(targetPath, 'utf8');
      assert.ok(source.startsWith('// Generated by Mio Graph.'));
      assert.ok(source.includes('moshi (score > passing) {'));
      assert.equal(
        vscode.languages
          .getDiagnostics(document.uri)
          .filter((diagnostic) => diagnostic.source === 'mio-graph').length,
        0,
      );
    } finally {
      await closeAllEditors();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('discovers and runs tests through the Test Explorer integration', async () => {
    const cli = testCliPath();
    assert.ok(cli !== undefined, 'a real Mio CLI is required (run npm run pretest)');
    const bunko = path.resolve(__dirname, '../../../.mio-core/bunko');
    assert.ok(fs.existsSync(bunko), `Bunko root missing: ${bunko}`);
    const previousBunko = process.env['MIO_BUNKO'];
    process.env['MIO_BUNKO'] = bunko;
    try {
      await setExecutablePath(cli);
      const testFile = path.join(workspaceRoot(), 'tests', 'math_test.mio');
      await openDocument(testFile);
      // Discovery goes through the language server's document symbols.
      const discovered = await waitFor('Mio tests to be discovered', async () => {
        await api.refreshTests();
        const names = api
          .getDiscoveredTests()
          .filter((entry) => entry.file === testFile);
        return names.length === 2 ? names : undefined;
      });
      assert.deepEqual(
        discovered.map((entry) => entry.name).sort(),
        ['test_fails', 'test_passes'],
      );
      assert.ok(
        discovered.every((entry) => entry.line !== undefined),
        'language server locations are attached to discovered tests',
      );

      const summary = await api.runAllTests();
      assert.deepEqual(summary, { passed: 1, failed: 1, skipped: 0, errored: 0 });
    } finally {
      if (previousBunko === undefined) {
        delete process.env['MIO_BUNKO'];
      } else {
        process.env['MIO_BUNKO'] = previousBunko;
      }
      await setExecutablePath(undefined);
      await closeAllEditors();
    }
  });

  test('reloads every test file edited within one debounce window', async () => {
    const cli = testCliPath();
    assert.ok(cli !== undefined, 'a real Mio CLI is required (run npm run pretest)');
    await setLanguageServerEnabled(true);
    await setExecutablePath(cli);
    await waitFor('language server ready', () => api.getLanguageServerState() === 'ready');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mio reload-'));
    const fileA = path.join(temporaryRoot, 'a_test.mio');
    const fileB = path.join(temporaryRoot, 'b_test.mio');
    fs.writeFileSync(fileA, 'waza test_a1() -> unit {\n}\n', 'utf8');
    fs.writeFileSync(fileB, 'waza test_b1() -> unit {\n}\n', 'utf8');
    try {
      const documentA = await openDocument(fileA);
      const documentB = await openDocument(fileB);
      // Two edits well inside the 400 ms debounce, in different files.
      const editA = new vscode.WorkspaceEdit();
      editA.insert(documentA.uri, documentA.positionAt(documentA.getText().length), 'waza test_a2() -> unit {\n}\n');
      const editB = new vscode.WorkspaceEdit();
      editB.insert(documentB.uri, documentB.positionAt(documentB.getText().length), 'waza test_b2() -> unit {\n}\n');
      assert.ok(await vscode.workspace.applyEdit(editA));
      assert.ok(await vscode.workspace.applyEdit(editB));

      const names = await waitFor('both edited files reloaded', () => {
        const found = api.getDiscoveredTests().map((entry) => entry.name);
        return found.includes('test_a2') && found.includes('test_b2') ? found : undefined;
      }, 15_000);
      assert.ok(names.includes('test_a1') && names.includes('test_b1'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await closeAllEditors();
      await setExecutablePath(undefined);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('disposes diagnostics and process resources', async () => {
    api.dispose();
    await delay(100);
    const remaining = vscode.languages
      .getDiagnostics()
      .filter(([, diagnostics]) =>
        diagnostics.some((diagnostic) => diagnostic.source === 'mio'),
      );
    assert.equal(
      remaining.length,
      0,
      'dispose should clear all Mio diagnostics',
    );
  });
});
