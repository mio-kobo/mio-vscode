// Mio Graph 的公共 API。未来的 React Flow 编辑器、测试和 VS Code 命令
// 都通过这里使用蓝图核心，而无需接触内部实现。

export {
  compileMioGraph,
  compileMioGraphJson,
  compileMioGraphValue,
} from './compiler';
export type {
  CompileGraphOptions,
  GraphCompilationResult,
} from './compiler';

export {
  GraphDiagnosticCodes,
  formatGraphDiagnostic,
  graphError,
  graphWarning,
  hasGraphErrors,
  sortGraphDiagnostics,
} from './diagnostics';
export type {
  GraphDiagnostic,
  GraphDiagnosticSeverity,
} from './diagnostics';

export {
  DEFAULT_PIN_CONNECTION_LIMIT,
  MIO_DATA_TYPE_NAMES,
  MIO_FLOAT_TYPE_NAMES,
  MIO_GRAPH_FILE_EXTENSION,
  MIO_GRAPH_FORMAT_VERSION,
  MIO_GRAPH_NODE_TYPES,
  MIO_GRAPH_RESERVED_PREFIX,
  MIO_INTEGER_TYPE_NAMES,
  graphPinId,
  isFloatMioType,
  isIntegerMioType,
  isMioDataTypeName,
  isMioGraphNodeType,
  isMioTypeName,
  isNumericMioType,
  normalizeMioTypeName,
  pinConnectionLimit,
} from './model/types';
export type {
  GraphConnection,
  GraphFunctionParameter,
  GraphFunctionSignature,
  GraphKind,
  GraphLiteral,
  GraphMetadata,
  GraphNode,
  GraphNodeParams,
  GraphPin,
  GraphPinReference,
  GraphPosition,
  GraphVariableDeclaration,
  MioDataTypeName,
  MioGraph,
  MioGraphNodeCategory,
  MioGraphNodeType,
  MioTypeName,
  PinDirection,
  PinKind,
} from './model/types';

export {
  parseGraphJson,
  parseGraphValue,
  serializeGraph,
  toGraphJson,
} from './model/parseGraph';
export type { ParseGraphOptions, ParseGraphResult } from './model/parseGraph';

export {
  DEFAULT_ENTRY_FUNCTION_NAME,
  MAX_SEQUENCE_BRANCHES,
  buildNodePins,
  nodeCategory,
  nodeRequiresExecFlow,
  nodeTypeGroups,
  nodeValueOutputPinName,
  readEntryConfiguration,
} from './model/nodeRegistry';
export type {
  EntryConfiguration,
  NodeBuildContext,
  NodePinBuildResult,
} from './model/nodeRegistry';

export {
  MIO_BUILTIN_FUNCTION_NAMES,
  MIO_KEYWORDS,
  MIO_PRIMITIVE_TYPE_NAMES,
  isMioIdentifier,
  isReservedMioIdentifier,
  validateCallableName,
  validateDeclarationName,
} from './model/identifiers';
export type { IdentifierValidation } from './model/identifiers';

export {
  formatMioLiteral,
  validateLiteral,
} from './model/literals';

export {
  BUILTIN_FUNCTION_SIGNATURES,
  CompositeFunctionSignatureProvider,
  StaticFunctionSignatureProvider,
  createGraphSignatureProvider,
  createSignatureProvider,
  signaturesFromMetadata,
} from './signatures';
export type {
  FunctionSignatureProvider,
  MioFunctionParameter,
  MioFunctionSignature,
  MioParameterType,
} from './signatures';

export {
  generateMioSource,
  formatExpression,
  MIO_GRAPH_GENERATED_MARKER,
} from './codegen/generateSource';
export type { GenerateSourceResult } from './codegen/generateSource';
export { MioCodeWriter } from './codegen/codeWriter';

export { validateGraph } from './validation/validateGraph';
export type { ValidatedGraph } from './validation/validateGraph';
export { analyzeGraph } from './analysis/analyzeGraph';
export type {
  AnalyzeGraphOptions,
  AnalyzeGraphResult,
} from './analysis/analyzeGraph';

export type {
  IrExpression,
  IrProgram,
  IrSourceMap,
  IrSourceMapEntry,
  IrStatement,
} from './ir/ir';
