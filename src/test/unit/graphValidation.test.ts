import * as assert from 'node:assert/strict';
import { parseGraphValue } from '../../graph/model/parseGraph';
import type { MioGraph } from '../../graph/model/types';
import {
  validateGraph,
  type ValidatedGraph,
} from '../../graph/validation/validateGraph';
import {
  GraphBuilder,
  functionGraph,
  programGraph,
  type RawGraphDefinition,
} from './graphFixtures';

function parseClean(raw: RawGraphDefinition): MioGraph {
  const parsed = parseGraphValue(raw);
  assert.deepEqual(
    parsed.diagnostics.filter((item) => item.severity === 'error'),
    [],
    parsed.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '),
  );
  assert.ok(parsed.graph);
  return parsed.graph;
}

function validate(raw: RawGraphDefinition): ValidatedGraph {
  return validateGraph(parseClean(raw));
}

function codes(result: ValidatedGraph): string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function assertHas(result: ValidatedGraph, code: string): void {
  assert.ok(
    codes(result).includes(code),
    `expected ${code}, got ${codes(result).join(', ') || '(none)'}`,
  );
}

const constant = (
  builder: GraphBuilder,
  id: string,
  type: string,
  value: string | number | boolean,
): GraphBuilder => builder.node(id, 'Constant', { type, value });

suite('Mio Graph validation', () => {
  test('accepts the shipped example graphs', () => {
    const base = programGraph();
    const result = validate(base.build());
    assert.deepEqual(codes(result), []);
    assert.ok(result.entry);
    assert.equal(result.pinTypes.get('entry.exec_out'), undefined);
  });

  test('requires connections to go from an output pin to an input pin', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    builder.connect('c1', 'entry', 'exec_out', 'set', 'exec_out');
    const result = validate(builder.build());
    assertHas(result, 'MIOG1003');
  });

  test('rejects mixing exec pins and data pins', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    builder.connect('c1', 'entry', 'exec_out', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG1004');
  });

  test('rejects incompatible data types', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    constant(builder, 'text', 'string', 'hello');
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('d1', 'text', 'value', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG2001');
  });

  test('enforces the one-connection limit on inputs', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    constant(builder, 'one', 'int64', 1);
    constant(builder, 'two', 'int64', 2);
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('d1', 'one', 'value', 'set', 'value')
      .connect('d2', 'two', 'value', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG1005');
  });

  test('reports connections to unknown nodes and pins', () => {
    const builder = programGraph();
    builder.connect('c1', 'entry', 'exec_out', 'ghost', 'exec_in');
    assertHas(validate(builder.build()), 'MIOG1001');

    const pinBuilder = programGraph();
    pinBuilder.connect('c1', 'entry', 'exec_out', 'entry', 'not_a_pin');
    assertHas(validate(pinBuilder.build()), 'MIOG1002');
  });

  test('rejects pins that belong to a different node', () => {
    const raw = programGraph()
      .node('set', 'VariableSet', { variable: 'r' })
      .build();
    raw.connections.push({
      id: 'c_bad',
      from: { nodeId: 'entry', pinId: 'set.exec_out' },
      to: { nodeId: 'set', pinId: 'set.exec_in' },
    });
    const result = validate(raw);
    assertHas(result, 'MIOG1002');
  });

  test('rejects duplicate and self connections', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    constant(builder, 'value', 'int64', 1);
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('d1', 'value', 'value', 'set', 'value')
      .connect('d2', 'value', 'value', 'set', 'value');
    assertHas(validate(builder.build()), 'MIOG1006');

    const self = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    self.connect('e1', 'entry', 'exec_out', 'set', 'exec_in');
    self.connect('d1', 'set', 'exec_out', 'set', 'exec_in');
    assertHas(validate(self.build()), 'MIOG1007');
  });

  test('detects data cycles', () => {
    const builder = programGraph()
      .node('add_a', 'Add', { dataType: 'int64' })
      .node('add_b', 'Add', { dataType: 'int64' })
      .node('set', 'VariableSet', { variable: 'r' });
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('d1', 'add_a', 'result', 'add_b', 'a')
      .connect('d2', 'add_b', 'result', 'add_a', 'a')
      .connect('d3', 'add_a', 'result', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG3004');
  });

  test('detects execution cycles', () => {
    const builder = programGraph()
      .node('first', 'VariableSet', { variable: 'r' })
      .node('second', 'VariableSet', { variable: 'r' });
    constant(builder, 'value', 'int64', 1);
    builder
      .connect('e1', 'first', 'exec_out', 'second', 'exec_in')
      .connect('e2', 'second', 'exec_out', 'first', 'exec_in')
      .connect('d1', 'value', 'value', 'first', 'value')
      .connect('d2', 'value', 'value', 'second', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG3003');
  });

  test('detects missing required inputs', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    builder.connect('e1', 'entry', 'exec_out', 'set', 'exec_in');
    assertHas(validate(builder.build()), 'MIOG2002');
  });

  test('requires numeric types for arithmetic', () => {
    const builder = new GraphBuilder()
      .variable('flag', 'bool', false)
      .node('entry', 'Entry', { name: 'mio_graph_main' })
      .node('add', 'Add', {})
      .node('set', 'VariableSet', { variable: 'flag' });
    constant(builder, 'left', 'bool', true);
    constant(builder, 'right', 'bool', false);
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('d1', 'left', 'value', 'add', 'a')
      .connect('d2', 'right', 'value', 'add', 'b')
      .connect('d3', 'add', 'result', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG2006');
  });

  test('reports conflicting operand types on one node', () => {
    const builder = programGraph()
      .node('add', 'Add', {})
      .node('set', 'VariableSet', { variable: 'r' });
    constant(builder, 'int_value', 'int64', 1);
    constant(builder, 'float_value', 'float64', 2.5);
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('d1', 'int_value', 'value', 'add', 'a')
      .connect('d2', 'float_value', 'value', 'add', 'b')
      .connect('d3', 'add', 'result', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG2004');
  });

  test('reports exec-required nodes that are unreachable from Entry', () => {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    constant(builder, 'value', 'int64', 1);
    builder.connect('d1', 'value', 'value', 'set', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG3005');
  });

  test('requires a Return on every path of a non-unit function', () => {
    const builder = functionGraph('f', 'int64')
      .node('branch', 'Branch')
      .node('return', 'Return')
      .node('cond', 'Constant', { type: 'bool', value: true })
      .node('one', 'Constant', { type: 'int64', value: 1 });
    builder
      .connect('e1', 'entry', 'exec_out', 'branch', 'exec_in')
      .connect('d0', 'cond', 'value', 'branch', 'condition')
      .connect('t1', 'branch', 'true', 'return', 'exec_in')
      .connect('d1', 'one', 'value', 'return', 'value');
    const result = validate(builder.build());
    assertHas(result, 'MIOG3006');
  });

  test('accepts a function graph whose single path returns', () => {
    const builder = functionGraph('f', 'int64')
      .node('return', 'Return')
      .node('one', 'Constant', { type: 'int64', value: 1 });
    builder
      .connect('e1', 'entry', 'exec_out', 'return', 'exec_in')
      .connect('d1', 'one', 'value', 'return', 'value');
    const result = validate(builder.build());
    assert.deepEqual(codes(result), []);
    assert.equal(result.pinTypes.get('return.value'), 'int64');
  });

  test('requires exactly one Entry node', () => {
    const empty = new GraphBuilder();
    assertHas(validate(empty.build()), 'MIOG3001');

    const duplicate = new GraphBuilder()
      .node('entry', 'Entry', {})
      .node('entry2', 'Entry', {});
    assertHas(validate(duplicate.build()), 'MIOG3002');
  });
});
