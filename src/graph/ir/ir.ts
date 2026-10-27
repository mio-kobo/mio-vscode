// Graph IR：与 Mio 语法无关的语句/表达式树。
// 代码生成器只读取 IR，因此 UI 或调度策略变化不会影响源码格式化逻辑。

import type {
  GraphFunctionParameter,
  GraphKind,
  GraphLiteral,
  MioDataTypeName,
  MioTypeName,
} from '../model/types';

export interface IrLiteralExpression {
  kind: 'literal';
  literal: GraphLiteral;
  type: MioDataTypeName;
  nodeId?: string;
}

export interface IrVariableExpression {
  kind: 'variable';
  name: string;
  type: MioDataTypeName;
  nodeId?: string;
}

export interface IrBinaryExpression {
  kind: 'binary';
  operator: string;
  left: IrExpression;
  right: IrExpression;
  type: MioDataTypeName;
  nodeId?: string;
}

export interface IrUnaryExpression {
  kind: 'unary';
  operator: '!';
  operand: IrExpression;
  type: 'bool';
  nodeId?: string;
}

export interface IrCallExpression {
  kind: 'call';
  name: string;
  arguments: IrExpression[];
  type: MioTypeName;
  nodeId?: string;
}

export type IrExpression =
  | IrLiteralExpression
  | IrVariableExpression
  | IrBinaryExpression
  | IrUnaryExpression
  | IrCallExpression;

export interface IrDeclareStatement {
  kind: 'declare';
  name: string;
  type: MioDataTypeName;
  expression: IrExpression;
  nodeId?: string;
}

export interface IrAssignStatement {
  kind: 'assign';
  name: string;
  expression: IrExpression;
  nodeId?: string;
}

export interface IrExpressionStatement {
  kind: 'expression';
  expression: IrExpression;
  nodeId?: string;
}

export interface IrIfStatement {
  kind: 'if';
  condition: IrExpression;
  then: IrStatement[];
  otherwise: IrStatement[];
  nodeId?: string;
}

export interface IrReturnStatement {
  kind: 'return';
  expression?: IrExpression;
  nodeId?: string;
}

export type IrStatement =
  | IrDeclareStatement
  | IrAssignStatement
  | IrExpressionStatement
  | IrIfStatement
  | IrReturnStatement;

export interface IrProgram {
  graphId: string;
  graphVersion: number;
  kind: GraphKind;
  imports: string[];
  functionName: string;
  parameters: GraphFunctionParameter[];
  returnType: MioTypeName;
  body: IrStatement[];
  // 程序图会生成 wrapper 函数，并在文件末尾调用它。
  emitEntryCall: boolean;
}

export interface IrSourceMapEntry {
  nodeId: string;
  // 1-based、闭区间。
  startLine: number;
  endLine: number;
}

export interface IrSourceMap {
  graphId: string;
  entries: IrSourceMapEntry[];
}
