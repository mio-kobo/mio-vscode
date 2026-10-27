// 节点类型注册表：为每种蓝图节点生成引脚、校验参数。
// 这里是 Graph Model 与具体节点语义的唯一连接点，未来增加节点只需扩展此文件。

import {
  GraphDiagnosticCodes,
  graphError,
  type GraphDiagnostic,
} from '../diagnostics';
import type { FunctionSignatureProvider } from '../signatures';
import { validateCallableName, validateDeclarationName } from './identifiers';
import { validateLiteral } from './literals';
import {
  graphPinId,
  isMioTypeName,
  isNumericMioType,
  normalizeMioTypeName,
  type GraphFunctionParameter,
  type GraphKind,
  type GraphLiteral,
  type GraphNode,
  type GraphPin,
  type GraphVariableDeclaration,
  type MioDataTypeName,
  type MioGraphNodeCategory,
  type MioGraphNodeType,
  type MioTypeName,
  type PinDirection,
} from './types';

export interface EntryConfiguration {
  name: string;
  returnType: MioTypeName;
  parameters: GraphFunctionParameter[];
  resolved: boolean;
  diagnostics: GraphDiagnostic[];
}

export interface NodeBuildContext {
  graphKind: GraphKind;
  variables: Map<string, GraphVariableDeclaration>;
  signatures: FunctionSignatureProvider;
  // 由解析器预先读取的第一个 Entry 配置，Return 节点依赖它确定返回类型。
  entry?: EntryConfiguration;
  // 每个 Entry 节点的配置，避免重复读取参数产生重复诊断。
  entryConfigurations: Map<string, EntryConfiguration>;
}

export interface NodePinBuildResult {
  pins: GraphPin[];
  diagnostics: GraphDiagnostic[];
}

export const DEFAULT_ENTRY_FUNCTION_NAME = 'mio_graph_main';
const MAX_SEQUENCE_BRANCHES = 64;

function execInputPin(nodeId: string): GraphPin {
  return {
    id: graphPinId(nodeId, 'exec_in'),
    name: 'exec_in',
    direction: 'input',
    kind: 'exec',
  };
}

function execOutputPin(nodeId: string, name = 'exec_out'): GraphPin {
  return {
    id: graphPinId(nodeId, name),
    name,
    direction: 'output',
    kind: 'exec',
  };
}

function dataPin(
  nodeId: string,
  name: string,
  direction: PinDirection,
  dataType?: MioDataTypeName,
  required = false,
): GraphPin {
  return {
    id: graphPinId(nodeId, name),
    name,
    direction,
    kind: 'data',
    ...(dataType === undefined ? {} : { dataType }),
    ...(required ? { required: true } : {}),
  };
}

function dataInputPin(
  nodeId: string,
  name: string,
  dataType?: MioDataTypeName,
  required = true,
): GraphPin {
  return dataPin(nodeId, name, 'input', dataType, required);
}

function dataOutputPin(
  nodeId: string,
  name: string,
  dataType?: MioDataTypeName,
): GraphPin {
  return dataPin(nodeId, name, 'output', dataType, false);
}

function boolOutput(nodeId: string): GraphPin {
  return dataOutputPin(nodeId, 'result', 'bool');
}

function boolInputs(nodeId: string): GraphPin[] {
  return [
    dataInputPin(nodeId, 'a', 'bool'),
    dataInputPin(nodeId, 'b', 'bool'),
  ];
}

class ParamReader {
  readonly diagnostics: GraphDiagnostic[] = [];

  constructor(
    private readonly node: GraphNode,
    private readonly params: Record<string, unknown>,
  ) {}

  string(key: string, required: boolean): string | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) {
        this.fail(`missing required parameter "${key}"`);
      }
      return undefined;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.fail(`parameter "${key}" must be a non-empty string`);
      return undefined;
    }
    return value;
  }

  dataType(key: string, required: boolean): MioDataTypeName | undefined {
    const value = this.params[key];
    if (value === undefined) {
      if (required) {
        this.fail(`missing required parameter "${key}"`);
      }
      return undefined;
    }
    if (!isMioTypeName(value) || value === 'unit') {
      this.fail(
        `parameter "${key}" must be a Mio data type (int8..int64, uint8..uint32, float32, float64, bool, string)`,
      );
      return undefined;
    }
    const normalized = normalizeMioTypeName(value);
    return normalized === 'unit' ? undefined : normalized;
  }

  literal(key: string, type: MioDataTypeName | undefined): GraphLiteral | undefined {
    if (!Object.prototype.hasOwnProperty.call(this.params, key)) {
      this.fail(`missing required parameter "${key}"`);
      return undefined;
    }
    const value = this.params[key];
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      this.fail(`parameter "${key}" must be a number, string or boolean`);
      return undefined;
    }
    if (type !== undefined) {
      const problem = validateLiteral(type, value);
      if (problem !== undefined) {
        this.diagnostics.push(
          graphError(GraphDiagnosticCodes.invalidLiteral, problem, {
            nodeId: this.node.id,
            pinId: graphPinId(this.node.id, key),
          }),
        );
        return undefined;
      }
    }
    return value;
  }

  integer(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = this.params[key];
    if (value === undefined) {
      return fallback;
    }
    if (!Number.isInteger(value) || typeof value !== 'number') {
      this.fail(`parameter "${key}" must be an integer`);
      return fallback;
    }
    if (value < min || value > max) {
      this.fail(`parameter "${key}" must be between ${min} and ${max}`);
      return fallback;
    }
    return value;
  }

  fail(message: string): void {
    this.diagnostics.push(
      graphError(GraphDiagnosticCodes.invalidNodeParameter, message, {
        nodeId: this.node.id,
      }),
    );
  }
}

// Entry 的参数需要被解析器提前读取：Return 的 value 引脚类型取自这里。
export function readEntryConfiguration(
  node: GraphNode,
  graphKind: GraphKind,
): EntryConfiguration {
  const reader = new ParamReader(node, node.params);
  let name = DEFAULT_ENTRY_FUNCTION_NAME;
  let returnType: MioTypeName = 'unit';
  let resolved = true;

  if (graphKind === 'program') {
    const configured = node.params['name'];
    if (configured !== undefined) {
      const candidate = reader.string('name', false);
      if (candidate !== undefined) {
        const validation = validateDeclarationName(candidate);
        if (!validation.valid) {
          reader.fail(
            `parameter "name" is not a usable Mio function name: ${validation.reason ?? ''}`,
          );
          resolved = false;
        } else {
          name = candidate;
        }
      } else {
        resolved = false;
      }
    }
    if (node.params['parameters'] !== undefined) {
      reader.fail('program graphs cannot declare parameters; use a function graph');
      resolved = false;
    }
    if (node.params['returnType'] !== undefined) {
      reader.fail('program graphs always return unit; returnType is not allowed');
      resolved = false;
    }
  } else {
    const configured = reader.string('name', true);
    if (configured !== undefined) {
      const validation = validateDeclarationName(configured);
      if (!validation.valid) {
        reader.fail(
          `function graph name is not usable: ${validation.reason ?? ''}`,
        );
        resolved = false;
      } else {
        name = configured;
      }
    } else {
      resolved = false;
    }

    const configuredReturnType = node.params['returnType'];
    if (configuredReturnType === undefined) {
      reader.fail('missing required parameter "returnType"');
      resolved = false;
    } else if (!isMioTypeName(configuredReturnType)) {
      reader.fail(
        'parameter "returnType" must be a Mio type name, including unit',
      );
      resolved = false;
    } else {
      returnType = normalizeMioTypeName(configuredReturnType);
    }
  }

  const parameters = readParameterList(node, reader);
  if (parameters === undefined) {
    resolved = false;
  }

  return {
    name,
    returnType,
    parameters: parameters ?? [],
    resolved,
    diagnostics: reader.diagnostics,
  };
}

function readParameterList(
  node: GraphNode,
  reader: ParamReader,
): GraphFunctionParameter[] | undefined {
  const raw = node.params['parameters'];
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    reader.fail('parameter "parameters" must be an array');
    return undefined;
  }
  const result: GraphFunctionParameter[] = [];
  const names = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      reader.fail(`parameter "parameters[${index}]" must be an object`);
      return undefined;
    }
    const entry = item as Record<string, unknown>;
    const name = entry['name'];
    const type = entry['type'];
    if (typeof name !== 'string') {
      reader.fail(`parameter "parameters[${index}].name" must be a string`);
      return undefined;
    }
    const validation = validateDeclarationName(name);
    if (!validation.valid) {
      reader.fail(
        `parameter name "${name}" is not usable: ${validation.reason ?? ''}`,
      );
      return undefined;
    }
    if (names.has(name)) {
      reader.fail(`duplicate function parameter "${name}"`);
      return undefined;
    }
    names.add(name);
    if (!isMioTypeName(type) || type === 'unit') {
      reader.fail(
        `parameter "parameters[${index}].type" must be a Mio data type`,
      );
      return undefined;
    }
    result.push({ name, type: normalizeMioTypeName(type) as MioDataTypeName });
  }
  return result;
}

export function buildNodePins(
  node: GraphNode,
  context: NodeBuildContext,
): NodePinBuildResult {
  switch (node.type as MioGraphNodeType) {
    case 'Entry':
      return buildEntryPins(node, context);
    case 'Return':
      return buildReturnPins(node, context);
    case 'Constant':
      return buildConstantPins(node);
    case 'VariableGet':
      return buildVariablePins(node, context, false);
    case 'VariableSet':
      return buildVariablePins(node, context, true);
    case 'Add':
    case 'Subtract':
    case 'Multiply':
    case 'Divide':
    case 'GreaterThan':
    case 'GreaterThanOrEqual':
    case 'LessThan':
    case 'LessThanOrEqual':
      return buildOrderedBinaryPins(node, true);
    case 'Equal':
    case 'NotEqual':
      return buildOrderedBinaryPins(node, false);
    case 'And':
    case 'Or':
      return {
        pins: [...boolInputs(node.id), boolOutput(node.id)],
        diagnostics: [],
      };
    case 'Not':
      return {
        pins: [
          dataInputPin(node.id, 'value', 'bool'),
          boolOutput(node.id),
        ],
        diagnostics: [],
      };
    case 'Branch':
      return buildBranchPins(node);
    case 'Sequence':
      return buildSequencePins(node);
    case 'FunctionCall':
      return buildFunctionCallPins(node, context);
    default:
      return {
        pins: [],
        diagnostics: [
          graphError(
            GraphDiagnosticCodes.unknownNodeType,
            `unsupported node type "${node.type}"`,
            { nodeId: node.id },
          ),
        ],
      };
  }
}

function buildEntryPins(
  node: GraphNode,
  context: NodeBuildContext,
): NodePinBuildResult {
  const diagnostics: GraphDiagnostic[] = [];
  let configuration = context.entryConfigurations.get(node.id);
  if (configuration === undefined) {
    configuration = readEntryConfiguration(node, context.graphKind);
    diagnostics.push(...configuration.diagnostics);
  }
  const pins: GraphPin[] = [execOutputPin(node.id)];
  if (context.graphKind === 'function' && configuration.parameters.length > 0) {
    configuration.parameters.forEach((parameter, index) => {
      pins.push(dataOutputPin(node.id, `param_${index}`, parameter.type));
    });
  }
  if (!configuration.resolved) {
    node.pinResolutionFailed = true;
  }
  return { pins, diagnostics };
}

function buildReturnPins(
  node: GraphNode,
  context: NodeBuildContext,
): NodePinBuildResult {
  const entry = context.entry;
  if (entry === undefined) {
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: [] };
  }
  const pins: GraphPin[] = [execInputPin(node.id)];
  if (entry.returnType !== 'unit') {
    pins.push(dataInputPin(node.id, 'value', entry.returnType as MioDataTypeName));
  }
  return { pins, diagnostics: [] };
}

function buildConstantPins(node: GraphNode): NodePinBuildResult {
  const reader = new ParamReader(node, node.params);
  const type = reader.dataType('type', true);
  if (type === undefined) {
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: reader.diagnostics };
  }
  reader.literal('value', type);
  return {
    pins: [dataOutputPin(node.id, 'value', type)],
    diagnostics: reader.diagnostics,
  };
}

function buildVariablePins(
  node: GraphNode,
  context: NodeBuildContext,
  isSet: boolean,
): NodePinBuildResult {
  const reader = new ParamReader(node, node.params);
  const name = reader.string('variable', true);
  if (name === undefined) {
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: reader.diagnostics };
  }
  const variable = context.variables.get(name);
  if (variable === undefined) {
    reader.diagnostics.push(
      graphError(
        GraphDiagnosticCodes.invalidNodeParameter,
        `unknown graph variable "${name}"; declare it in metadata.variables`,
        { nodeId: node.id },
      ),
    );
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: reader.diagnostics };
  }
  const pins: GraphPin[] = isSet
    ? [
        execInputPin(node.id),
        execOutputPin(node.id),
        dataInputPin(node.id, 'value', variable.type),
      ]
    : [dataOutputPin(node.id, 'value', variable.type)];
  return { pins, diagnostics: reader.diagnostics };
}

function buildOrderedBinaryPins(
  node: GraphNode,
  numericOnly: boolean,
): NodePinBuildResult {
  const reader = new ParamReader(node, node.params);
  const configuredType = reader.dataType('dataType', false);
  if (configuredType !== undefined && numericOnly && !isNumericMioType(configuredType)) {
    reader.fail(
      `parameter "dataType" must be a numeric Mio type for ${node.type}`,
    );
  }
  const pins: GraphPin[] = [
    dataInputPin(node.id, 'a', configuredType),
    dataInputPin(node.id, 'b', configuredType),
    dataOutputPin(
      node.id,
      'result',
      numericOnly ? configuredType : 'bool',
    ),
  ];
  return { pins, diagnostics: reader.diagnostics };
}

function buildBranchPins(node: GraphNode): NodePinBuildResult {
  return {
    pins: [
      execInputPin(node.id),
      dataInputPin(node.id, 'condition', 'bool'),
      execOutputPin(node.id, 'true'),
      execOutputPin(node.id, 'false'),
    ],
    diagnostics: [],
  };
}

function buildSequencePins(node: GraphNode): NodePinBuildResult {
  const reader = new ParamReader(node, node.params);
  const branches = reader.integer(
    'branches',
    2,
    1,
    MAX_SEQUENCE_BRANCHES,
  );
  const pins: GraphPin[] = [execInputPin(node.id)];
  for (let index = 0; index < branches; index += 1) {
    pins.push(execOutputPin(node.id, `then_${index}`));
  }
  return { pins, diagnostics: reader.diagnostics };
}

function buildFunctionCallPins(
  node: GraphNode,
  context: NodeBuildContext,
): NodePinBuildResult {
  const reader = new ParamReader(node, node.params);
  const name = reader.string('function', true);
  if (name === undefined) {
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: reader.diagnostics };
  }
  const validation = validateCallableName(name);
  if (!validation.valid) {
    reader.fail(
      `parameter "function" is not a valid callable name: ${validation.reason ?? ''}`,
    );
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: reader.diagnostics };
  }
  const signature = context.signatures.resolve(name);
  if (signature === undefined) {
    reader.diagnostics.push(
      graphError(
        GraphDiagnosticCodes.unknownFunction,
        `unknown function "${name}"; declare its signature in metadata.functions or use a Mio builtin`,
        { nodeId: node.id },
      ),
    );
    node.pinResolutionFailed = true;
    return { pins: [], diagnostics: reader.diagnostics };
  }
  const pins: GraphPin[] = [execInputPin(node.id), execOutputPin(node.id)];
  signature.parameters.forEach((parameter, index) => {
    pins.push(
      dataInputPin(
        node.id,
        `arg_${index}`,
        parameter.type === 'any' ? undefined : parameter.type,
      ),
    );
  });
  if (signature.returnType !== 'unit') {
    pins.push(
      dataOutputPin(node.id, 'result', signature.returnType as MioDataTypeName),
    );
  }
  return { pins, diagnostics: reader.diagnostics };
}

// 这些节点必须由 Entry 的执行流到达，否则它们的副作用会被静默丢弃。
export function nodeRequiresExecFlow(type: MioGraphNodeType): boolean {
  return (
    type === 'VariableSet' ||
    type === 'Branch' ||
    type === 'Sequence' ||
    type === 'Return'
  );
}

// 单个节点内部必须共享同一数据类型的引脚组。
export function nodeTypeGroups(node: GraphNode): string[][] {
  switch (node.type) {
    case 'Add':
    case 'Subtract':
    case 'Multiply':
    case 'Divide':
      return [['a', 'b', 'result']];
    case 'GreaterThan':
    case 'GreaterThanOrEqual':
    case 'LessThan':
    case 'LessThanOrEqual':
    case 'Equal':
    case 'NotEqual':
      return [['a', 'b']];
    case 'And':
    case 'Or':
      return [['a', 'b', 'result']];
    case 'Not':
      return [['value', 'result']];
    default:
      return [];
  }
}

export function isNumericOperatorNode(type: string): boolean {
  return (
    type === 'Add' ||
    type === 'Subtract' ||
    type === 'Multiply' ||
    type === 'Divide' ||
    type === 'GreaterThan' ||
    type === 'GreaterThanOrEqual' ||
    type === 'LessThan' ||
    type === 'LessThanOrEqual'
  );
}

export function nodeCategory(type: MioGraphNodeType): MioGraphNodeCategory {
  switch (type) {
    case 'Entry':
      return 'entry';
    case 'Return':
    case 'Branch':
    case 'Sequence':
      return 'flow';
    case 'Constant':
      return 'constant';
    case 'VariableGet':
    case 'VariableSet':
      return 'variable';
    case 'Add':
    case 'Subtract':
    case 'Multiply':
    case 'Divide':
      return 'math';
    case 'Equal':
    case 'NotEqual':
    case 'GreaterThan':
    case 'GreaterThanOrEqual':
    case 'LessThan':
    case 'LessThanOrEqual':
    case 'And':
    case 'Or':
    case 'Not':
      return 'logic';
    case 'FunctionCall':
      return 'function';
    default:
      return 'logic';
  }
}

// 该节点的“值输出”引脚名；Entry 的参数引脚不在此列。
export function nodeValueOutputPinName(type: MioGraphNodeType): string | undefined {
  switch (type) {
    case 'Constant':
    case 'VariableGet':
      return 'value';
    case 'Add':
    case 'Subtract':
    case 'Multiply':
    case 'Divide':
    case 'Equal':
    case 'NotEqual':
    case 'GreaterThan':
    case 'GreaterThanOrEqual':
    case 'LessThan':
    case 'LessThanOrEqual':
    case 'And':
    case 'Or':
    case 'Not':
    case 'FunctionCall':
      return 'result';
    default:
      return undefined;
  }
}

export { MAX_SEQUENCE_BRANCHES };
