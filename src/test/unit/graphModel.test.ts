import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseGraphJson,
  serializeGraph,
  parseGraphValue,
} from '../../graph/model/parseGraph';
import type { MioGraph } from '../../graph/model/types';
import { pluginRootPath } from './mioCli';

function readGraphFixture(name: string): string {
  return fs.readFileSync(
    path.join(pluginRootPath(), 'examples', 'mio-graph', `${name}.miog`),
    'utf8',
  );
}

function parseOrThrow(text: string): MioGraph {
  const result = parseGraphJson(text);
  assert.equal(
    result.diagnostics.filter((item) => item.severity === 'error').length,
    0,
    result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '),
  );
  assert.ok(result.graph);
  return result.graph;
}

suite('Mio Graph model', () => {
  test('derives stable pins for a parsed program graph', () => {
    const graph = parseOrThrow(readGraphFixture('score_report'));
    assert.equal(graph.kind, 'program');
    assert.equal(graph.id, 'score_report');

    const entry = graph.nodes.find((node) => node.id === 'entry');
    assert.deepEqual(
      entry?.pins.map((pin) => pin.id),
      ['entry.exec_out'],
    );

    const setBonus = graph.nodes.find((node) => node.id === 'set_bonus');
    assert.deepEqual(
      setBonus?.pins.map((pin) => `${pin.id}:${pin.kind}:${pin.direction}`),
      [
        'set_bonus.exec_in:exec:input',
        'set_bonus.exec_out:exec:output',
        'set_bonus.value:data:input',
      ],
    );
    assert.equal(setBonus?.pins[2]?.dataType, 'int64');
    assert.equal(setBonus?.pins[2]?.required, true);

    const constant = graph.nodes.find((node) => node.id === 'const_five');
    assert.equal(constant?.pins[0]?.dataType, 'int64');

    const branch = graph.nodes.find((node) => node.id === 'branch');
    assert.deepEqual(
      branch?.pins.map((pin) => pin.name),
      ['exec_in', 'condition', 'true', 'false'],
    );
    assert.equal(branch?.pins[1]?.dataType, 'bool');
  });

  test('round-trips a graph through JSON serialization', () => {
    const first = parseOrThrow(readGraphFixture('score_report'));
    const second = parseOrThrow(serializeGraph(first));
    assert.equal(serializeGraph(second), serializeGraph(first));
    assert.equal(second.nodes.length, first.nodes.length);
    assert.equal(second.connections.length, first.connections.length);
  });

  test('derives function call pins from declared signatures and builtins', () => {
    const graph = parseOrThrow(
      JSON.stringify({
        formatVersion: 1,
        id: 'calls',
        version: 1,
        kind: 'program',
        metadata: {
          variables: [],
          imports: [],
          functions: [
            {
              name: 'math.sqrt',
              parameters: [{ name: 'value', type: 'float64' }],
              returnType: 'float64',
            },
          ],
        },
        nodes: [
          { id: 'entry', type: 'Entry', params: {} },
          {
            id: 'sqrt',
            type: 'FunctionCall',
            params: { function: 'math.sqrt' },
          },
          {
            id: 'chant',
            type: 'FunctionCall',
            params: { function: 'chant' },
          },
        ],
        connections: [],
      }),
    );
    const sqrt = graph.nodes.find((node) => node.id === 'sqrt');
    assert.deepEqual(
      sqrt?.pins.map((pin) => `${pin.name}:${pin.dataType ?? 'any'}`),
      ['exec_in:any', 'exec_out:any', 'arg_0:float64', 'result:float64'],
    );
    const chant = graph.nodes.find((node) => node.id === 'chant');
    assert.deepEqual(
      chant?.pins.map((pin) => `${pin.name}:${pin.dataType ?? 'any'}`),
      ['exec_in:any', 'exec_out:any', 'arg_0:any'],
    );
  });

  test('applies typed pin defaultValue overrides', () => {
    const graph = parseOrThrow(
      JSON.stringify({
        formatVersion: 1,
        id: 'defaults',
        version: 1,
        kind: 'program',
        metadata: { variables: [], imports: [], functions: [] },
        nodes: [
          { id: 'entry', type: 'Entry', params: {} },
          {
            id: 'add',
            type: 'Add',
            params: { dataType: 'int64' },
            pins: [{ name: 'a', defaultValue: 5 }],
          },
        ],
        connections: [],
      }),
    );
    const add = graph.nodes.find((node) => node.id === 'add');
    const pinA = add?.pins.find((pin) => pin.name === 'a');
    assert.equal(pinA?.defaultValue, 5);
    assert.equal(pinA?.dataType, 'int64');
  });

  test('normalizes rune to the int32 alias', () => {
    const graph = parseOrThrow(
      JSON.stringify({
        formatVersion: 1,
        id: 'rune',
        version: 1,
        kind: 'program',
        metadata: {
          variables: [{ name: 'letter', type: 'rune', initialValue: 65 }],
          imports: [],
          functions: [],
        },
        nodes: [{ id: 'entry', type: 'Entry', params: {} }],
        connections: [],
      }),
    );
    assert.equal(graph.metadata.variables[0]?.type, 'int32');
  });

  test('rejects unsupported format versions with a structured error', () => {
    const result = parseGraphValue({
      formatVersion: 99,
      id: 'future',
      nodes: [],
      connections: [],
    });
    const codes = result.diagnostics.map((item) => item.code);
    assert.ok(codes.includes('MIOG0002'));
  });

  test('reports unknown node types instead of silently dropping them', () => {
    const result = parseGraphValue({
      formatVersion: 1,
      id: 'unknown',
      nodes: [{ id: 'boom', type: 'Explode', params: {} }],
      connections: [],
    });
    const diagnostic = result.diagnostics.find(
      (item) => item.code === 'MIOG0007',
    );
    assert.ok(diagnostic);
    assert.equal(diagnostic?.nodeId, 'boom');
  });

  test('rejects duplicate node, pin and connection identifiers', () => {
    const duplicateNodes = parseGraphValue({
      formatVersion: 1,
      id: 'dupes',
      nodes: [
        { id: 'entry', type: 'Entry', params: {} },
        { id: 'entry', type: 'Entry', params: {} },
      ],
      connections: [],
    });
    assert.ok(duplicateNodes.diagnostics.some((item) => item.code === 'MIOG0004'));

    const duplicateConnections = parseGraphValue({
      formatVersion: 1,
      id: 'dupec',
      nodes: [{ id: 'entry', type: 'Entry', params: {} }],
      connections: [
        {
          id: 'c1',
          from: { nodeId: 'entry', pinId: 'entry.exec_out' },
          to: { nodeId: 'entry', pinId: 'entry.exec_out' },
        },
        {
          id: 'c1',
          from: { nodeId: 'entry', pinId: 'entry.exec_out' },
          to: { nodeId: 'entry', pinId: 'entry.exec_out' },
        },
      ],
    });
    assert.ok(
      duplicateConnections.diagnostics.some((item) => item.code === 'MIOG0006'),
    );
  });

  test('reports invalid node parameters and pin overrides', () => {
    const result = parseGraphValue({
      formatVersion: 1,
      id: 'params',
      nodes: [
        { id: 'entry', type: 'Entry', params: {} },
        { id: 'constant', type: 'Constant', params: { type: 'int64' } },
        {
          id: 'add',
          type: 'Add',
          params: {},
          pins: [{ name: 'not_a_pin', defaultValue: 1 }],
        },
        {
          id: 'untyped',
          type: 'Add',
          params: {},
          pins: [{ name: 'a', defaultValue: 5 }],
        },
      ],
      connections: [],
    });
    assert.ok(result.diagnostics.some((item) => item.code === 'MIOG0008'));
    assert.ok(result.diagnostics.some((item) => item.code === 'MIOG0009'));
    assert.ok(result.diagnostics.some((item) => item.code === 'MIOG0010'));
  });

  test('parses both shipped example graphs', () => {
    for (const name of ['score_report', 'square']) {
      const graph = parseOrThrow(readGraphFixture(name));
      assert.ok(graph.nodes.length > 0);
    }
  });
});
