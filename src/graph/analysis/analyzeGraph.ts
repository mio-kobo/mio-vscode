// Graph 语义分析与调度：
//   1. 通过 exec 连接确定语句顺序（绝不使用节点在 JSON 中的顺序）。
//   2. 为数据依赖构建带优先级的表达式树。
//   3. 为有副作用或扇出大于 1 的表达式分配稳定临时变量。
//   4. 输出与 Mio 语法无关的 Graph IR。

import {
  GraphDiagnosticCodes,
  graphError,
  graphWarning,
  type GraphDiagnostic,
} from '../diagnostics';
import {
  MIO_GRAPH_RESERVED_PREFIX,
  graphPinId,
  normalizeMioTypeName,
  type GraphConnection,
  type GraphLiteral,
  type GraphNode,
  type GraphPin,
  type GraphVariableDeclaration,
  type MioDataTypeName,
  type MioGraph,
  type MioTypeName,
} from '../model/types';
import { readEntryConfiguration } from '../model/nodeRegistry';
import type { FunctionSignatureProvider } from '../signatures';
import type {
  IrBinaryExpression,
  IrCallExpression,
  IrExpression,
  IrProgram,
  IrStatement,
  IrUnaryExpression,
} from '../ir/ir';
import type { ValidatedGraph } from '../validation/validateGraph';

export interface AnalyzeGraphOptions {
  signatures: FunctionSignatureProvider;
}

export interface AnalyzeGraphResult {
  diagnostics: GraphDiagnostic[];
  program?: IrProgram;
}

interface StatementBuild {
  pre: IrStatement[];
  materialized: Map<string, string>;
}

interface ExecTemp {
  name: string;
  type: MioDataTypeName;
  scope: number;
}

const MATH_OPERATORS: Record<string, string | undefined> = {
  Add: '+',
  Subtract: '-',
  Multiply: '*',
  Divide: '/',
};

const COMPARISON_OPERATORS: Record<string, string | undefined> = {
  Equal: '==',
  NotEqual: '!=',
  GreaterThan: '>',
  GreaterThanOrEqual: '>=',
  LessThan: '<',
  LessThanOrEqual: '<=',
};

const LOGICAL_OPERATORS: Record<string, string | undefined> = {
  And: '&&',
  Or: '||',
};

export function analyzeGraph(
  graph: MioGraph,
  validation: ValidatedGraph,
  options: AnalyzeGraphOptions,
): AnalyzeGraphResult {
  const diagnostics: GraphDiagnostic[] = [];
  const entry = validation.entry;
  if (entry === undefined) {
    return { diagnostics };
  }

  const entryConfiguration = readEntryConfiguration(entry, graph.kind);
  diagnostics.push(...entryConfiguration.diagnostics);

  const nodesById = validation.nodesById;
  const pinsById = validation.pinsById;
  const pinTypes = validation.pinTypes;

  // 作用域：函数体为 0；每个 if 分支建立子作用域，避免引用其他分支的临时变量。
  const scopeParents: number[] = [-1];
  let nextScopeId = 1;
  const createScope = (parent: number): number => {
    const id = nextScopeId;
    nextScopeId += 1;
    scopeParents[id] = parent;
    return id;
  };
  const isScopeVisible = (ancestor: number, scope: number): boolean => {
    let current: number | undefined = scope;
    while (current !== undefined && current >= 0) {
      if (current === ancestor) {
        return true;
      }
      current = scopeParents[current];
    }
    return false;
  };

  let tempIndex = 0;
  const allocateTemp = (): string => {
    const name = `${MIO_GRAPH_RESERVED_PREFIX}t${tempIndex}`;
    tempIndex += 1;
    return name;
  };

  const execTemps = new Map<string, ExecTemp>();
  const functionScope = 0;

  const outputFanOut = (pinId: string): number =>
    validation.connectionsByOutputPin.get(pinId)?.length ?? 0;

  const inputConnection = (
    nodeId: string,
    pinName: string,
  ): GraphConnection | undefined =>
    validation.connectionsByInputPin.get(graphPinId(nodeId, pinName));

  const execTarget = (
    nodeId: string,
    pinName: string,
  ): string | undefined => {
    const connections = validation.connectionsByOutputPin.get(
      graphPinId(nodeId, pinName),
    );
    return connections?.[0]?.to.nodeId;
  };

  const signatureProvider = options.signatures;
  const signatureOf = (node: GraphNode) => {
    const name = node.params['function'];
    return typeof name === 'string' ? signatureProvider.resolve(name) : undefined;
  };

  const entryParameterNames = new Map<string, string>();
  entryConfiguration.parameters.forEach((parameter, index) => {
    entryParameterNames.set(
      graphPinId(entry.id, `param_${index}`),
      parameter.name,
    );
  });

  const requireDataType = (pinId: string): MioDataTypeName => {
    const resolved = pinTypes.get(pinId);
    if (resolved !== undefined) {
      return resolved;
    }
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.internalError,
        `internal error: no resolved data type for pin "${pinId}"`,
        { pinId },
      ),
    );
    return 'int64';
  };

  const requireExpression = (
    nodeId: string,
    pinName: string,
    build: StatementBuild,
  ): IrExpression => {
    const expression = expressionForInput(nodeId, pinName, build);
    if (expression !== undefined) {
      return expression;
    }
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.internalError,
        `internal error: input "${graphPinId(nodeId, pinName)}" has no value`,
        { nodeId, pinId: graphPinId(nodeId, pinName) },
      ),
    );
    return { kind: 'literal', literal: 0, type: 'int64' };
  };

  const expressionForInput = (
    nodeId: string,
    pinName: string,
    build: StatementBuild,
  ): IrExpression | undefined => {
    const pinId = graphPinId(nodeId, pinName);
    const connection = validation.connectionsByInputPin.get(pinId);
    if (connection !== undefined) {
      return expressionForOutput(
        connection.from.nodeId,
        connection.from.pinId,
        build,
      );
    }
    const pin = pinsById.get(pinId);
    if (pin !== undefined && pin.defaultValue !== undefined && pin.dataType !== undefined) {
      return {
        kind: 'literal',
        literal: pin.defaultValue,
        type: pin.dataType,
      };
    }
    return undefined;
  };

  const expressionForOutput = (
    nodeId: string,
    pinId: string,
    build: StatementBuild,
  ): IrExpression => {
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.internalError,
          `internal error: missing node "${nodeId}"`,
          { nodeId },
        ),
      );
      return { kind: 'literal', literal: 0, type: 'int64' };
    }
    const pinName = pinId.startsWith(`${nodeId}.`)
      ? pinId.slice(nodeId.length + 1)
      : pinId;

    if (node.type === 'Entry') {
      const parameterName = entryParameterNames.get(pinId);
      if (parameterName === undefined) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.internalError,
            `internal error: unknown entry parameter pin "${pinId}"`,
            { nodeId, pinId },
          ),
        );
        return { kind: 'literal', literal: 0, type: 'int64' };
      }
      return {
        kind: 'variable',
        name: parameterName,
        type: requireDataType(pinId),
      };
    }

    if (node.type === 'FunctionCall' && pinName === 'result') {
      const anchored = execTemps.get(node.id);
      const hasExecInput = inputConnection(node.id, 'exec_in') !== undefined;
      if (!hasExecInput) {
        return buildInlineCall(node, build);
      }
      if (anchored === undefined) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.valueUsedBeforeCall,
            `value of "${node.id}" is used before its exec connection has been evaluated`,
            { nodeId: node.id, pinId },
          ),
        );
        return { kind: 'literal', literal: 0, type: 'int64' };
      }
      if (!isScopeVisible(anchored.scope, currentScope)) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.valueOutOfScope,
            `value of "${node.id}" is produced in a different branch and is not available here`,
            { nodeId: node.id, pinId },
          ),
        );
      }
      return {
        kind: 'variable',
        name: anchored.name,
        type: anchored.type,
        nodeId: node.id,
      };
    }

    // 计算型节点在扇出大于 1 时物化为临时变量，避免重复求值。
    const computed =
      node.type === 'Add' ||
      node.type === 'Subtract' ||
      node.type === 'Multiply' ||
      node.type === 'Divide' ||
      node.type === 'Equal' ||
      node.type === 'NotEqual' ||
      node.type === 'GreaterThan' ||
      node.type === 'GreaterThanOrEqual' ||
      node.type === 'LessThan' ||
      node.type === 'LessThanOrEqual' ||
      node.type === 'And' ||
      node.type === 'Or' ||
      node.type === 'Not';
    if (computed && outputFanOut(pinId) > 1) {
      const cached = build.materialized.get(pinId);
      if (cached !== undefined) {
        return {
          kind: 'variable',
          name: cached,
          type: requireDataType(pinId),
          nodeId: node.id,
        };
      }
      const type = requireDataType(pinId);
      const expression = buildNodeValue(node, pinName, build);
      const temp = allocateTemp();
      build.pre.push({
        kind: 'declare',
        name: temp,
        type,
        expression,
        nodeId: node.id,
      });
      build.materialized.set(pinId, temp);
      return { kind: 'variable', name: temp, type, nodeId: node.id };
    }

    return buildNodeValue(node, pinName, build);
  };

  const buildNodeValue = (
    node: GraphNode,
    pinName: string,
    build: StatementBuild,
  ): IrExpression => {
    switch (node.type) {
      case 'Constant': {
        const type = requireDataType(graphPinId(node.id, 'value'));
        const value = node.params['value'];
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        ) {
          return { kind: 'literal', literal: value, type, nodeId: node.id };
        }
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.internalError,
            `internal error: constant "${node.id}" has no literal value`,
            { nodeId: node.id },
          ),
        );
        return { kind: 'literal', literal: 0, type, nodeId: node.id };
      }
      case 'VariableGet': {
        const name = node.params['variable'];
        if (typeof name !== 'string') {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.internalError,
              `internal error: variable node "${node.id}" has no variable name`,
              { nodeId: node.id },
            ),
          );
          return { kind: 'literal', literal: 0, type: 'int64' };
        }
        return {
          kind: 'variable',
          name,
          type: requireDataType(graphPinId(node.id, 'value')),
          nodeId: node.id,
        };
      }
      case 'FunctionCall':
        return buildInlineCall(node, build);
      case 'Not': {
        const operand = requireExpression(node.id, 'value', build);
        const expression: IrUnaryExpression = {
          kind: 'unary',
          operator: '!',
          operand,
          type: 'bool',
          nodeId: node.id,
        };
        return expression;
      }
      default: {
        const mathOperator = MATH_OPERATORS[node.type];
        const comparisonOperator = COMPARISON_OPERATORS[node.type];
        const logicalOperator = LOGICAL_OPERATORS[node.type];
        const operator = mathOperator ?? comparisonOperator ?? logicalOperator;
        if (operator === undefined) {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.internalError,
              `internal error: node "${node.id}" (${node.type}) cannot produce a value`,
              { nodeId: node.id, pinId: graphPinId(node.id, pinName) },
            ),
          );
          return { kind: 'literal', literal: 0, type: 'int64' };
        }
        const left = requireExpression(node.id, 'a', build);
        const right = requireExpression(node.id, 'b', build);
        const resultType: MioDataTypeName =
          mathOperator === undefined
            ? 'bool'
            : requireDataType(graphPinId(node.id, 'result'));
        const expression: IrBinaryExpression = {
          kind: 'binary',
          operator,
          left,
          right,
          type: resultType,
          nodeId: node.id,
        };
        return expression;
      }
    }
  };

  const buildInlineCall = (
    node: GraphNode,
    build: StatementBuild,
  ): IrCallExpression => {
    const signature = signatureOf(node);
    const name = node.params['function'];
    if (signature === undefined || typeof name !== 'string') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.internalError,
          `internal error: function node "${node.id}" has no signature`,
          { nodeId: node.id },
        ),
      );
      return {
        kind: 'call',
        name: 'chant',
        arguments: [],
        type: 'unit',
        nodeId: node.id,
      };
    }
    const args = signature.parameters.map((_parameter, index) =>
      requireExpression(node.id, `arg_${index}`, build),
    );
    return {
      kind: 'call',
      name,
      arguments: args,
      type: signReturnType(signature.returnType),
      nodeId: node.id,
    };
  };

  const signReturnType = (type: MioTypeName): MioTypeName =>
    normalizeMioTypeName(type);

  // 构建一条直线执行链；Branch/Sequence 会递归展开子链。
  let currentScope = functionScope;

  const buildChain = (startNodeId: string | undefined, scope: number): IrStatement[] => {
    const statements: IrStatement[] = [];
    const previousScope = currentScope;
    currentScope = scope;
    try {
      let current = startNodeId;
      const visited = new Set<string>();
      while (current !== undefined) {
        if (visited.has(current)) {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.execCycle,
              `execution flow revisits node "${current}"`,
              { nodeId: current },
            ),
          );
          break;
        }
        visited.add(current);
        const node = nodesById.get(current);
        if (node === undefined) {
          break;
        }
        current = emitExecNode(node, scope, statements);
      }
    } finally {
      currentScope = previousScope;
    }
    return statements;
  };

  const emitExecNode = (
    node: GraphNode,
    scope: number,
    statements: IrStatement[],
  ): string | undefined => {
    const build: StatementBuild = { pre: [], materialized: new Map() };
    switch (node.type) {
      case 'Entry':
        return execTarget(node.id, 'exec_out');
      case 'VariableSet': {
        const variable = node.params['variable'];
        const connection = inputConnection(node.id, 'value');
        if (typeof variable !== 'string' || connection === undefined) {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.internalError,
              `internal error: variable set node "${node.id}" is incomplete`,
              { nodeId: node.id },
            ),
          );
          return undefined;
        }
        const expression = requireExpression(node.id, 'value', build);
        statements.push(...build.pre, {
          kind: 'assign',
          name: variable,
          expression,
          nodeId: node.id,
        });
        return execTarget(node.id, 'exec_out');
      }
      case 'Branch': {
        const condition = requireExpression(node.id, 'condition', build);
        const thenScope = createScope(scope);
        const elseScope = createScope(scope);
        const thenChain = buildChain(execTarget(node.id, 'true'), thenScope);
        const elseChain = buildChain(execTarget(node.id, 'false'), elseScope);
        statements.push(...build.pre, {
          kind: 'if',
          condition,
          then: thenChain,
          otherwise: elseChain,
          nodeId: node.id,
        });
        return undefined;
      }
      case 'Sequence': {
        const pins = node.pins
          .filter((pin) => pin.kind === 'exec' && pin.direction === 'output')
          .sort((left, right) => sequencePinIndex(left) - sequencePinIndex(right));
        for (const pin of pins) {
          const connection = validation.connectionsByOutputPin.get(pin.id);
          const target = connection?.[0]?.to.nodeId;
          if (target === undefined) {
            continue;
          }
          statements.push(...buildChain(target, scope));
        }
        return undefined;
      }
      case 'FunctionCall': {
        const signature = signatureOf(node);
        if (signature === undefined) {
          diagnostics.push(
            graphError(
              GraphDiagnosticCodes.internalError,
              `internal error: function node "${node.id}" has no signature`,
              { nodeId: node.id },
            ),
          );
          return undefined;
        }
        const call = buildInlineCall(node, build);
        const resultPin = node.pins.find(
          (pin) => pin.name === 'result' && pin.kind === 'data',
        );
        const resultUsed = resultPin !== undefined && outputFanOut(resultPin.id) > 0;
        if (signature.returnType !== 'unit' && resultUsed && resultPin !== undefined) {
          const type = requireDataType(resultPin.id);
          const temp = allocateTemp();
          execTemps.set(node.id, { name: temp, type, scope });
          statements.push(...build.pre, {
            kind: 'declare',
            name: temp,
            type,
            expression: call,
            nodeId: node.id,
          });
        } else {
          statements.push(...build.pre, {
            kind: 'expression',
            expression: call,
            nodeId: node.id,
          });
        }
        return execTarget(node.id, 'exec_out');
      }
      case 'Return': {
        const valuePin = node.pins.find((pin) => pin.name === 'value');
        let expression: IrExpression | undefined;
        if (valuePin !== undefined) {
          expression = requireExpression(node.id, 'value', build);
        }
        statements.push(...build.pre, {
          kind: 'return',
          ...(expression === undefined ? {} : { expression }),
          nodeId: node.id,
        });
        return undefined;
      }
      default:
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.internalError,
            `internal error: node type "${node.type}" cannot appear in the exec flow`,
            { nodeId: node.id },
          ),
        );
        return undefined;
    }
  };

  // ---- 副作用与控制流检查 ----

  const reachable = new Set<string>();
  const reachStack: string[] = [entry.id];
  while (reachStack.length > 0) {
    const nodeId = reachStack.pop() as string;
    if (reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    const node = nodesById.get(nodeId);
    if (node === undefined) {
      continue;
    }
    for (const pin of node.pins) {
      if (pin.kind !== 'exec' || pin.direction !== 'output') {
        continue;
      }
      for (const connection of validation.connectionsByOutputPin.get(pin.id) ?? []) {
        reachStack.push(connection.to.nodeId);
      }
    }
  }

  for (const node of graph.nodes) {
    if (node.type !== 'FunctionCall' || node.pinResolutionFailed === true) {
      continue;
    }
    const signature = signatureOf(node);
    if (signature === undefined) {
      continue;
    }
    const execInputConnected =
      validation.connectionsByInputPin.has(
        graphPinId(node.id, 'exec_in'),
      );
    const resultPin = node.pins.find(
      (pin) => pin.name === 'result' && pin.kind === 'data',
    );
    const fanOut = resultPin === undefined ? 0 : outputFanOut(resultPin.id);
    if (execInputConnected && !reachable.has(node.id)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unreachableExecNode,
          `function call "${node.id}" is connected to an exec flow that does not start at Entry`,
          { nodeId: node.id },
        ),
      );
      continue;
    }
    if (!execInputConnected) {
      if (signature.returnType === 'unit') {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.unitCallOutsideExec,
            `"${signature.name}" returns unit; connect this node to the exec flow`,
            { nodeId: node.id, pinId: graphPinId(node.id, 'exec_in') },
          ),
        );
      } else if (fanOut === 0) {
        diagnostics.push(
          graphWarning(
            GraphDiagnosticCodes.deadFunctionCall,
            `function call "${node.id}" is not on the exec flow and its result is unused`,
            { nodeId: node.id },
          ),
        );
      } else if (fanOut > 1) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.impureValueReused,
            `function call "${node.id}" is evaluated where it is read; store its result in a variable or connect it to an exec flow before using it more than once`,
            { nodeId: node.id, pinId: resultPin?.id },
          ),
        );
      }
    }
  }

  // ---- 变量声明 ----

  const entryParameterSet = new Set(
    entryConfiguration.parameters.map((parameter) => parameter.name),
  );
  const variableStatements: IrStatement[] = [];
  const declaredVariables = new Set<string>();
  for (const variable of graph.metadata.variables) {
    if (entryParameterSet.has(variable.name)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.variableNameConflict,
          `graph variable "${variable.name}" conflicts with a function parameter`,
        ),
      );
      continue;
    }
    if (graph.kind === 'program' && variable.name === entryConfiguration.name) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.variableNameConflict,
          `graph variable "${variable.name}" conflicts with the generated entry function name`,
        ),
      );
      continue;
    }
    if (declaredVariables.has(variable.name)) {
      continue;
    }
    declaredVariables.add(variable.name);
    const initialValue = variable.initialValue;
    if (initialValue === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.variableInitializerRequired,
          `graph variable "${variable.name}" needs an initialValue; Mio requires initialized variables`,
        ),
      );
      continue;
    }
    variableStatements.push(variableDeclarationStatement(variable, initialValue));
  }

  const body = buildChain(entry.id, functionScope);
  const hasErrors = diagnostics.some(
    (diagnostic) => diagnostic.severity === 'error',
  );
  if (hasErrors) {
    return { diagnostics };
  }

  const program: IrProgram = {
    graphId: graph.id,
    graphVersion: graph.version,
    kind: graph.kind,
    imports: [...graph.metadata.imports],
    functionName: entryConfiguration.name,
    parameters: graph.kind === 'function' ? entryConfiguration.parameters : [],
    returnType: graph.kind === 'function' ? entryConfiguration.returnType : 'unit',
    body: [...variableStatements, ...body],
    emitEntryCall: graph.kind === 'program',
  };
  return { diagnostics, program };
}

function variableDeclarationStatement(
  variable: GraphVariableDeclaration,
  initialValue: GraphLiteral,
): IrStatement {
  return {
    kind: 'declare',
    name: variable.name,
    type: variable.type,
    expression: {
      kind: 'literal',
      literal: initialValue,
      type: variable.type,
    },
  };
}

function sequencePinIndex(pin: GraphPin): number {
  const match = /^then_(\d+)$/u.exec(pin.name);
  return match?.[1] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}
