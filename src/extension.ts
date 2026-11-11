import { MioCompletionProvider } from './editor/completionProvider';
import { MioSemicolonProvider } from './editor/semicolonProvider';
import * as vscode from 'vscode';
import { MioCliService } from './cli/cliService';
import { ProcessRunner } from './cli/processRunner';
import { MioCommands } from './commands/commands';
import {
  MioGraphCommands,
  type GenerateGraphOptions,
  type MioGraphGenerationOutcome,
} from './commands/graphCommands';
import { MioDiagnosticManager } from './diagnostics/diagnosticManager';
import { MioFoldingRangeProvider } from './editor/foldingProvider';
import {
  MioTestController,
  type DiscoveredTest,
  type TestRunSummary,
} from './testing/testController';
import {
  MioLanguageClient,
  type MioDiagnosticsOwner,
  type MioLanguageServerState,
} from './lsp/client';

interface Runtime {
  readonly output: vscode.OutputChannel;
  dispose(): void;
}

let runtime: Runtime | undefined;

export interface MioExtensionApi {
  readonly outputChannel: vscode.OutputChannel;
  clearDiagnostics(uri: vscode.Uri): void;
  getLanguageServerState(): MioLanguageServerState;
  getDiagnosticsOwner(): MioDiagnosticsOwner;
  // 未来的蓝图编辑器（Webview / React Flow）可以直接调用该入口。
  generateMioGraphSource(
    uri: vscode.Uri,
    options?: GenerateGraphOptions,
  ): Promise<MioGraphGenerationOutcome>;
  // Test Explorer hooks (used by integration tests and future UIs).
  refreshTests(): Promise<void>;
  getDiscoveredTests(): DiscoveredTest[];
  runAllTests(): Promise<TestRunSummary>;
  dispose(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<MioExtensionApi> {
  const output = vscode.window.createOutputChannel('Mio');
  const runner = new ProcessRunner();
  const cli = new MioCliService();
  const diagnostics = new MioDiagnosticManager({ output, runner, cli });
  const commands = new MioCommands({ output, runner, cli, diagnostics });
  const graphCommands = new MioGraphCommands({ output, runner, cli });
  const languageClient = new MioLanguageClient({ output, cli });
  const tests = new MioTestController({ output, runner, cli });

  // server 就绪时由它独占诊断；其余状态（禁用、失败、停止）回到 CLI 回退。
  const languageStateListener = languageClient.onDidChangeState((state) => {
    const lspOwnsDiagnostics = state === 'ready';
    diagnostics.setFallbackEnabled(!lspOwnsDiagnostics);
    if (lspOwnsDiagnostics) {
      void tests.refresh();
    }
    output.appendLine(
      `[lsp] state=${state} diagnostics=${lspOwnsDiagnostics ? 'language server' : 'CLI fallback'}`,
    );
  });

  const guard = (
    action: () => Promise<void>,
  ): (() => Promise<void>) => {
    return async () => {
      try {
        await action();
      } catch (error) {
        const message = errorMessage(error);
        output.appendLine(`[command] ${message}`);
        void vscode.window
          .showErrorMessage(`Mio command failed: ${message}`, 'Open Output')
          .then((choice) => {
            if (choice === 'Open Output') {
              output.show(true);
            }
          });
      }
    };
  };

  const commandDisposables = [
    vscode.commands.registerCommand(
      'mio.checkCurrentFile',
      guard(() => commands.checkCurrentFile()),
    ),
    vscode.commands.registerCommand(
      'mio.runCurrentFile',
      guard(() => commands.runCurrentFile()),
    ),
    vscode.commands.registerCommand(
      'mio.buildCurrentFile',
      guard(() => commands.buildCurrentFile()),
    ),
    vscode.commands.registerCommand(
      'mio.showCompilerVersion',
      guard(() => commands.showCompilerVersion()),
    ),
    vscode.commands.registerCommand('mio.openOutput', () =>
      commands.openOutput(),
    ),
    vscode.commands.registerCommand(
      'mioGraph.generateSource',
      guard(() => graphCommands.generateFromActiveEditor()),
    ),
  ];

  const completion = new MioCompletionProvider();
  const editing = [completion, vscode.languages.registerCompletionItemProvider({ language: 'mio' }, completion, '"', '/'),
    vscode.languages.registerOnTypeFormattingEditProvider({ language: 'mio' }, new MioSemicolonProvider(), '\n')];
  const changeListener = vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) { diagnostics.onDidChange(event.document); } });

  const folding = vscode.languages.registerFoldingRangeProvider(
    { language: 'mio' },
    new MioFoldingRangeProvider(),
  );
  const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
    diagnostics.onDidSave(document);
  });
  const tabListener = vscode.window.tabGroups.onDidChangeTabs(event => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) { diagnostics.onDidOpenTab(tab.input.uri); }
      }
    }
    for (const tab of event.closed) {
      if (tab.input instanceof vscode.TabInputText &&
          !vscode.window.tabGroups.all.some(group => group.tabs.some(other => other.input instanceof vscode.TabInputText && other.input.uri.toString() === (tab.input as vscode.TabInputText).uri.toString()))) {
        diagnostics.onDidCloseTab(tab.input.uri);
      }
    }
  });
  const closeListener = vscode.workspace.onDidCloseTextDocument((document) => {
    diagnostics.onDidClose(document);
  });
  const configurationListener =
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('mio')) {
        return;
      }
      if (event.affectsConfiguration('mio.executablePath')) { cli.invalidate(); }
      if (
        event.affectsConfiguration('mio.executablePath') ||
        event.affectsConfiguration('mio.languageServer.enabled')
      ) {
        void languageClient.restart(context);
        return;
      }
      if (event.affectsConfiguration('mio.diagnostics')) {
        if (languageClient.state !== 'ready') { diagnostics.onConfigurationChanged(); }
        if (event.affectsConfiguration('mio.diagnostics.enabled')) { languageClient.syncConfiguration(); }
      }
    });

  let disposed = false;
  const disposable: vscode.Disposable = {
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      changeListener.dispose();
      for (const item of editing) { item.dispose(); }
      saveListener.dispose();
      closeListener.dispose();
      tabListener.dispose();
      configurationListener.dispose();
      languageStateListener.dispose();
      folding.dispose();
      tests.dispose();
      for (const command of commandDisposables) {
        command.dispose();
      }
      languageClient.dispose();
      graphCommands.dispose();
      diagnostics.dispose();
      cli.dispose();
      runner.dispose();
      output.dispose();
    },
  };

  context.subscriptions.push(disposable);
  runtime = { output, dispose: () => disposable.dispose() };

  const api: MioExtensionApi = {
    outputChannel: output,
    clearDiagnostics: (uri) => diagnostics.clearDocument(uri),
    getLanguageServerState: () => languageClient.state,
    getDiagnosticsOwner: () => diagnostics.diagnosticsOwner,
    generateMioGraphSource: (uri, options) =>
      graphCommands.generateFromUri(uri, options),
    refreshTests: () => tests.refresh(),
    getDiscoveredTests: () => tests.getDiscoveredTests(),
    runAllTests: () => tests.runAll(),
    dispose: () => disposable.dispose(),
  };

  output.appendLine('Mio — Programming Language Tools activated.');
  try {
    void languageClient.start(context).catch(error => output.appendLine(`[lsp] ${errorMessage(error)}`));
  } catch (error) {
    output.appendLine(`[lsp] ${errorMessage(error)}`);
  }
  output.appendLine('Mio — Programming Language Tools ready.');
  return api;
}

export function deactivate(): void {
  runtime?.dispose();
  runtime = undefined;
}
