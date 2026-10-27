// 结构化 Graph 诊断。错误代码与 Node/Pin ID 一起保留，
// 这样未来的蓝图编辑器可以把诊断映射回画布元素。

export type GraphDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface GraphDiagnostic {
  code: string;
  severity: GraphDiagnosticSeverity;
  message: string;
  nodeId?: string;
  pinId?: string;
  connectionId?: string;
  hint?: string;
}

export const GraphDiagnosticCodes = {
  // 文件格式与解析
  invalidJson: 'MIOG0001',
  unsupportedFormatVersion: 'MIOG0002',
  invalidGraphField: 'MIOG0003',
  duplicateNodeId: 'MIOG0004',
  duplicatePinId: 'MIOG0005',
  duplicateConnectionId: 'MIOG0006',
  unknownNodeType: 'MIOG0007',
  invalidNodeParameter: 'MIOG0008',
  unknownPinOverride: 'MIOG0009',
  invalidPinOverride: 'MIOG0010',
  duplicateVariable: 'MIOG0011',
  invalidDeclarationName: 'MIOG0012',
  invalidFunctionSignature: 'MIOG0013',
  invalidImport: 'MIOG0014',
  invalidLiteral: 'MIOG0015',
  variableInitializerRequired: 'MIOG0017',
  variableNameConflict: 'MIOG0018',
  // 连接
  unknownConnectionNode: 'MIOG1001',
  unknownConnectionPin: 'MIOG1002',
  wrongPinDirection: 'MIOG1003',
  pinKindMismatch: 'MIOG1004',
  pinConnectionLimit: 'MIOG1005',
  duplicateConnection: 'MIOG1006',
  selfConnection: 'MIOG1007',
  // 类型
  typeMismatch: 'MIOG2001',
  missingRequiredInput: 'MIOG2002',
  incompatibleTypes: 'MIOG2004',
  cannotInferType: 'MIOG2005',
  numericTypeRequired: 'MIOG2006',
  unknownFunction: 'MIOG2007',
  // 执行流
  missingEntry: 'MIOG3001',
  multipleEntries: 'MIOG3002',
  execCycle: 'MIOG3003',
  dataCycle: 'MIOG3004',
  unreachableExecNode: 'MIOG3005',
  missingReturn: 'MIOG3006',
  valueUsedBeforeCall: 'MIOG3007',
  impureValueReused: 'MIOG3008',
  unitCallOutsideExec: 'MIOG3009',
  deadFunctionCall: 'MIOG3010',
  valueOutOfScope: 'MIOG3012',
  // 代码生成
  unsupportedStringCharacter: 'MIOG4001',
  internalError: 'MIOG4999',
} as const;

export function graphError(
  code: string,
  message: string,
  extra: Omit<GraphDiagnostic, 'code' | 'severity' | 'message'> = {},
): GraphDiagnostic {
  return { code, severity: 'error', message, ...extra };
}

export function graphWarning(
  code: string,
  message: string,
  extra: Omit<GraphDiagnostic, 'code' | 'severity' | 'message'> = {},
): GraphDiagnostic {
  return { code, severity: 'warning', message, ...extra };
}

export function hasGraphErrors(
  diagnostics: readonly GraphDiagnostic[],
): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

// 稳定排序：先按节点，再按代码；没有节点的诊断排在最前。
export function sortGraphDiagnostics(
  diagnostics: readonly GraphDiagnostic[],
): GraphDiagnostic[] {
  return [...diagnostics].sort((left, right) => {
    const leftNode = left.nodeId ?? '';
    const rightNode = right.nodeId ?? '';
    if (leftNode !== rightNode) {
      return leftNode < rightNode ? -1 : 1;
    }
    if (left.code !== right.code) {
      return left.code < right.code ? -1 : 1;
    }
    const leftPin = left.pinId ?? '';
    const rightPin = right.pinId ?? '';
    if (leftPin !== rightPin) {
      return leftPin < rightPin ? -1 : 1;
    }
    if (left.message === right.message) {
      return 0;
    }
    return left.message < right.message ? -1 : 1;
  });
}

export function formatGraphDiagnostic(diagnostic: GraphDiagnostic): string {
  const location: string[] = [];
  if (diagnostic.nodeId !== undefined) {
    location.push(`node=${diagnostic.nodeId}`);
  }
  if (diagnostic.pinId !== undefined) {
    location.push(`pin=${diagnostic.pinId}`);
  }
  if (diagnostic.connectionId !== undefined) {
    location.push(`connection=${diagnostic.connectionId}`);
  }
  const suffix = location.length === 0 ? '' : ` [${location.join(', ')}]`;
  return `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}${suffix}`;
}
