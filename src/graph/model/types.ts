// Mio Graph 的纯数据模型。此文件不依赖 VS Code，也不包含任何 UI 逻辑，
// 因此蓝图核心可以在扩展宿主之外被解析、验证、编译与测试。

export const MIO_GRAPH_FORMAT_VERSION = 1;
export const MIO_GRAPH_FILE_EXTENSION = '.miog';
// 生成器保留的前缀：任何蓝图变量、函数或参数都不能占用它。
export const MIO_GRAPH_RESERVED_PREFIX = '__mio_graph_';

export type GraphKind = 'program' | 'function';

// Mio v1 的基础类型。rune 是 int32 的别名，解析时统一归一化为 int32。
export type MioTypeName =
  | 'int8'
  | 'int16'
  | 'int32'
  | 'rune'
  | 'int64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'float32'
  | 'float64'
  | 'bool'
  | 'string'
  | 'unit';

export type MioDataTypeName = Exclude<MioTypeName, 'unit'>;

export const MIO_DATA_TYPE_NAMES: readonly MioDataTypeName[] = [
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'float32',
  'float64',
  'bool',
  'string',
];

export const MIO_INTEGER_TYPE_NAMES: readonly MioDataTypeName[] = [
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
];

export const MIO_FLOAT_TYPE_NAMES: readonly MioDataTypeName[] = [
  'float32',
  'float64',
];

export function normalizeMioTypeName(name: MioTypeName): MioTypeName {
  return name === 'rune' ? 'int32' : name;
}

export function isMioTypeName(value: unknown): value is MioTypeName {
  return (
    value === 'int8' ||
    value === 'int16' ||
    value === 'int32' ||
    value === 'rune' ||
    value === 'int64' ||
    value === 'uint8' ||
    value === 'uint16' ||
    value === 'uint32' ||
    value === 'float32' ||
    value === 'float64' ||
    value === 'bool' ||
    value === 'string' ||
    value === 'unit'
  );
}

export function isMioDataTypeName(value: unknown): value is MioDataTypeName {
  return isMioTypeName(value) && value !== 'unit';
}

export function isNumericMioType(type: MioTypeName): boolean {
  return (
    type === 'int8' ||
    type === 'int16' ||
    type === 'int32' ||
    type === 'int64' ||
    type === 'uint8' ||
    type === 'uint16' ||
    type === 'uint32' ||
    type === 'float32' ||
    type === 'float64'
  );
}

export function isFloatMioType(type: MioTypeName): boolean {
  return type === 'float32' || type === 'float64';
}

export function isIntegerMioType(type: MioTypeName): boolean {
  return isNumericMioType(type) && !isFloatMioType(type);
}

// 字面量只使用 JSON 可表达的值；mu/数组/结构体不属于第一阶段范围。
export type GraphLiteral = string | number | boolean;

export type PinDirection = 'input' | 'output';
export type PinKind = 'exec' | 'data';

export interface GraphPin {
  // 稳定 ID：`${nodeId}.${name}`，连接只引用这些 ID。
  id: string;
  // 节点内部语义名，例如 exec_in / exec_out / a / b / value / result / then_0。
  name: string;
  direction: PinDirection;
  kind: PinKind;
  // 数据引脚的类型。undefined 表示待推断（或内置函数的 any 参数）。
  dataType?: MioDataTypeName;
  // 数据输入是否必须有连接或默认值。
  required?: boolean;
  defaultValue?: GraphLiteral;
  // 显式连接上限；undefined 使用方向与类型的默认上限。
  maxConnections?: number;
}

// 执行引脚与数据输入默认只允许一条连接；数据输出默认不限制。
export const DEFAULT_PIN_CONNECTION_LIMIT = 1;

export function pinConnectionLimit(pin: GraphPin): number {
  if (pin.maxConnections !== undefined) {
    return pin.maxConnections;
  }
  if (pin.kind === 'exec' || pin.direction === 'input') {
    return DEFAULT_PIN_CONNECTION_LIMIT;
  }
  return Number.POSITIVE_INFINITY;
}

export interface GraphPosition {
  x: number;
  y: number;
}

export type GraphNodeParams = Record<string, unknown>;

export interface GraphNode {
  id: string;
  type: string;
  position: GraphPosition;
  params: GraphNodeParams;
  pins: GraphPin[];
  // 解析阶段无法构建引脚（未知节点类型、未知变量或函数）时置位。
  // 该标记不参与序列化，只用于让后续校验跳过二次噪声诊断。
  pinResolutionFailed?: boolean;
}

export interface GraphPinReference {
  nodeId: string;
  pinId: string;
}

export interface GraphConnection {
  id: string;
  from: GraphPinReference;
  to: GraphPinReference;
}

export interface GraphVariableDeclaration {
  name: string;
  type: MioDataTypeName;
  initialValue?: GraphLiteral;
}

export interface GraphFunctionParameter {
  name: string;
  type: MioDataTypeName;
}

export interface GraphFunctionSignature {
  // 可调用名，允许包内限定名，例如 "math.sqrt"。
  name: string;
  parameters: GraphFunctionParameter[];
  returnType: MioTypeName;
}

export interface GraphMetadata {
  name?: string;
  description?: string;
  variables: GraphVariableDeclaration[];
  imports: string[];
  functions: GraphFunctionSignature[];
}

export interface MioGraph {
  formatVersion: number;
  id: string;
  version: number;
  kind: GraphKind;
  metadata: GraphMetadata;
  nodes: GraphNode[];
  connections: GraphConnection[];
}

export const MIO_GRAPH_NODE_TYPES = [
  'Entry',
  'Return',
  'Constant',
  'VariableGet',
  'VariableSet',
  'Add',
  'Subtract',
  'Multiply',
  'Divide',
  'Equal',
  'NotEqual',
  'GreaterThan',
  'GreaterThanOrEqual',
  'LessThan',
  'LessThanOrEqual',
  'And',
  'Or',
  'Not',
  'Branch',
  'Sequence',
  'FunctionCall',
] as const;

export type MioGraphNodeType = (typeof MIO_GRAPH_NODE_TYPES)[number];

export type MioGraphNodeCategory =
  | 'entry'
  | 'flow'
  | 'variable'
  | 'constant'
  | 'math'
  | 'logic'
  | 'function';

export function isMioGraphNodeType(value: string): value is MioGraphNodeType {
  return (MIO_GRAPH_NODE_TYPES as readonly string[]).includes(value);
}

export function graphPinId(nodeId: string, pinName: string): string {
  return `${nodeId}.${pinName}`;
}
