import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MioCliService } from '../cli/cliService';
import { ProcessRunError, type ProcessRunner } from '../cli/processRunner';
import { findBunkoRoot } from '../util/paths';
import {
  buildRunPattern,
  isTestFileName,
  isTestFunctionName,
  parseTestReport,
  TestReportError,
  type PackageResult,
} from './testReport';

const TEST_TIMEOUT_MS = 10 * 60_000;
const EXCLUDE_GLOB = '**/{node_modules,.git,build,dist,out,target,vendor}/**';
const REFRESH_DEBOUNCE_MS = 400;

export interface TestRunSummary {
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
}

export interface DiscoveredTest {
  file: string;
  name: string;
  // Zero-based line of the test function, when the language server located it.
  line: number | undefined;
}

export interface TestControllerDependencies {
  output: vscode.OutputChannel;
  runner: ProcessRunner;
  cli: MioCliService;
}

// Integrates `mio test --format=json` with the VS Code Test Explorer.
// Discovery uses the language server's document symbols (real parser, no regular
// expressions); results come only from what the CLI reports. Per-test source
// locations are only known for tests discovered through the language server.
export class MioTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: TestControllerDependencies) {
    this.controller = vscode.tests.createTestController('mio', 'Mio');
    this.controller.resolveHandler = async (item) => {
      if (item === undefined) {
        await this.discoverFiles();
      } else {
        await this.loadTests(item);
      }
    };
    this.controller.refreshHandler = () => this.refresh();
    this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        await this.runRequest(request, token);
      },
      true,
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*_test.mio');
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.upsertFile(uri)),
      watcher.onDidDelete((uri) => this.controller.items.delete(uri.toString())),
      watcher.onDidChange((uri) => this.scheduleReload(uri)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (isTestFileName(event.document.uri.path)) {
          this.scheduleReload(event.document.uri);
        }
      }),
      this.controller,
    );
  }

  // Re-discover everything, e.g. after the language server becomes ready.
  async refresh(): Promise<void> {
    await this.discoverFiles();
    for (const [, item] of this.controller.items) {
      await this.loadTests(item);
    }
  }

  // Snapshot of the tests currently shown in the Test Explorer.
  getDiscoveredTests(): DiscoveredTest[] {
    const tests: DiscoveredTest[] = [];
    this.controller.items.forEach((file) => {
      file.children.forEach((child) => {
        tests.push({
          file: file.uri?.fsPath ?? file.label,
          name: child.label,
          line: child.range?.start.line,
        });
      });
    });
    return tests;
  }

  // Runs every discovered test file exactly like the "Run All Tests" action.
  async runAll(token?: vscode.CancellationToken): Promise<TestRunSummary> {
    const source = new vscode.CancellationTokenSource();
    try {
      return await this.runRequest(
        new vscode.TestRunRequest(),
        token ?? source.token,
      );
    } finally {
      source.dispose();
    }
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  // ---- discovery ----

  private async discoverFiles(): Promise<void> {
    const uris = await vscode.workspace.findFiles('**/*_test.mio', EXCLUDE_GLOB);
    const known = new Set(uris.map((uri) => uri.toString()));
    for (const [id] of this.controller.items) {
      if (!known.has(id)) {
        this.controller.items.delete(id);
      }
    }
    for (const uri of uris) {
      this.upsertFile(uri);
    }
  }

  private upsertFile(uri: vscode.Uri): vscode.TestItem {
    const id = uri.toString();
    const existing = this.controller.items.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const item = this.controller.createTestItem(id, path.basename(uri.fsPath), uri);
    item.canResolveChildren = true;
    this.controller.items.add(item);
    return item;
  }

  private scheduleReload(uri: vscode.Uri): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      const item = this.upsertFile(uri);
      void this.loadTests(item);
    }, REFRESH_DEBOUNCE_MS);
  }

  private async loadTests(item: vscode.TestItem): Promise<void> {
    if (item.uri === undefined || !isTestFileName(item.uri.path)) {
      return;
    }
    let symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;
    try {
      symbols = await vscode.commands.executeCommand<
        Array<vscode.DocumentSymbol | vscode.SymbolInformation>
      >('vscode.executeDocumentSymbolProvider', item.uri);
    } catch {
      symbols = undefined;
    }
    if (symbols === undefined) {
      return;
    }
    const found = new Map<string, vscode.Range>();
    for (const symbol of symbols) {
      if (
        symbol.kind === vscode.SymbolKind.Function &&
        isTestFunctionName(symbol.name)
      ) {
        const range =
          'selectionRange' in symbol ? symbol.selectionRange : symbol.location.range;
        found.set(symbol.name.replace(/\(.*$/u, ''), range);
      }
    }
    if (found.size === 0 && item.children.size > 0) {
      // The server returned nothing (for example it is still starting); keep the
      // tests we already know instead of dropping them.
      return;
    }
    for (const [childId] of item.children) {
      const name = childId.slice(childId.indexOf('#') + 1);
      if (!found.has(name)) {
        item.children.delete(childId);
      }
    }
    for (const [name, range] of found) {
      const child = this.ensureChild(item, name);
      child.range = range;
    }
  }

  private ensureChild(file: vscode.TestItem, name: string): vscode.TestItem {
    const id = `${file.id}#${name}`;
    const existing = file.children.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const child = this.controller.createTestItem(id, name, file.uri);
    file.children.add(child);
    return child;
  }

  // ---- execution ----

  private async runRequest(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<TestRunSummary> {
    const run = this.controller.createTestRun(request);
    const summary: TestRunSummary = { passed: 0, failed: 0, skipped: 0, errored: 0 };
    try {
      await this.execute(request, countingRun(run, summary), token);
    } finally {
      run.end();
    }
    return summary;
  }

  private async execute(
    request: vscode.TestRunRequest,
    run: vscode.TestRun,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const resolution = this.deps.cli.resolve();
    const selected = this.collect(request);
    if (resolution.kind !== 'found') {
      this.deps.cli.showProblem(resolution);
      for (const item of selected) {
        run.errored(item, new vscode.TestMessage(resolution.message));
      }
      return;
    }

    // Group by package directory. Selecting a file or the root runs the whole
    // package (the CLI filters by test name only); selecting individual tests
    // narrows the run with --run.
    const groups = new Map<string, { whole: boolean; names: string[]; items: vscode.TestItem[] }>();
    for (const item of selected) {
      if (item.uri === undefined) {
        continue;
      }
      const directory = path.dirname(item.uri.fsPath);
      const group = groups.get(directory) ?? { whole: false, names: [], items: [] };
      const isTest = item.id.includes('#');
      if (isTest) {
        group.names.push(item.label);
      } else {
        group.whole = true;
      }
      group.items.push(item);
      groups.set(directory, group);
    }

    for (const [directory, group] of groups) {
      if (token.isCancellationRequested) {
        return;
      }
      for (const item of group.items) {
        run.enqueued(item);
        run.started(item);
      }
      const args = ['test', directory];
      const pattern = group.whole ? undefined : buildRunPattern(group.names);
      if (pattern !== undefined) {
        args.push(`--run=${pattern}`);
      }
      args.push('--format=json');
      this.deps.output.appendLine(`> mio ${args.join(' ')}`);
      const sample = group.items[0]?.uri?.fsPath ?? directory;
      const bunkoRoot = findBunkoRoot(sample);
      let stdout: string;
      try {
        const result = await this.deps.runner.run(resolution.executable, args, {
          cwd: directory,
          env: bunkoRoot === undefined ? undefined : { MIO_BUNKO: bunkoRoot },
          timeoutMs: TEST_TIMEOUT_MS,
          token,
        });
        if (result.cancelled) {
          return;
        }
        stdout = result.stdout;
        run.appendOutput(stdout.replace(/\r?\n/gu, '\r\n'));
        if (result.timedOut) {
          this.fail(run, group.items, 'mio test timed out.');
          continue;
        }
        if (stdout.trim() === '') {
          this.fail(run, group.items, result.stderr.trim() || 'mio test produced no output.');
          continue;
        }
      } catch (error) {
        const message = error instanceof ProcessRunError ? error.message : String(error);
        this.fail(run, group.items, message);
        continue;
      }
      let packages: PackageResult[];
      try {
        packages = parseTestReport(stdout);
      } catch (error) {
        const message = error instanceof TestReportError ? error.message : String(error);
        this.fail(run, group.items, message);
        continue;
      }
      this.report(run, directory, group.items, packages);
    }
  }

  private collect(request: vscode.TestRunRequest): vscode.TestItem[] {
    const excluded = new Set((request.exclude ?? []).map((item) => item.id));
    const roots: vscode.TestItem[] = [];
    if (request.include !== undefined) {
      roots.push(...request.include);
    } else {
      this.controller.items.forEach((item) => roots.push(item));
    }
    return roots.filter((item) => !excluded.has(item.id));
  }

  private fail(run: vscode.TestRun, items: vscode.TestItem[], message: string): void {
    for (const item of items) {
      run.errored(item, new vscode.TestMessage(message));
    }
  }

  private report(
    run: vscode.TestRun,
    directory: string,
    requested: vscode.TestItem[],
    packages: PackageResult[],
  ): void {
    for (const pkg of packages) {
      if (pkg.compileError !== undefined) {
        // Compilation failed: nothing ran, so this is an error, not a test failure.
        this.fail(run, requested, `Compilation failed: ${pkg.compileError}`);
        continue;
      }
      for (const result of pkg.tests) {
        const uri = vscode.Uri.file(path.join(directory, result.file));
        const fileItem = this.upsertFile(uri);
        const item = this.ensureChild(fileItem, result.name);
        const duration = result.durationMs;
        if (result.outcome === 'passed') {
          run.passed(item, duration);
        } else if (result.outcome === 'skipped') {
          run.skipped(item);
        } else {
          const messages =
            result.messages.length === 0 ? ['Test failed.'] : result.messages;
          run.failed(
            item,
            messages.map((text) => {
              const message = new vscode.TestMessage(text);
              if (item.uri !== undefined && item.range !== undefined) {
                message.location = new vscode.Location(item.uri, item.range);
              }
              return message;
            }),
            duration,
          );
        }
      }
    }
  }
}

// Wraps a TestRun so every reported state is also counted.
function countingRun(run: vscode.TestRun, summary: TestRunSummary): vscode.TestRun {
  return new Proxy(run, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      switch (property) {
        case 'passed':
          return (...args: unknown[]) => {
            summary.passed += 1;
            return bound(...args);
          };
        case 'failed':
          return (...args: unknown[]) => {
            summary.failed += 1;
            return bound(...args);
          };
        case 'skipped':
          return (...args: unknown[]) => {
            summary.skipped += 1;
            return bound(...args);
          };
        case 'errored':
          return (...args: unknown[]) => {
            summary.errored += 1;
            return bound(...args);
          };
        default:
          return bound;
      }
    },
  });
}
