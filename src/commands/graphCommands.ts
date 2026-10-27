// Mio Graph 的 VS Code 集成层：读取 .miog、调用纯编译核心、安全写入相邻 .mio，
// 并把结构化诊断映射回 .miog 文档与 Mio 输出通道。

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { runMioCheck } from '../cli/checkRunner';
import { MioCliService } from '../cli/cliService';
import type { ProcessRunner } from '../cli/processRunner';
import { MIO_GRAPH_GENERATED_MARKER } from '../graph/codegen/generateSource';
import {
  compileMioGraphJson,
  type GraphCompilationResult,
} from '../graph/compiler';
import {
  formatGraphDiagnostic,
  type GraphDiagnostic,
} from '../graph/diagnostics';
import { MIO_GRAPH_FILE_EXTENSION } from '../graph/model/types';
import { findBunkoRoot } from '../util/paths';

const CHECK_TIMEOUT_MS = 30_000;

export type GraphOverwriteMode = 'prompt' | 'always' | 'never';

export interface GenerateGraphOptions {
  overwrite?: GraphOverwriteMode;
  // 是否在生成后用 mio check 校验；默认 true。
  validate?: boolean;
}

export type GraphValidationStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'toolError'
  | 'cancelled';

export interface MioGraphGenerationOutcome {
  ok: boolean;
  written: boolean;
  opened: boolean;
  diagnostics: GraphDiagnostic[];
  sourcePath?: string;
  targetPath?: string;
  validation: GraphValidationStatus;
  message?: string;
}

export interface MioGraphCommandDependencies {
  output: vscode.OutputChannel;
  runner: ProcessRunner;
  cli: MioCliService;
}

export function isMioGraphDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === 'file' &&
    (document.languageId === 'mio-graph' ||
      document.uri.fsPath.toLowerCase().endsWith(MIO_GRAPH_FILE_EXTENSION))
  );
}

// 由 .miog 路径推导相邻 .mio 输出路径。
export function resolveGraphOutputPath(sourcePath: string): string {
  const directory = path.dirname(sourcePath);
  const baseName = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(directory, `${baseName}.mio`);
}

export function isGeneratedByMioGraph(text: string): boolean {
  return text
    .split(/\r?\n/u)
    .slice(0, 3)
    .some((line) => line.startsWith(MIO_GRAPH_GENERATED_MARKER));
}

export class MioGraphCommands implements vscode.Disposable {
  private readonly collection =
    vscode.languages.createDiagnosticCollection('mio-graph');

  constructor(private readonly deps: MioGraphCommandDependencies) {}

  async generateFromActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      void vscode.window.showWarningMessage(
        'Open a .miog graph file first.',
      );
      return;
    }
    const document = editor.document;
    if (!isMioGraphDocument(document)) {
      void vscode.window.showWarningMessage(
        'The active editor is not a Mio Graph (.miog) file.',
      );
      return;
    }
    const outcome = await this.generateForDocument(document, {
      overwrite: 'prompt',
    });
    this.presentOutcome(outcome);
  }

  // 供未来蓝图编辑器调用的 API：按 URI 生成，默认绝不覆盖已有文件。
  async generateFromUri(
    uri: vscode.Uri,
    options: GenerateGraphOptions = {},
  ): Promise<MioGraphGenerationOutcome> {
    const document = await vscode.workspace.openTextDocument(uri);
    return this.generateForDocument(document, {
      overwrite: 'never',
      ...options,
    });
  }

  async generateForDocument(
    document: vscode.TextDocument,
    options: GenerateGraphOptions = {},
  ): Promise<MioGraphGenerationOutcome> {
    if (document.uri.scheme !== 'file') {
      return this.failure('Save this graph as a .miog file before generating Mio source.');
    }
    const sourcePath = document.uri.fsPath;
    if (!sourcePath.toLowerCase().endsWith(MIO_GRAPH_FILE_EXTENSION)) {
      return this.failure(
        `Mio Graph can only compile ${MIO_GRAPH_FILE_EXTENSION} files.`,
      );
    }
    const targetPath = resolveGraphOutputPath(sourcePath);
    const compilation = compileMioGraphJson(document.getText());
    this.publishGraphDiagnostics(document, compilation);

    if (!compilation.ok || compilation.source === undefined) {
      const errors = compilation.diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error',
      );
      this.deps.output.appendLine(
        `[graph] compile failed for ${sourcePath} (${errors.length} error(s))`,
      );
      for (const diagnostic of compilation.diagnostics) {
        this.deps.output.appendLine(
          `[graph] ${formatGraphDiagnostic(diagnostic)}`,
        );
      }
      return {
        ok: false,
        written: false,
        opened: false,
        diagnostics: compilation.diagnostics,
        sourcePath,
        targetPath,
        validation: 'skipped',
        message:
          errors[0]?.message ??
          'The graph could not be compiled.',
      };
    }

    const writeResult = await this.writeTarget(
      document,
      targetPath,
      compilation.source,
      options.overwrite ?? 'prompt',
    );
    if (!writeResult.ok) {
      return {
        ok: false,
        written: false,
        opened: false,
        diagnostics: compilation.diagnostics,
        sourcePath,
        targetPath,
        validation: 'skipped',
        message: writeResult.message,
      };
    }

    const opened = await this.openTarget(targetPath);
    const validation = await this.validateTarget(
      targetPath,
      compilation.source,
      options.validate !== false,
    );

    return {
      ok: true,
      written: writeResult.written,
      opened,
      diagnostics: compilation.diagnostics,
      sourcePath,
      targetPath,
      validation: validation.status,
      ...(validation.message === undefined
        ? {}
        : { message: validation.message }),
    };
  }

  dispose(): void {
    this.collection.dispose();
  }

  private async writeTarget(
    document: vscode.TextDocument,
    targetPath: string,
    source: string,
    overwrite: GraphOverwriteMode,
  ): Promise<{ ok: boolean; written: boolean; message?: string }> {
    const existing = await readFileIfExists(targetPath);
    if (existing === source) {
      return { ok: true, written: false };
    }
    if (existing !== undefined) {
      const generated = isGeneratedByMioGraph(existing);
      if (!generated) {
        if (overwrite === 'never') {
          return {
            ok: false,
            written: false,
            message: `${path.basename(targetPath)} already exists and was not generated by Mio Graph. Overwrite it explicitly to continue.`,
          };
        }
        if (overwrite === 'prompt') {
          const choice = await vscode.window.showWarningMessage(
            `Mio Graph: ${path.basename(targetPath)} already exists and was not generated by Mio Graph. Overwrite it?`,
            {
              modal: true,
              detail: targetPath,
            },
            'Overwrite',
          );
          if (choice !== 'Overwrite') {
            return {
              ok: false,
              written: false,
              message: 'Source generation was cancelled; the existing file was not changed.',
            };
          }
        }
      }
    }

    try {
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.promises.writeFile(targetPath, source, 'utf8');
    } catch (error) {
      return {
        ok: false,
        written: false,
        message: `Unable to write ${targetPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    this.deps.output.appendLine(
      `[graph] wrote ${targetPath} from ${document.uri.fsPath}`,
    );
    return { ok: true, written: true };
  }

  private async validateTarget(
    targetPath: string,
    source: string,
    enabled: boolean,
  ): Promise<{ status: GraphValidationStatus; message?: string }> {
    if (!enabled) {
      return { status: 'skipped' };
    }
    const resolution = this.deps.cli.resolve();
    if (resolution.kind !== 'found') {
      this.deps.output.appendLine(
        `[graph] mio CLI unavailable; skipped validation (${resolution.message})`,
      );
      return { status: 'skipped', message: resolution.message };
    }
    const result = await runMioCheck({
      runner: this.deps.runner,
      executable: resolution.executable,
      filePath: targetPath,
      documentText: source,
      useTempPackage: true,
      cwd: path.dirname(targetPath),
      bunkoRoot: findBunkoRoot(targetPath),
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    this.deps.output.appendLine(
      `[graph] mio check ${targetPath}: ${result.kind}`,
    );
    if (result.kind === 'passed') {
      return { status: 'passed' };
    }
    if (result.kind === 'cancelled') {
      return { status: 'cancelled' };
    }
    if (result.kind === 'toolError' || result.kind === 'failed') {
      this.deps.output.appendLine(
        `[graph] ${result.message ?? 'mio check failed'}`,
      );
      return { status: 'toolError', message: result.message };
    }
    for (const payload of result.payloads) {
      this.deps.output.appendLine(
        `[graph] ${payload.severity ?? 'error'} ${payload.code ?? ''}: ${payload.message ?? ''}`,
      );
    }
    return {
      status: 'failed',
      message:
        result.payloads[0]?.message ??
        'The generated Mio source did not pass mio check.',
    };
  }

  private async openTarget(targetPath: string): Promise<boolean> {
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(targetPath),
      );
      await vscode.window.showTextDocument(document, { preview: false });
      return true;
    } catch (error) {
      this.deps.output.appendLine(
        `[graph] unable to open ${targetPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private publishGraphDiagnostics(
    document: vscode.TextDocument,
    compilation: GraphCompilationResult,
  ): void {
    if (compilation.diagnostics.length === 0) {
      this.collection.delete(document.uri);
      return;
    }
    const diagnostics = compilation.diagnostics.map((diagnostic) =>
      toVscodeDiagnostic(document, diagnostic),
    );
    this.collection.set(document.uri, diagnostics);
  }

  private presentOutcome(outcome: MioGraphGenerationOutcome): void {
    if (!outcome.ok) {
      const message = `Mio Graph: ${outcome.message ?? 'generation failed.'}`;
      void vscode.window
        .showErrorMessage(message, 'Open Output')
        .then((choice) => {
          if (choice === 'Open Output') {
            this.deps.output.show(true);
          }
        });
      return;
    }
    if (outcome.validation === 'failed' || outcome.validation === 'toolError') {
      void vscode.window
        .showErrorMessage(
          `Mio Graph: generated ${path.basename(
            outcome.targetPath ?? 'source',
          )}, but mio check reported problems. ${
            outcome.message ?? ''
          }`.trim(),
          'Open Output',
        )
        .then((choice) => {
          if (choice === 'Open Output') {
            this.deps.output.show(true);
          }
        });
      return;
    }
    const targetName = path.basename(outcome.targetPath ?? '');
    if (outcome.written) {
      void vscode.window.showInformationMessage(
        `Mio Graph: generated ${targetName}.`,
      );
    } else {
      void vscode.window.showInformationMessage(
        `Mio Graph: ${targetName} is already up to date.`,
      );
    }
  }

  private failure(message: string): MioGraphGenerationOutcome {
    this.deps.output.appendLine(`[graph] ${message}`);
    return {
      ok: false,
      written: false,
      opened: false,
      diagnostics: [],
      validation: 'skipped',
      message,
    };
  }
}

async function readFileIfExists(
  filePath: string,
): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function toVscodeDiagnostic(
  document: vscode.TextDocument,
  diagnostic: GraphDiagnostic,
): vscode.Diagnostic {
  const range = locateDiagnosticRange(document, diagnostic);
  const item = new vscode.Diagnostic(
    range,
    `${diagnostic.message}${
      diagnostic.hint === undefined ? '' : ` (${diagnostic.hint})`
    }`,
    severityToVscode(diagnostic.severity),
  );
  item.code = diagnostic.code;
  item.source = 'mio-graph';
  return item;
}

function severityToVscode(
  severity: GraphDiagnostic['severity'],
): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

// 第一版没有保存节点在 JSON 文本中的位置，用节点/引脚 ID 做最佳努力定位。
function locateDiagnosticRange(
  document: vscode.TextDocument,
  diagnostic: GraphDiagnostic,
): vscode.Range {
  const text = document.getText();
  for (const id of [diagnostic.nodeId, diagnostic.pinId, diagnostic.connectionId]) {
    if (id === undefined || id === '') {
      continue;
    }
    const index = text.indexOf(`"${id}"`);
    if (index < 0) {
      continue;
    }
    return new vscode.Range(
      document.positionAt(index),
      document.positionAt(index + id.length + 2),
    );
  }
  return new vscode.Range(0, 0, 0, 0);
}
