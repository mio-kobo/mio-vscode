import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MioCliService } from '../cli/cliService';
import type { ProcessRunner, ProcessRunResult } from '../cli/processRunner';

export class MioFormatter implements vscode.DocumentFormattingEditProvider {
  private readonly versions = new Map<string, string>();

  constructor(
    private readonly cli: MioCliService,
    private readonly runner: ProcessRunner,
    private readonly output: vscode.OutputChannel,
  ) {}

  async provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.TextEdit[]> {
    try {
      const input = document.getText();
      const version = document.version;
      const result = await this.run(document, input, token);
      if (!result || document.isClosed || document.version !== version || token.isCancellationRequested) { return []; }
      if (input.trim() !== '' && result.stdout.trim() === '') {
        throw new Error('Mio returned empty output for a non-empty document.');
      }
      return minimalEdit(document, input, result.stdout);
    } catch (error) {
      if (!token.isCancellationRequested) { this.report(error); }
      return [];
    }
  }

  async check(document: vscode.TextDocument): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Checking Mio formatting', cancellable: true },
        async (_progress, token) => {
          const version = document.version;
          const result = await this.run(document, document.getText(), token, true);
          if (!result || document.isClosed || document.version !== version || token.isCancellationRequested) { return; }
          void vscode.window.showInformationMessage(result.code === 0
            ? 'Mio formatting is up to date.'
            : 'This Mio document needs formatting.');
        },
      );
    } catch (error) {
      this.report(error);
    }
  }

  private async run(
    document: vscode.TextDocument, input: string, token: vscode.CancellationToken, check = false,
  ): Promise<ProcessRunResult | undefined> {
    const config = vscode.workspace.getConfiguration('mio.format', document.uri);
    if (!config.get('enable', true) || token.isCancellationRequested) { return undefined; }
    const resolution = this.cli.resolve(config.get('executable', ''));
    if (resolution.kind !== 'found') {
      throw new Error(`${resolution.message} Install a Mio release with fmt support or set mio.format.executable.`);
    }
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
    const filename = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
    const cwd = folder ?? (filename ? path.dirname(filename) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    const timeoutMs = config.get('timeout', 10_000);
    const started = Date.now();
    let version = this.versions.get(resolution.executable);
    if (version === undefined) {
      const probe = await this.runner.run(resolution.executable, ['version'], { cwd, timeoutMs, token });
      if (probe.cancelled || token.isCancellationRequested) { return undefined; }
      if (probe.timedOut) { throw new Error(`Mio version check timed out after ${timeoutMs} ms.`); }
      if (probe.code !== 0 || probe.truncated || !/^mio\s+v?\d/i.test(probe.stdout.trim())) {
        throw new Error(`Could not determine the Mio CLI version. ${probe.stderr.trim()}`.trim());
      }
      version = probe.stdout.trim();
      this.versions.set(resolution.executable, version);
    }
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) { throw new Error(`Mio fmt timed out after ${timeoutMs} ms.`); }
    const args = ['fmt', '--stdin'];
    if (filename) { args.push('--stdin-filepath', filename); }
    if (!config.get('organizeImports', true)) { args.push('--no-organize-imports'); }
    if (check) { args.push('--check'); }
    const result = await this.runner.run(resolution.executable, args, { input, cwd, timeoutMs: remaining, token });
    if (result.cancelled || token.isCancellationRequested) { return undefined; }
    if (result.timedOut) { throw new Error(`Mio fmt timed out after ${timeoutMs} ms.`); }
    if (result.truncated) { throw new Error('Mio fmt exceeded the output size limit.'); }
    if (result.code !== 0 && !(check && result.code === 1 && result.stderr.trim() === '')) {
      throw new Error(`Mio fmt exited with ${result.code ?? result.signal} (${version}): ${result.stderr.trim() || 'no diagnostics'}. Use a Mio CLI with fmt support.`);
    }
    return result;
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`[format] ${message}`);
    void vscode.window.showErrorMessage(`Mio formatting failed: ${message}`);
  }
}

function splitsCharacter(text: string, offset: number): boolean {
  const next = text.charCodeAt(offset);
  return (next >= 0xdc00 && next <= 0xdfff) || (next === 10 && text.charCodeAt(offset - 1) === 13);
}

function minimalEdit(document: vscode.TextDocument, before: string, after: string): vscode.TextEdit[] {
  if (before === after) { return []; }
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) { start++; }
  if (splitsCharacter(before, start) || splitsCharacter(after, start)) { start--; }
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  if (splitsCharacter(before, oldEnd) || splitsCharacter(after, newEnd)) {
    oldEnd++;
    newEnd++;
  }
  const range = new vscode.Range(document.positionAt(start), document.positionAt(oldEnd));
  return [vscode.TextEdit.replace(range, after.slice(start, newEnd))];
}
