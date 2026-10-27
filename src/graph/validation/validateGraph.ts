// Graph 校验：连接合法性、类型约束求解、必需输入、控制流环与执行流检查。
// 校验只读 Graph Model，不生成任何代码。

import {
  GraphDiagnosticCodes,
  graphError,
  type GraphDiagnostic,
} from '../diagnostics';
import {
  isNumericOperatorNode,
  nodeRequiresExecFlow,
  nodeTypeGroups,
} from '../model/nodeRegistry';
import {
  graphPinId,
  isMioDataTypeName,
  isMioGraphNodeType,
  isNumericMioType,
  pinConnectionLimit,
  type GraphConnection,
  type GraphNode,
  type GraphPin,
  type MioDataTypeName,
  type MioGraph,
} from '../model/types';

export interface ValidatedGraph {
  diagnostics: GraphDiagnostic[];
  graph: MioGraph;
  nodesById: Map<string, GraphNode>;
  pinsById: Map<string, GraphPin>;
  pinOwners: Map<string, string>;
  entry?: GraphNode;
  connectionsByOutputPin: Map<string, GraphConnection[]>;
  connectionsByInputPin: Map<string, GraphConnection>;
  // 数据引脚最终解析出的类型（只包含成功解析的引脚）。
  pinTypes: Map<string, MioDataTypeName>;
}

export function validateGraph(graph: MioGraph): ValidatedGraph {
  const diagnostics: GraphDiagnostic[] = [];
  const nodesById = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (!nodesById.has(node.id)) {
      nodesById.set(node.id, node);
    }
  }
  const pinsById = new Map<string, GraphPin>();
  const pinOwners = new Map<string, string>();
  for (const node of graph.nodes) {
    for (const pin of node.pins) {
      if (!pinsById.has(pin.id)) {
        pinsById.set(pin.id, pin);
        pinOwners.set(pin.id, node.id);
      }
    }
  }

  const result: ValidatedGraph = {
    diagnostics,
    graph,
    nodesById,
    pinsById,
    pinOwners,
    connectionsByOutputPin: new Map(),
    connectionsByInputPin: new Map(),
    pinTypes: new Map(),
  };

  collectEntry(graph, nodesById, result);

  const edges = collectConnectionEdges(graph, nodesById, pinsById, result);
  solveTypes(graph, nodesById, pinsById, result);
  checkRequiredInputs(graph, result);

  const dataCycle = findCycle(graph, edges.data, nodesById);
  if (dataCycle !== undefined) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.dataCycle,
        `data connections form a cycle involving node "${dataCycle}"`,
        { nodeId: dataCycle },
      ),
    );
  }

  const execCycle = findCycle(graph, edges.exec, nodesById);
  if (execCycle !== undefined) {
    diagnostics.push(
      graphError(
        GraphDiagnosticCodes.execCycle,
        `execution connections form a cycle involving node "${execCycle}"`,
        { nodeId: execCycle },
      ),
    );
  }

  // 执行流环会让可达性分析和返回路径分析失去意义，先跳过后续步骤。
  if (execCycle !== undefined) {
    return result;
  }

  checkExecReachability(graph, result, edges.exec);
  checkReturnPaths(graph, result);
  return result;
}

function collectEntry(
  graph: MioGraph,
  nodesById: Map<string, GraphNode>,
  result: ValidatedGraph,
): void {
  const entries = graph.nodes.filter((node) => node.type === 'Entry');
  if (entries.length === 0) {
    result.diagnostics.push(
      graphError(
        GraphDiagnosticCodes.missingEntry,
        'graph must contain exactly one Entry node',
      ),
    );
    return;
  }
  if (entries.length > 1) {
    for (const duplicate of entries.slice(1)) {
      result.diagnostics.push(
        graphError(
          GraphDiagnosticCodes.multipleEntries,
          `graph already has an Entry node ("${entries[0]?.id ?? ''}")`,
          { nodeId: duplicate.id },
        ),
      );
    }
  }
  const entry = entries[0];
  if (entry !== undefined && !nodesById.has(entry.id)) {
    return;
  }
  result.entry = entry;
}

interface ConnectionEdges {
  data: Map<string, string[]>;
  exec: Map<string, string[]>;
}

function collectConnectionEdges(
  graph: MioGraph,
  nodesById: Map<string, GraphNode>,
  pinsById: Map<string, GraphPin>,
  result: ValidatedGraph,
): ConnectionEdges {
  const diagnostics = result.diagnostics;
  const data = new Map<string, string[]>();
  const exec = new Map<string, string[]>();
  const seenEdges = new Set<string>();
  const outputCounts = new Map<string, number>();
  const inputCounts = new Map<string, number>();
  const reportedLimits = new Set<string>();

  const addEdge = (
    bucket: Map<string, string[]>,
    fromNodeId: string,
    toNodeId: string,
  ): void => {
    const list = bucket.get(fromNodeId);
    if (list === undefined) {
      bucket.set(fromNodeId, [toNodeId]);
    } else {
      list.push(toNodeId);
    }
  };

  for (const connection of graph.connections) {
    const fromNode = nodesById.get(connection.from.nodeId);
    if (fromNode === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownConnectionNode,
          `connection references unknown node "${connection.from.nodeId}"`,
          {
            connectionId: connection.id,
            nodeId: connection.from.nodeId,
          },
        ),
      );
      continue;
    }
    const toNode = nodesById.get(connection.to.nodeId);
    if (toNode === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownConnectionNode,
          `connection references unknown node "${connection.to.nodeId}"`,
          { connectionId: connection.id, nodeId: connection.to.nodeId },
        ),
      );
      continue;
    }

    // 引脚无法解析的节点（未知类型/变量/函数）已有根因诊断，跳过二次噪声。
    if (
      fromNode.pinResolutionFailed === true ||
      toNode.pinResolutionFailed === true
    ) {
      continue;
    }

    const fromPin = pinsById.get(connection.from.pinId);
    if (fromPin === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownConnectionPin,
          `connection references unknown pin "${connection.from.pinId}"`,
          {
            connectionId: connection.id,
            nodeId: fromNode.id,
            pinId: connection.from.pinId,
          },
        ),
      );
      continue;
    }
    const toPin = pinsById.get(connection.to.pinId);
    if (toPin === undefined) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownConnectionPin,
          `connection references unknown pin "${connection.to.pinId}"`,
          {
            connectionId: connection.id,
            nodeId: toNode.id,
            pinId: connection.to.pinId,
          },
        ),
      );
      continue;
    }

    if (result.pinOwners.get(fromPin.id) !== fromNode.id) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownConnectionPin,
          `pin "${fromPin.id}" does not belong to node "${fromNode.id}"`,
          {
            connectionId: connection.id,
            nodeId: fromNode.id,
            pinId: fromPin.id,
          },
        ),
      );
      continue;
    }
    if (result.pinOwners.get(toPin.id) !== toNode.id) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unknownConnectionPin,
          `pin "${toPin.id}" does not belong to node "${toNode.id}"`,
          {
            connectionId: connection.id,
            nodeId: toNode.id,
            pinId: toPin.id,
          },
        ),
      );
      continue;
    }

    if (fromPin.direction !== 'output' || toPin.direction !== 'input') {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.wrongPinDirection,
          'connections must go from an output pin to an input pin',
          {
            connectionId: connection.id,
            nodeId: fromNode.id,
            pinId: fromPin.direction !== 'output' ? fromPin.id : toPin.id,
          },
        ),
      );
      continue;
    }
    if (fromPin.kind !== toPin.kind) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.pinKindMismatch,
          `cannot connect ${fromPin.kind} pin "${fromPin.id}" to ${toPin.kind} pin "${toPin.id}"`,
          { connectionId: connection.id, nodeId: fromNode.id, pinId: fromPin.id },
        ),
      );
      continue;
    }

    const edgeKey = `${fromPin.id}->${toPin.id}`;
    if (seenEdges.has(edgeKey)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.duplicateConnection,
          `duplicate connection from "${fromPin.id}" to "${toPin.id}"`,
          { connectionId: connection.id, nodeId: fromNode.id, pinId: fromPin.id },
        ),
      );
      continue;
    }
    seenEdges.add(edgeKey);

    if (fromNode.id === toNode.id) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.selfConnection,
          `node "${fromNode.id}" cannot connect to itself`,
          { connectionId: connection.id, nodeId: fromNode.id, pinId: toPin.id },
        ),
      );
      continue;
    }

    const outputCount = (outputCounts.get(fromPin.id) ?? 0) + 1;
    outputCounts.set(fromPin.id, outputCount);
    const inputCount = (inputCounts.get(toPin.id) ?? 0) + 1;
    inputCounts.set(toPin.id, inputCount);

    if (
      outputCount > pinConnectionLimit(fromPin) &&
      !reportedLimits.has(fromPin.id)
    ) {
      reportedLimits.add(fromPin.id);
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.pinConnectionLimit,
          `output pin "${fromPin.id}" allows at most ${pinConnectionLimit(fromPin)} connection(s)`,
          { nodeId: fromNode.id, pinId: fromPin.id },
        ),
      );
    }
    if (
      inputCount > pinConnectionLimit(toPin) &&
      !reportedLimits.has(toPin.id)
    ) {
      reportedLimits.add(toPin.id);
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.pinConnectionLimit,
          `input pin "${toPin.id}" allows at most ${pinConnectionLimit(toPin)} connection(s)`,
          { nodeId: toNode.id, pinId: toPin.id },
        ),
      );
    }

    const existingOutputs = result.connectionsByOutputPin.get(fromPin.id);
    if (existingOutputs === undefined) {
      result.connectionsByOutputPin.set(fromPin.id, [connection]);
    } else {
      existingOutputs.push(connection);
    }
    if (!result.connectionsByInputPin.has(toPin.id)) {
      result.connectionsByInputPin.set(toPin.id, connection);
    }

    if (fromPin.kind === 'exec') {
      addEdge(exec, fromNode.id, toNode.id);
    } else {
      addEdge(data, fromNode.id, toNode.id);
    }
  }

  return { data, exec };
}

class PinTypeSolver {
  private readonly parent = new Map<string, string>();
  private readonly fixed = new Map<string, MioDataTypeName>();
  private readonly rootTypes = new Map<string, Set<MioDataTypeName>>();

  register(pinId: string): void {
    if (!this.parent.has(pinId)) {
      this.parent.set(pinId, pinId);
    }
  }

  setFixed(pinId: string, type: MioDataTypeName): void {
    this.register(pinId);
    this.fixed.set(pinId, type);
  }

  union(left: string, right: string): void {
    this.register(left);
    this.register(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    // 以字典序较小者为根，保证结果与输入顺序无关。
    if (leftRoot < rightRoot) {
      this.parent.set(rightRoot, leftRoot);
    } else {
      this.parent.set(leftRoot, rightRoot);
    }
  }

  find(pinId: string): string {
    let current = pinId;
    let parent = this.parent.get(current);
    while (parent !== undefined && parent !== current) {
      current = parent;
      parent = this.parent.get(current);
    }
    this.parent.set(pinId, current);
    return current;
  }

  finalize(): void {
    this.rootTypes.clear();
    for (const [pinId, type] of this.fixed) {
      const root = this.find(pinId);
      let types = this.rootTypes.get(root);
      if (types === undefined) {
        types = new Set();
        this.rootTypes.set(root, types);
      }
      types.add(type);
    }
  }

  typesOf(pinId: string): ReadonlySet<MioDataTypeName> {
    return this.rootTypes.get(this.find(pinId)) ?? new Set();
  }

  fixedType(pinId: string): MioDataTypeName | undefined {
    return this.fixed.get(pinId);
  }

  resolve(pinId: string): MioDataTypeName | undefined {
    if (!this.parent.has(pinId)) {
      return undefined;
    }
    const types = this.typesOf(pinId);
    if (types.size !== 1) {
      return undefined;
    }
    return types.values().next().value;
  }
}

function solveTypes(
  graph: MioGraph,
  nodesById: Map<string, GraphNode>,
  pinsById: Map<string, GraphPin>,
  result: ValidatedGraph,
): void {
  const diagnostics = result.diagnostics;
  const solver = new PinTypeSolver();

  for (const node of graph.nodes) {
    if (node.pinResolutionFailed === true) {
      continue;
    }
    for (const pin of node.pins) {
      if (pin.kind !== 'data') {
        continue;
      }
      solver.register(pin.id);
      if (pin.dataType !== undefined && isMioDataTypeName(pin.dataType)) {
        solver.setFixed(pin.id, pin.dataType);
      }
    }
  }

  // 连接两侧共享同一数据类型。
  for (const connection of graph.connections) {
    const fromPin = pinsById.get(connection.from.pinId);
    const toPin = pinsById.get(connection.to.pinId);
    if (
      fromPin === undefined ||
      toPin === undefined ||
      fromPin.kind !== 'data' ||
      toPin.kind !== 'data'
    ) {
      continue;
    }
    const fromNode = nodesById.get(connection.from.nodeId);
    const toNode = nodesById.get(connection.to.nodeId);
    if (
      fromNode?.pinResolutionFailed === true ||
      toNode?.pinResolutionFailed === true
    ) {
      continue;
    }
    solver.union(fromPin.id, toPin.id);
  }

  // 节点内部共享类型的引脚组（例如 Add 的 a/b/result）。
  for (const node of graph.nodes) {
    if (node.pinResolutionFailed === true) {
      continue;
    }
    for (const group of nodeTypeGroups(node)) {
      const groupPins = group
        .map((name) => pinsById.get(graphPinId(node.id, name)))
        .filter((pin): pin is GraphPin => pin !== undefined);
      for (let index = 1; index < groupPins.length; index += 1) {
        const first = groupPins[0];
        const current = groupPins[index];
        if (first !== undefined && current !== undefined) {
          solver.union(first.id, current.id);
        }
      }
    }
  }

  solver.finalize();

  // 记录可解析的引脚类型，供分析与代码生成使用。
  for (const [pinId] of pinsById) {
    const resolved = solver.resolve(pinId);
    if (resolved !== undefined) {
      result.pinTypes.set(pinId, resolved);
    }
  }

  // 直接连接的两端都带固定类型且不一致。
  for (const connection of graph.connections) {
    const fromPin = pinsById.get(connection.from.pinId);
    const toPin = pinsById.get(connection.to.pinId);
    if (
      fromPin === undefined ||
      toPin === undefined ||
      fromPin.kind !== 'data' ||
      toPin.kind !== 'data'
    ) {
      continue;
    }
    const fromType = solver.fixedType(fromPin.id);
    const toType = solver.fixedType(toPin.id);
    if (
      fromType !== undefined &&
      toType !== undefined &&
      fromType !== toType
    ) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.typeMismatch,
          `cannot connect ${fromType} pin "${fromPin.id}" to ${toType} pin "${toPin.id}"; Mio has no implicit conversions`,
          {
            connectionId: connection.id,
            nodeId: connection.from.nodeId,
            pinId: fromPin.id,
          },
        ),
      );
    }
  }

  // 节点内部的类型组必须唯一可解析。
  for (const node of graph.nodes) {
    if (node.pinResolutionFailed === true) {
      continue;
    }
    const groups = nodeTypeGroups(node);
    if (groups.length === 0) {
      continue;
    }
    const allTypes = new Set<MioDataTypeName>();
    const groupPinIds: string[] = [];
    let hasInferencePins = false;
    for (const group of groups) {
      for (const name of group) {
        const pin = pinsById.get(graphPinId(node.id, name));
        if (pin === undefined) {
          continue;
        }
        groupPinIds.push(pin.id);
        for (const type of solver.typesOf(pin.id)) {
          allTypes.add(type);
        }
        if (node.pins.some((candidate) => candidate.id === pin.id && candidate.dataType === undefined)) {
          hasInferencePins = true;
        }
      }
    }
    if (allTypes.size > 1) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.incompatibleTypes,
          `${node.type} node receives conflicting data types (${[...allTypes]
            .sort()
            .join(', ')})`,
          { nodeId: node.id, ...(groupPinIds[0] === undefined ? {} : { pinId: groupPinIds[0] }) },
        ),
      );
      continue;
    }
    const resolvedType = allTypes.values().next().value;
    if (resolvedType === undefined) {
      if (hasInferencePins) {
        diagnostics.push(
          graphError(
            GraphDiagnosticCodes.cannotInferType,
            `${node.type} node has no resolved data type; connect typed values or set params.dataType`,
            { nodeId: node.id },
          ),
        );
      }
      continue;
    }
    if (isNumericOperatorNode(node.type) && !isNumericMioType(resolvedType)) {
      diagnostics.push(
        graphError(
          GraphDiagnosticCodes.numericTypeRequired,
          `${node.type} requires a numeric type, got ${resolvedType}`,
          { nodeId: node.id },
        ),
      );
    }
  }
}

function checkRequiredInputs(graph: MioGraph, result: ValidatedGraph): void {
  for (const node of graph.nodes) {
    if (node.pinResolutionFailed === true) {
      continue;
    }
    for (const pin of node.pins) {
      if (
        pin.kind !== 'data' ||
        pin.direction !== 'input' ||
        pin.required !== true
      ) {
        continue;
      }
      if (
        !result.connectionsByInputPin.has(pin.id) &&
        pin.defaultValue === undefined
      ) {
        result.diagnostics.push(
          graphError(
            GraphDiagnosticCodes.missingRequiredInput,
            `required input "${pin.id}" is not connected and has no defaultValue`,
            { nodeId: node.id, pinId: pin.id },
          ),
        );
      }
    }
  }
}

// Kahn 拓扑排序：剩余节点即处于环中或环的下游。
function findCycle(
  graph: MioGraph,
  edges: Map<string, string[]>,
  nodesById: Map<string, GraphNode>,
): string | undefined {
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    inDegree.set(node.id, 0);
  }
  for (const targets of edges.values()) {
    for (const target of targets) {
      if (!nodesById.has(target)) {
        continue;
      }
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }
  const processed = new Set<string>();
  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    if (processed.has(nodeId)) {
      continue;
    }
    processed.add(nodeId);
    for (const target of edges.get(nodeId) ?? []) {
      const next = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, next);
      if (next === 0) {
        queue.push(target);
      }
    }
  }
  for (const node of graph.nodes) {
    if (!processed.has(node.id)) {
      return node.id;
    }
  }
  return undefined;
}

function checkExecReachability(
  graph: MioGraph,
  result: ValidatedGraph,
  execEdges: Map<string, string[]>,
): void {
  const entry = result.entry;
  if (entry === undefined) {
    return;
  }
  const reachable = new Set<string>();
  const stack: string[] = [entry.id];
  while (stack.length > 0) {
    const nodeId = stack.pop() as string;
    if (reachable.has(nodeId)) {
      continue;
    }
    reachable.add(nodeId);
    for (const target of execEdges.get(nodeId) ?? []) {
      stack.push(target);
    }
  }
  for (const node of graph.nodes) {
    if (!isMioGraphNodeType(node.type)) {
      continue;
    }
    if (!nodeRequiresExecFlow(node.type)) {
      continue;
    }
    if (!reachable.has(node.id)) {
      result.diagnostics.push(
        graphError(
          GraphDiagnosticCodes.unreachableExecNode,
          `${node.type} node is not reachable from Entry; its side effects would be dropped`,
          { nodeId: node.id },
        ),
      );
    }
  }
}

function checkReturnPaths(
  graph: MioGraph,
  result: ValidatedGraph,
): void {
  if (graph.kind !== 'function') {
    return;
  }
  const entry = result.entry;
  if (entry === undefined || entry.pinResolutionFailed === true) {
    return;
  }
  const returnType = readEntryReturnType(entry);
  if (returnType === undefined || returnType === 'unit') {
    return;
  }
  const visited = new Set<string>();
  const stack: string[] = [entry.id];
  const withoutReturn = new Set<string>();
  while (stack.length > 0) {
    const nodeId = stack.pop() as string;
    if (visited.has(nodeId)) {
      continue;
    }
    visited.add(nodeId);
    const node = result.nodesById.get(nodeId);
    if (node === undefined) {
      continue;
    }
    if (node.type === 'Return') {
      continue;
    }
    const execOutputs = node.pins.filter(
      (pin) => pin.kind === 'exec' && pin.direction === 'output',
    );
    if (execOutputs.length === 0) {
      withoutReturn.add(nodeId);
      continue;
    }
    for (const pin of execOutputs) {
      const connections = result.connectionsByOutputPin.get(pin.id) ?? [];
      if (connections.length === 0) {
        // 该 exec 输出没有任何后续语句，说明这条路径在此结束。
        withoutReturn.add(nodeId);
        continue;
      }
      for (const connection of connections) {
        stack.push(connection.to.nodeId);
      }
    }
  }
  for (const nodeId of withoutReturn) {
    result.diagnostics.push(
      graphError(
        GraphDiagnosticCodes.missingReturn,
        `execution path from Entry ends at "${nodeId}" without a Return node; a ${returnType} function must return on every path`,
        { nodeId },
      ),
    );
  }
}

function readEntryReturnType(node: GraphNode): string | undefined {
  const value = node.params['returnType'];
  return typeof value === 'string' ? value : undefined;
}
