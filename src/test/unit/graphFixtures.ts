// 单元测试共用的 Graph 构造器。测试只写语义连接，引脚由节点类型自动推导。

import type {
  GraphFunctionSignature,
  GraphLiteral,
  GraphVariableDeclaration,
  MioDataTypeName,
} from '../../graph/model/types';

export interface RawNodeDefinition {
  id: string;
  type: string;
  position?: { x: number; y: number };
  params?: Record<string, unknown>;
  pins?: unknown[];
}

export interface RawConnectionDefinition {
  id: string;
  from: { nodeId: string; pinId: string };
  to: { nodeId: string; pinId: string };
}

export interface RawGraphDefinition {
  formatVersion: number;
  id: string;
  version: number;
  kind: 'program' | 'function';
  metadata: {
    variables: GraphVariableDeclaration[];
    imports: string[];
    functions: GraphFunctionSignature[];
  };
  nodes: RawNodeDefinition[];
  connections: RawConnectionDefinition[];
}

export function pin(nodeId: string, pinName: string): string {
  return `${nodeId}.${pinName}`;
}

export class GraphBuilder {
  private readonly nodes: RawNodeDefinition[] = [];
  private readonly connections: RawConnectionDefinition[] = [];
  private readonly variables: GraphVariableDeclaration[] = [];
  private readonly imports: string[] = [];
  private readonly functions: GraphFunctionSignature[] = [];
  private graphId = 'test_graph';
  private graphKind: 'program' | 'function' = 'program';

  id(value: string): this {
    this.graphId = value;
    return this;
  }

  kind(value: 'program' | 'function'): this {
    this.graphKind = value;
    return this;
  }

  node(
    id: string,
    type: string,
    params: Record<string, unknown> = {},
    position?: { x: number; y: number },
  ): this {
    this.nodes.push({
      id,
      type,
      params,
      ...(position === undefined ? {} : { position }),
    });
    return this;
  }

  // 连接使用简短引脚名，这里统一展开为稳定引脚 ID。
  connect(
    id: string,
    fromNode: string,
    fromPin: string,
    toNode: string,
    toPin: string,
  ): this {
    this.connections.push({
      id,
      from: { nodeId: fromNode, pinId: pin(fromNode, fromPin) },
      to: { nodeId: toNode, pinId: pin(toNode, toPin) },
    });
    return this;
  }

  variable(
    name: string,
    type: MioDataTypeName,
    initialValue?: GraphLiteral,
  ): this {
    this.variables.push({
      name,
      type,
      ...(initialValue === undefined ? {} : { initialValue }),
    });
    return this;
  }

  importPath(path: string): this {
    this.imports.push(path);
    return this;
  }

  functionSignature(signature: GraphFunctionSignature): this {
    this.functions.push(signature);
    return this;
  }

  build(): RawGraphDefinition {
    return {
      formatVersion: 1,
      id: this.graphId,
      version: 1,
      kind: this.graphKind,
      metadata: {
        variables: [...this.variables],
        imports: [...this.imports],
        functions: [...this.functions],
      },
      nodes: [...this.nodes],
      connections: [...this.connections],
    };
  }
}

// 常用起点：Entry + 一个 int64 变量 r。
export function programGraph(): GraphBuilder {
  return new GraphBuilder()
    .id('program')
    .kind('program')
    .variable('r', 'int64', 0)
    .node('entry', 'Entry', { name: 'mio_graph_main' });
}

// 常用函数图：Entry -> Return。
export function functionGraph(
  name = 'f',
  returnType = 'int64',
): GraphBuilder {
  return new GraphBuilder()
    .id(name)
    .kind('function')
    .node('entry', 'Entry', { name, returnType, parameters: [] });
}
