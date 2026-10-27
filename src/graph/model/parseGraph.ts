// .miog 文件（JSON）的解析与序列化。解析器负责构建稳定引脚、校验 schema，
// 并把所有问题表达为结构化诊断，而不是抛出异常。

import {
  GraphDiagnosticCodes,
  graphError,
  graphWarning,
  type GraphDiagnostic,
} from '../diagnostics';
import type { FunctionSignatureProvider } from '../signatures';
import { createSignatureProvider } from '../signatures';
import { validateCallableName, validateDeclarationName } from './identifiers';
import {
  buildNodePins,
  readEntryConfiguration,
  type EntryConfiguration,
  type NodeBuildContext,
} from './nodeRegistry';
import { validateLiteral } from './literals';
import {
  isMioGraphNodeType,
  isMioTypeName,
  MIO_GRAPH_FORMAT_VERSION,
  normalizeMioTypeName,
  type GraphConnection,
  type GraphFunctionParameter,
  type GraphFunctionSignature,
  type GraphKind,
  type GraphLiteral,
  type GraphMetadata,
  type GraphNode,
  type GraphPin,
  type GraphPosition,
  type GraphVariableDeclaration,
  type MioGraph,
  type MioDataTypeName,
  type MioTypeName,
} from './types';

export interface ParseGraphOptions {
  // 未来可由 LSP / 编译器提供额外函数签名。
  signatureProvider?: FunctionSignatureProvider;
}

export interface ParseGraphResult {
  graph?: MioGraph;
  diagnostics: GraphDiagnostic[];
}

export function parseGraphJson(
  text: string,
  options: ParseGraphOptions = {},
): ParseGraphResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      diagnostics: [
        graphError(
          GraphDiagnosticCodes.invalidJson,
          `invalid JSON: ${detail}`,
        ),
      ],
    };
  }
  return parseGraphValue(value, options);
}

export function parseGraphValue(
  value: unknown,
  options: ParseGraphOptions = {},
): ParseGraphResult {
  const diagnostics: GraphDiagnostic[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      diagnostics: [
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          'graph document must be a JSON object',
        ),
      ],
    };
  }
  const root = value as Record<string, unknown>;

  const graph = createEmptyGraph();

  const formatVersion = root['formatVersion'];
  if (
    typeof formatVersion !== 'number' ||
    !Number.isInteger(formatVersion) ||
    formatVersion < 1
  ) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'formatVersion must be a positive integer',
      ),
    );
  } else if (formatVersion > MIO_GRAPH_FORMAT_VERSION) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.unsupportedFormatVersion,
        `graph formatVersion ${formatVersion} is newer than supported version ${MIO_GRAPH_FORMAT_VERSION}`,
      ),
    );
    graph.formatVersion = formatVersion;
  } else {
    graph.formatVersion = formatVersion;
  }

  graph.id = readRequiredString(root, 'id', diagnostics, 'graph id');
  graph.version = readPositiveInteger(root, 'version', 1, diagnostics, 'version');
  graph.kind = readGraphKind(root, diagnostics);

  const metadata = parseMetadata(root['metadata'], diagnostics);
  graph.metadata = metadata;

  const signatureProvider = createSignatureProvider(
    metadata.functions,
    options.signatureProvider,
  );

  graph.nodes = parseNodes(
    root['nodes'],
    graph.kind,
    metadata.variables,
    signatureProvider,
    diagnostics,
  );
  graph.connections = parseConnections(root['connections'], diagnostics);

  validatePinUniqueness(graph.nodes, diagnostics);
  return { graph, diagnostics };
}

function createEmptyGraph(): MioGraph {
  return {
    formatVersion: MIO_GRAPH_FORMAT_VERSION,
    id: '',
    version: 1,
    kind: 'program',
    metadata: { variables: [], imports: [], functions: [] },
    nodes: [],
    connections: [],
  };
}

function readRequiredString(
  source: Record<string, unknown>,
  key: string,
  diagnostics: GraphDiagnostic[],
  label: string,
): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        `${label} must be a non-empty string`,
      ),
    );
    return '';
  }
  return value;
}

function readPositiveInteger(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  diagnostics: GraphDiagnostic[],
  label: string,
): number {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        `${label} must be a positive integer`,
      ),
    );
    return fallback;
  }
  return value;
}

function readGraphKind(
  root: Record<string, unknown>,
  diagnostics: GraphDiagnostic[],
): GraphKind {
  const value = root['kind'];
  if (value === undefined) {
    return 'program';
  }
  if (value !== 'program' && value !== 'function') {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'kind must be "program" or "function"',
      ),
    );
    return 'program';
  }
  return value;
}

function parseMetadata(
  value: unknown,
  diagnostics: GraphDiagnostic[],
): GraphMetadata {
  const metadata: GraphMetadata = {
    variables: [],
    imports: [],
    functions: [],
  };
  if (value === undefined) {
    return metadata;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'metadata must be an object',
      ),
    );
    return metadata;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw['name'] === 'string' && raw['name'].trim() !== '') {
    metadata.name = raw['name'];
  }
  if (typeof raw['description'] === 'string' && raw['description'].trim() !== '') {
    metadata.description = raw['description'];
  }
  metadata.variables = parseVariables(raw['variables'], diagnostics);
  metadata.imports = parseImports(raw['imports'], diagnostics);
  metadata.functions = parseFunctionSignatures(raw['functions'], diagnostics);
  return metadata;
}

function parseVariables(
  value: unknown,
  diagnostics: GraphDiagnostic[],
): GraphVariableDeclaration[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'metadata.variables must be an array',
      ),
    );
    return [];
  }
  const variables: GraphVariableDeclaration[] = [];
  const names = new Set<string>();
  value.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `metadata.variables[${index}] must be an object`,
        ),
      );
      return;
    }
    const entry = item as Record<string, unknown>;
    const name = entry['name'];
    if (typeof name !== 'string') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `metadata.variables[${index}].name must be a string`,
        ),
      );
      return;
    }
    const validation = validateDeclarationName(name);
    if (!validation.valid) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidDeclarationName,
          `variable "${name}" is not usable: ${validation.reason ?? ''}`,
        ),
      );
      return;
    }
    if (names.has(name)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.duplicateVariable,
          `duplicate variable "${name}"`,
        ),
      );
      return;
    }
    names.add(name);
    const type = entry['type'];
    if (!isMioTypeName(type) || type === 'unit') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `metadata.variables[${index}].type must be a Mio data type`,
        ),
      );
      return;
    }
    const normalized = normalizeMioTypeName(type) as MioDataTypeName;
    let initialValue: GraphLiteral | undefined;
    if (Object.prototype.hasOwnProperty.call(entry, 'initialValue')) {
      const rawInitial = entry['initialValue'];
      if (
        typeof rawInitial !== 'string' &&
        typeof rawInitial !== 'number' &&
        typeof rawInitial !== 'boolean'
      ) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidLiteral,
            `metadata.variables[${index}].initialValue must be a number, string or boolean`,
          ),
        );
        return;
      }
      const problem = validateLiteral(normalized, rawInitial);
      if (problem !== undefined) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidLiteral,
            `variable "${name}" initialValue: ${problem}`,
          ),
        );
        return;
      }
      initialValue = rawInitial;
    }
    variables.push({
      name,
      type: normalized,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
  });
  return variables;
}

function parseImports(
  value: unknown,
  diagnostics: GraphDiagnostic[],
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'metadata.imports must be an array',
      ),
    );
    return [];
  }
  const imports: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim() === '') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidImport,
          `metadata.imports[${index}] must be a non-empty string`,
        ),
      );
      return;
    }
    if (/[\s"\\\u0000-\u001f]/u.test(item)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidImport,
          `metadata.imports[${index}] contains characters that cannot appear in a Mio import path`,
        ),
      );
      return;
    }
    if (seen.has(item)) {
      return;
    }
    seen.add(item);
    imports.push(item);
  });
  return imports;
}

function parseFunctionSignatures(
  value: unknown,
  diagnostics: GraphDiagnostic[],
): GraphFunctionSignature[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'metadata.functions must be an array',
      ),
    );
    return [];
  }
  const signatures: GraphFunctionSignature[] = [];
  const names = new Set<string>();
  value.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `metadata.functions[${index}] must be an object`,
        ),
      );
      return;
    }
    const entry = item as Record<string, unknown>;
    const name = entry['name'];
    if (typeof name !== 'string') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `metadata.functions[${index}].name must be a string`,
        ),
      );
      return;
    }
    const nameValidation = validateCallableName(name);
    if (!nameValidation.valid) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${name}" is not usable: ${nameValidation.reason ?? ''}`,
        ),
      );
      return;
    }
    if (name === 'chant' || name === 'len') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${name}" is a Mio builtin and cannot be redeclared in a graph`,
        ),
      );
      return;
    }
    if (names.has(name)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `duplicate function signature "${name}"`,
        ),
      );
      return;
    }
    names.add(name);

    const parameters = parseSignatureParameters(
      entry['parameters'],
      name,
      diagnostics,
      index,
    );
    if (parameters === undefined) {
      return;
    }
    const returnType = entry['returnType'];
    if (!isMioTypeName(returnType)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `metadata.functions[${index}].returnType must be a Mio type name`,
        ),
      );
      return;
    }
    signatures.push({
      name,
      parameters,
      returnType: normalizeMioTypeName(returnType as MioTypeName),
    });
  });
  return signatures;
}

function parseSignatureParameters(
  value: unknown,
  functionName: string,
  diagnostics: GraphDiagnostic[],
  functionIndex: number,
): GraphFunctionParameter[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidFunctionSignature,
        `metadata.functions[${functionIndex}].parameters must be an array`,
      ),
    );
    return undefined;
  }
  const parameters: GraphFunctionParameter[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${functionName}" parameters[${index}] must be an object`,
        ),
      );
      return undefined;
    }
    const entry = item as Record<string, unknown>;
    const name = entry['name'];
    if (typeof name !== 'string') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${functionName}" parameters[${index}].name must be a string`,
        ),
      );
      return undefined;
    }
    const validation = validateDeclarationName(name);
    if (!validation.valid) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${functionName}" parameter "${name}" is not usable: ${validation.reason ?? ''}`,
        ),
      );
      return undefined;
    }
    if (names.has(name)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${functionName}" has a duplicate parameter "${name}"`,
        ),
      );
      return undefined;
    }
    names.add(name);
    const type = entry['type'];
    if (!isMioTypeName(type) || type === 'unit') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidFunctionSignature,
          `function "${functionName}" parameters[${index}].type must be a Mio data type`,
        ),
      );
      return undefined;
    }
    parameters.push({
      name,
      type: normalizeMioTypeName(type) as MioDataTypeName,
    });
  }
  return parameters;
}

function parseNodes(
  value: unknown,
  kind: GraphKind,
  variables: readonly GraphVariableDeclaration[],
  signatures: FunctionSignatureProvider,
  diagnostics: GraphDiagnostic[],
): GraphNode[] {
  const rawPins = new Map<string, unknown>();
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'nodes must be an array',
      ),
    );
    return [];
  }

  const nodes: GraphNode[] = [];
  const seenIds = new Set<string>();
  const idOf = (item: unknown): string | undefined => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return undefined;
    }
    const id = (item as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.trim() !== '' ? id : undefined;
  };

  // 第一遍：建立节点外壳并读取 Entry 配置（Return 引脚依赖返回类型）。
  const shells: GraphNode[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const id = idOf(item);
    if (id === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `nodes[${index}].id must be a non-empty string`,
        ),
      );
      continue;
    }
    if (seenIds.has(id)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.duplicateNodeId,
          `duplicate node id "${id}"`,
          { nodeId: id },
        ),
      );
      continue;
    }
    seenIds.add(id);
    const raw = item as Record<string, unknown>;
    const type = raw['type'];
    if (typeof type !== 'string' || type.trim() === '') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `nodes[${index}].type must be a non-empty string`,
          { nodeId: id },
        ),
      );
      continue;
    }
    const node: GraphNode = {
      id,
      type,
      position: readPosition(raw['position'], id, diagnostics),
      params: readParams(raw['params'], id, diagnostics),
      pins: [],
    };
    if (!isMioGraphNodeType(type)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownNodeType,
          `unsupported node type "${type}"`,
          { nodeId: id },
        ),
      );
      node.pinResolutionFailed = true;
    }
    shells.push(node);
    rawPins.set(id, raw['pins']);
    nodes.push(node);
  }

  const variableMap = new Map<string, GraphVariableDeclaration>();
  for (const variable of variables) {
    variableMap.set(variable.name, variable);
  }

  const entryConfigurations = new Map<string, EntryConfiguration>();
  let firstEntry: GraphNode | undefined;
  for (const node of shells) {
    if (node.type !== 'Entry') {
      continue;
    }
    const configuration = readEntryConfiguration(node, kind);
    entryConfigurations.set(node.id, configuration);
    diagnostics.push(...configuration.diagnostics);
    firstEntry ??= node;
  }

  const context: NodeBuildContext = {
    graphKind: kind,
    variables: variableMap,
    signatures,
    entryConfigurations,
    ...(firstEntry === undefined
      ? {}
      : { entry: entryConfigurations.get(firstEntry.id) }),
  };

  for (const node of shells) {
    if (node.pinResolutionFailed === true) {
      continue;
    }
    const result = buildNodePins(node, context);
    node.pins = result.pins;
    diagnostics.push(...result.diagnostics);
    if (hasPinResolutionFailure(node)) {
      continue;
    }
    applyPinOverrides(node, rawPins.get(node.id), diagnostics);
  }

  return nodes;
}

function hasPinResolutionFailure(node: GraphNode): boolean {
  return node.pinResolutionFailed === true;
}

function readPosition(
  value: unknown,
  nodeId: string,
  diagnostics: GraphDiagnostic[],
): GraphPosition {
  if (value === undefined) {
    return { x: 0, y: 0 };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      graphWarning(
        GraphDiagnosticCodes.invalidGraphField,
        'position must be an object with numeric x and y; using (0, 0)',
        { nodeId },
      ),
    );
    return { x: 0, y: 0 };
  }
  const raw = value as Record<string, unknown>;
  const x = raw['x'];
  const y = raw['y'];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    diagnostics.push(
      graphWarning(
        GraphDiagnosticCodes.invalidGraphField,
        'position must contain finite numeric x and y; using (0, 0)',
        { nodeId },
      ),
    );
    return { x: 0, y: 0 };
  }
  return { x, y };
}

function readParams(
  value: unknown,
  nodeId: string,
  diagnostics: GraphDiagnostic[],
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'params must be an object',
        { nodeId },
      ),
    );
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function applyPinOverrides(
  node: GraphNode,
  rawPins: unknown,
  diagnostics: GraphDiagnostic[],
): void {
  if (rawPins === undefined) {
    return;
  }
  if (!Array.isArray(rawPins)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'node pins must be an array when present',
        { nodeId: node.id },
      ),
    );
    return;
  }
  for (let index = 0; index < rawPins.length; index += 1) {
    const item = rawPins[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidPinOverride,
          `pins[${index}] must be an object`,
          { nodeId: node.id },
        ),
      );
      continue;
    }
    const raw = item as Record<string, unknown>;
    const id = raw['id'];
    const name = raw['name'];
    let pin: GraphPin | undefined;
    if (typeof id === 'string') {
      pin = node.pins.find((candidate) => candidate.id === id);
    }
    if (pin === undefined && typeof name === 'string') {
      pin = node.pins.find((candidate) => candidate.name === name);
    }
    if (pin === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownPinOverride,
          `pin override does not match any pin on ${node.type} node; pins are derived from the node type`,
          {
            nodeId: node.id,
            ...(typeof id === 'string' ? { pinId: id } : {}),
          },
        ),
      );
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(raw, 'dataType')) {
      const dataType = raw['dataType'];
      if (
        pin.kind !== 'data' ||
        !isMioTypeName(dataType) ||
        dataType === 'unit'
      ) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidPinOverride,
            `pin "${pin.id}" dataType must be a Mio data type`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      } else {
        const normalized = normalizeMioTypeName(dataType) as MioDataTypeName;
        if (pin.dataType !== undefined && pin.dataType !== normalized) {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.invalidPinOverride,
              `pin "${pin.id}" type is fixed to ${pin.dataType} and cannot be overridden`,
              { nodeId: node.id, pinId: pin.id },
            ),
          );
        } else {
          pin.dataType = normalized;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(raw, 'defaultValue')) {
      const defaultValue = raw['defaultValue'];
      if (
        typeof defaultValue !== 'string' &&
        typeof defaultValue !== 'number' &&
        typeof defaultValue !== 'boolean'
      ) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidPinOverride,
            `pin "${pin.id}" defaultValue must be a number, string or boolean`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      } else if (pin.kind !== 'data' || pin.direction !== 'input') {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidPinOverride,
            `pin "${pin.id}" defaultValue is only supported on data inputs`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      } else if (pin.dataType === undefined) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidPinOverride,
            `pin "${pin.id}" needs a dataType before it can carry a defaultValue`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      } else {
        const problem = validateLiteral(pin.dataType, defaultValue);
        if (problem !== undefined) {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.invalidPinOverride,
              `pin "${pin.id}" defaultValue: ${problem}`,
              { nodeId: node.id, pinId: pin.id },
            ),
          );
        } else {
          pin.defaultValue = defaultValue;
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(raw, 'maxConnections')) {
      const limit = raw['maxConnections'];
      const explicitDefault = pin.kind === 'exec' || pin.direction === 'input';
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1
      ) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidPinOverride,
            `pin "${pin.id}" maxConnections must be a positive integer`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      } else if (explicitDefault && limit !== 1) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.invalidPinOverride,
            `pin "${pin.id}" is an exec pin or data input and must keep maxConnections = 1`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      } else {
        pin.maxConnections = limit;
      }
    }

  }
}

function parseConnections(
  value: unknown,
  diagnostics: GraphDiagnostic[],
): GraphConnection[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidGraphField,
        'connections must be an array',
      ),
    );
    return [];
  }
  const connections: GraphConnection[] = [];
  const ids = new Set<string>();
  value.forEach((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `connections[${index}] must be an object`,
        ),
      );
      return;
    }
    const raw = item as Record<string, unknown>;
    const id = raw['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `connections[${index}].id must be a non-empty string`,
        ),
      );
      return;
    }
    if (ids.has(id)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.duplicateConnectionId,
          `duplicate connection id "${id}"`,
          { connectionId: id },
        ),
      );
      return;
    }
    ids.add(id);
    const from = readPinReference(raw['from']);
    const to = readPinReference(raw['to']);
    if (from === undefined || to === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.invalidGraphField,
          `connections[${index}] must reference from/to nodeId and pinId strings`,
          { connectionId: id },
        ),
      );
      return;
    }
    connections.push({ id, from, to });
  });
  return connections;
}

function readPinReference(
  value: unknown,
): { nodeId: string; pinId: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const nodeId = raw['nodeId'];
  const pinId = raw['pinId'];
  if (
    typeof nodeId !== 'string' ||
    nodeId.trim() === '' ||
    typeof pinId !== 'string' ||
    pinId.trim() === ''
  ) {
    return undefined;
  }
  return { nodeId, pinId };
}

function validatePinUniqueness(
  nodes: readonly GraphNode[],
  diagnostics: GraphDiagnostic[],
): void {
  const pinIds = new Set<string>();
  for (const node of nodes) {
    for (const pin of node.pins) {
      if (pinIds.has(pin.id)) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.duplicatePinId,
            `duplicate pin id "${pin.id}"`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      }
      pinIds.add(pin.id);
    }
  }
}

// ---------- 序列化 ----------

export function serializeGraph(graph: MioGraph): string {
  return `${JSON.stringify(toGraphJson(graph), null, 2)}\n`;
}

export function toGraphJson(graph: MioGraph): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    ...(graph.metadata.name === undefined
      ? {}
      : { name: graph.metadata.name }),
    ...(graph.metadata.description === undefined
      ? {}
      : { description: graph.metadata.description }),
    variables: graph.metadata.variables.map((variable) => ({
      name: variable.name,
      type: variable.type,
      ...(variable.initialValue === undefined
        ? {}
        : { initialValue: variable.initialValue }),
    })),
    imports: [...graph.metadata.imports],
    functions: graph.metadata.functions.map((signature) => ({
      name: signature.name,
      parameters: signature.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
      })),
      returnType: signature.returnType,
    })),
  };

  return {
    formatVersion: graph.formatVersion,
    id: graph.id,
    version: graph.version,
    kind: graph.kind,
    metadata,
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: { x: node.position.x, y: node.position.y },
      params: node.params,
      pins: node.pins.map((pin) => ({
        id: pin.id,
        name: pin.name,
        direction: pin.direction,
        kind: pin.kind,
        ...(pin.dataType === undefined ? {} : { dataType: pin.dataType }),
        ...(pin.required === true ? { required: true } : {}),
        ...(pin.defaultValue === undefined
          ? {}
          : { defaultValue: pin.defaultValue }),
        ...(pin.maxConnections === undefined
          ? {}
          : { maxConnections: pin.maxConnections }),
      })),
    })),
    connections: graph.connections.map((connection) => ({
      id: connection.id,
      from: { nodeId: connection.from.nodeId, pinId: connection.from.pinId },
      to: { nodeId: connection.to.nodeId, pinId: connection.to.pinId },
    })),
  };
}
