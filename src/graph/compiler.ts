// Graph -> Mio 源码的完整流水线：
//   Graph JSON -> 解析 -> 校验 -> 语义分析(IR) -> 源码生成
// 该模块完全独立于 VS Code，可直接在 Node/测试环境中调用。

import { analyzeGraph } from './analysis/analyzeGraph';
import { generateMioSource } from './codegen/generateSource';
import {
  hasGraphErrors,
  sortGraphDiagnostics,
  type GraphDiagnostic,
} from './diagnostics';
import type { IrSourceMap } from './ir/ir';
import { parseGraphJson, parseGraphValue } from './model/parseGraph';
import type { MioGraph } from './model/types';
import {
  createSignatureProvider,
  type FunctionSignatureProvider,
} from './signatures';
import { validateGraph } from './validation/validateGraph';

export interface CompileGraphOptions {
  // 为未来从 Mio 编译器 / 语言服务获取签名预留的注入点。
  signatureProvider?: FunctionSignatureProvider;
}

export interface GraphCompilationResult {
  ok: boolean;
  diagnostics: GraphDiagnostic[];
  graph?: MioGraph;
  source?: string;
  sourceMap?: IrSourceMap;
}

export function compileMioGraphJson(
  text: string,
  options: CompileGraphOptions = {},
): GraphCompilationResult {
  const parsed = parseGraphJson(text, options);
  if (parsed.graph === undefined) {
    return {
      ok: false,
      diagnostics: sortGraphDiagnostics(parsed.diagnostics),
    };
  }
  return compileParsedGraph(parsed.graph, parsed.diagnostics, options);
}

export function compileMioGraphValue(
  value: unknown,
  options: CompileGraphOptions = {},
): GraphCompilationResult {
  const parsed = parseGraphValue(value, options);
  if (parsed.graph === undefined) {
    return {
      ok: false,
      diagnostics: sortGraphDiagnostics(parsed.diagnostics),
    };
  }
  return compileParsedGraph(parsed.graph, parsed.diagnostics, options);
}

export function compileMioGraph(
  graph: MioGraph,
  options: CompileGraphOptions = {},
): GraphCompilationResult {
  return compileParsedGraph(graph, [], options);
}

function compileParsedGraph(
  graph: MioGraph,
  parseDiagnostics: readonly GraphDiagnostic[],
  options: CompileGraphOptions,
): GraphCompilationResult {
  const diagnostics: GraphDiagnostic[] = [...parseDiagnostics];
  if (hasGraphErrors(diagnostics)) {
    return {
      ok: false,
      diagnostics: sortGraphDiagnostics(diagnostics),
      graph,
    };
  }

  const validation = validateGraph(graph);
  diagnostics.push(...validation.diagnostics);
  if (hasGraphErrors(diagnostics)) {
    return {
      ok: false,
      diagnostics: sortGraphDiagnostics(diagnostics),
      graph,
    };
  }

  const signatures = createSignatureProvider(
    graph.metadata.functions,
    options.signatureProvider,
  );
  const analysis = analyzeGraph(graph, validation, { signatures });
  diagnostics.push(...analysis.diagnostics);
  if (analysis.program === undefined || hasGraphErrors(diagnostics)) {
    return {
      ok: false,
      diagnostics: sortGraphDiagnostics(diagnostics),
      graph,
    };
  }

  const generated = generateMioSource(analysis.program);
  return {
    ok: true,
    diagnostics: sortGraphDiagnostics(diagnostics),
    graph,
    source: generated.source,
    sourceMap: generated.sourceMap,
  };
}
