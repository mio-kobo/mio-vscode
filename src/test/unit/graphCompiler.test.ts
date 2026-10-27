import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compileMioGraphJson,
  compileMioGraphValue,
  type GraphCompilationResult,
} from '../../graph/compiler';
import { parseGraphJson, serializeGraph } from '../../graph/model/parseGraph';
import {
  GraphBuilder,
  programGraph,
  type RawGraphDefinition,
} from './graphFixtures';
import {
  findBunkoRoot,
  findMioCli,
  pluginRootPath,
  runMio,
} from './mioCli';

const bunkoRoot = findBunkoRoot();

function compile(raw: RawGraphDefinition): GraphCompilationResult {
  return compileMioGraphValue(raw);
}

function compileOk(raw: RawGraphDefinition): GraphCompilationResult {
  const result = compile(raw);
  assert.equal(
    result.ok,
    true,
    result.diagnostics.map((item) => `${item.code}: ${item.message}`).join('; '),
  );
  assert.ok(result.source);
  return result;
}

function exampleSource(name: string): string {
  return fs.readFileSync(
    path.join(pluginRootPath(), 'examples', 'mio-graph', `${name}.miog`),
    'utf8',
  );
}

suite('Mio Graph output is accepted by the real Mio compiler', () => {
  const cli = findMioCli();

  function requireCli(context: Mocha.Context): string {
    if (cli === undefined) {
      context.skip();
      return '';
    }
    return cli;
  }

  function compileAndRun(
    context: Mocha.Context,
    name: string,
    source: string,
    expectedStdout?: string,
    suffix = '',
  ): void {
    const executable = requireCli(context);
    if (executable === '') {
      return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-graph-'));
    const file = path.join(directory, `generated_${name}.mio`);
    const env =
      bunkoRoot === undefined ? undefined : { MIO_BUNKO: bunkoRoot };
    try {
      fs.writeFileSync(file, `${source}${suffix}`, 'utf8');
      const check = runMio(
        executable,
        ['check', '--format=json', '--color=never', file],
        { cwd: directory, ...(env === undefined ? {} : { env }) },
      );
      assert.equal(
        check.status,
        0,
        `mio check failed for ${name}:\n${check.stdout}\n${check.stderr}\n--- source ---\n${source}`,
      );
      assert.equal(check.stderr.trim(), '', check.stderr);
      if (expectedStdout === undefined) {
        return;
      }
      const run = runMio(executable, ['run', file], {
        cwd: directory,
        ...(env === undefined ? {} : { env }),
      });
      assert.equal(run.status, 0, `mio run failed for ${name}:\n${run.stderr}`);
      assert.equal(run.stdout, expectedStdout);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  test('compiles and runs the shipped program example', function () {
    const compilation = compileMioGraphJson(exampleSource('score_report'));
    assert.equal(
      compilation.ok,
      true,
      compilation.diagnostics.map((item) => item.message).join('; '),
    );
    assert.ok(compilation.source);
    compileAndRun(this, 'score_report', compilation.source, 'passed\n154\n');
  });

  test('compiles the shipped function example and runs it when called', function () {
    const compilation = compileMioGraphJson(exampleSource('square'));
    assert.equal(
      compilation.ok,
      true,
      compilation.diagnostics.map((item) => item.message).join('; '),
    );
    assert.ok(compilation.source);
    compileAndRun(this, 'square', compilation.source, '49\n', '\nchant(square(7));\n');
  });

  test('runs nested arithmetic with a materialized sub-expression', function () {
    const builder = programGraph()
      .node('set', 'VariableSet', { variable: 'r' })
      .node('add_inner', 'Add')
      .node('mul', 'Multiply')
      .node('add_outer', 'Add')
      .node('one', 'Constant', { type: 'int64', value: 1 })
      .node('two', 'Constant', { type: 'int64', value: 2 })
      .node('three', 'Constant', { type: 'int64', value: 3 })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('read', 'VariableGet', { variable: 'r' });
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('e2', 'set', 'exec_out', 'chant', 'exec_in')
      .connect('d1', 'add_outer', 'result', 'set', 'value')
      .connect('d2', 'add_inner', 'result', 'add_outer', 'a')
      .connect('d3', 'mul', 'result', 'add_outer', 'b')
      .connect('d4', 'add_inner', 'result', 'mul', 'a')
      .connect('d5', 'three', 'value', 'mul', 'b')
      .connect('d6', 'one', 'value', 'add_inner', 'a')
      .connect('d7', 'two', 'value', 'add_inner', 'b')
      .connect('d8', 'read', 'value', 'chant', 'arg_0');
    const compilation = compileOk(builder.build());
    compileAndRun(this, 'nested', compilation.source ?? '', '12\n');
  });

  test('runs a Branch with both sides', function () {
    const builder = programGraph()
      .node('branch', 'Branch')
      .node('condition', 'Constant', { type: 'bool', value: true })
      .node('yes', 'FunctionCall', { function: 'chant' })
      .node('no', 'FunctionCall', { function: 'chant' })
      .node('yes_text', 'Constant', { type: 'string', value: 'yes' })
      .node('no_text', 'Constant', { type: 'string', value: 'no' });
    builder
      .connect('e1', 'entry', 'exec_out', 'branch', 'exec_in')
      .connect('d0', 'condition', 'value', 'branch', 'condition')
      .connect('t1', 'branch', 'true', 'yes', 'exec_in')
      .connect('f1', 'branch', 'false', 'no', 'exec_in')
      .connect('d1', 'yes_text', 'value', 'yes', 'arg_0')
      .connect('d2', 'no_text', 'value', 'no', 'arg_0');
    const compilation = compileOk(builder.build());
    compileAndRun(this, 'branch', compilation.source ?? '', 'yes\n');
  });

  test('runs nested Branches and keeps statements after them', function () {
    const builder = programGraph()
      .node('sequence', 'Sequence', { branches: 2 })
      .node('outer', 'Branch')
      .node('outer_condition', 'Constant', { type: 'bool', value: true })
      .node('inner', 'Branch')
      .node('inner_condition', 'GreaterThan')
      .node('two', 'Constant', { type: 'int64', value: 2 })
      .node('one', 'Constant', { type: 'int64', value: 1 })
      .node('set_one', 'VariableSet', { variable: 'r' })
      .node('set_two', 'VariableSet', { variable: 'r' })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('read', 'VariableGet', { variable: 'r' })
      .node('return', 'Return');
    builder
      .connect('e1', 'entry', 'exec_out', 'sequence', 'exec_in')
      .connect('e2', 'sequence', 'then_0', 'outer', 'exec_in')
      .connect('e3', 'sequence', 'then_1', 'chant', 'exec_in')
      .connect('d0', 'outer_condition', 'value', 'outer', 'condition')
      .connect('t1', 'outer', 'true', 'inner', 'exec_in')
      .connect('f1', 'outer', 'false', 'return', 'exec_in')
      .connect('d1', 'inner_condition', 'result', 'inner', 'condition')
      .connect('d2', 'two', 'value', 'inner_condition', 'a')
      .connect('d3', 'one', 'value', 'inner_condition', 'b')
      .connect('t2', 'inner', 'true', 'set_one', 'exec_in')
      .connect('f2', 'inner', 'false', 'set_two', 'exec_in')
      .connect('d4', 'one', 'value', 'set_one', 'value')
      .connect('d5', 'two', 'value', 'set_two', 'value')
      .connect('d6', 'read', 'value', 'chant', 'arg_0');
    compileAndRun(
      this,
      'nested_branch',
      compileOk(builder.build()).source ?? '',
      '1\n',
    );
  });

  test('materializes a shared boolean condition', function () {
    const builder = new GraphBuilder()
      .variable('a', 'int64', 5)
      .variable('b', 'int64', 3)
      .node('entry', 'Entry', { name: 'mio_graph_main' })
      .node('branch', 'Branch')
      .node('greater', 'GreaterThan')
      .node('and', 'And')
      .node('read_a', 'VariableGet', { variable: 'a' })
      .node('read_b', 'VariableGet', { variable: 'b' })
      .node('yes', 'FunctionCall', { function: 'chant' })
      .node('no', 'FunctionCall', { function: 'chant' })
      .node('yes_text', 'Constant', { type: 'string', value: 'yes' })
      .node('no_text', 'Constant', { type: 'string', value: 'no' });
    builder
      .connect('e1', 'entry', 'exec_out', 'branch', 'exec_in')
      .connect('d0', 'and', 'result', 'branch', 'condition')
      .connect('d1', 'greater', 'result', 'and', 'a')
      .connect('d2', 'greater', 'result', 'and', 'b')
      .connect('d3', 'read_a', 'value', 'greater', 'a')
      .connect('d4', 'read_b', 'value', 'greater', 'b')
      .connect('t1', 'branch', 'true', 'yes', 'exec_in')
      .connect('f1', 'branch', 'false', 'no', 'exec_in')
      .connect('d5', 'yes_text', 'value', 'yes', 'arg_0')
      .connect('d6', 'no_text', 'value', 'no', 'arg_0');
    const compilation = compileOk(builder.build());
    assert.ok(compilation.source?.includes('kaku __mio_graph_t0: bool = a > b;'));
    compileAndRun(this, 'materialized_condition', compilation.source ?? '', 'yes\n');
  });

  test('runs Sequence statements in pin order', function () {
    const builder = new GraphBuilder()
      .variable('first', 'int64', 0)
      .variable('second', 'int64', 0)
      .node('entry', 'Entry', { name: 'mio_graph_main' })
      .node('sequence', 'Sequence', { branches: 2 })
      .node('set_first', 'VariableSet', { variable: 'first' })
      .node('set_second', 'VariableSet', { variable: 'second' })
      .node('one', 'Constant', { type: 'int64', value: 1 })
      .node('two', 'Constant', { type: 'int64', value: 2 })
      .node('chant_first', 'FunctionCall', { function: 'chant' })
      .node('chant_second', 'FunctionCall', { function: 'chant' })
      .node('read_first', 'VariableGet', { variable: 'first' })
      .node('read_second', 'VariableGet', { variable: 'second' });
    builder
      .connect('e1', 'entry', 'exec_out', 'sequence', 'exec_in')
      .connect('e2', 'sequence', 'then_1', 'set_second', 'exec_in')
      .connect('e3', 'sequence', 'then_0', 'set_first', 'exec_in')
      .connect('e4', 'set_first', 'exec_out', 'chant_first', 'exec_in')
      .connect('e5', 'set_second', 'exec_out', 'chant_second', 'exec_in')
      .connect('d1', 'one', 'value', 'set_first', 'value')
      .connect('d2', 'two', 'value', 'set_second', 'value')
      .connect('d3', 'read_first', 'value', 'chant_first', 'arg_0')
      .connect('d4', 'read_second', 'value', 'chant_second', 'arg_0');
    const compilation = compileOk(builder.build());
    compileAndRun(this, 'sequence', compilation.source ?? '', '1\n2\n');
  });

  test('escapes strings and formats numbers exactly as Mio expects', function () {
    const stringBuilder = new GraphBuilder()
      .node('entry', 'Entry', { name: 'mio_graph_main' })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('text', 'Constant', {
        type: 'string',
        value: 'a"b\\c\nd\te',
      });
    stringBuilder
      .connect('e1', 'entry', 'exec_out', 'chant', 'exec_in')
      .connect('d1', 'text', 'value', 'chant', 'arg_0');
    compileAndRun(
      this,
      'strings',
      compileOk(stringBuilder.build()).source ?? '',
      'a"b\\c\nd\te\n',
    );

    const numberBuilder = new GraphBuilder()
      .variable('f32', 'float32', 0.1)
      .variable('f64', 'float64', 0.1)
      .node('entry', 'Entry', { name: 'mio_graph_main' })
      .node('sequence', 'Sequence', { branches: 2 })
      .node('chant32', 'FunctionCall', { function: 'chant' })
      .node('chant64', 'FunctionCall', { function: 'chant' })
      .node('read32', 'VariableGet', { variable: 'f32' })
      .node('read64', 'VariableGet', { variable: 'f64' });
    numberBuilder
      .connect('e1', 'entry', 'exec_out', 'sequence', 'exec_in')
      .connect('e2', 'sequence', 'then_0', 'chant32', 'exec_in')
      .connect('e3', 'sequence', 'then_1', 'chant64', 'exec_in')
      .connect('d1', 'read32', 'value', 'chant32', 'arg_0')
      .connect('d2', 'read64', 'value', 'chant64', 'arg_0');
    compileAndRun(
      this,
      'numbers',
      compileOk(numberBuilder.build()).source ?? '',
      '0.1\n0.1\n',
    );
  });

  test('preserves integer division semantics', function () {
    const builder = programGraph()
      .node('set', 'VariableSet', { variable: 'r' })
      .node('divide', 'Divide')
      .node('seven', 'Constant', { type: 'int64', value: 7 })
      .node('two', 'Constant', { type: 'int64', value: 2 })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('read', 'VariableGet', { variable: 'r' });
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('e2', 'set', 'exec_out', 'chant', 'exec_in')
      .connect('d1', 'divide', 'result', 'set', 'value')
      .connect('d2', 'seven', 'value', 'divide', 'a')
      .connect('d3', 'two', 'value', 'divide', 'b')
      .connect('d4', 'read', 'value', 'chant', 'arg_0');
    compileAndRun(this, 'division', compileOk(builder.build()).source ?? '', '3\n');
  });

  test('uses pin default values', function () {
    const builder = programGraph()
      .node('set', 'VariableSet', { variable: 'r' })
      .node('add', 'Add', { dataType: 'int64' })
      .node('two', 'Constant', { type: 'int64', value: 2 })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('read', 'VariableGet', { variable: 'r' });
    const raw = builder.build();
    const add = raw.nodes.find((node) => node.id === 'add');
    assert.ok(add);
    add.pins = [{ id: 'add.a', defaultValue: 5 }];
    builder
      .connect('e1', 'entry', 'exec_out', 'set', 'exec_in')
      .connect('e2', 'set', 'exec_out', 'chant', 'exec_in')
      .connect('d1', 'two', 'value', 'add', 'b')
      .connect('d2', 'add', 'result', 'set', 'value')
      .connect('d3', 'read', 'value', 'chant', 'arg_0');
    compileAndRun(this, 'defaults', compileOk(builder.build()).source ?? '', '7\n');
  });

  test('compiles a unit function graph generated from a .miog round trip', function () {
    const builder = new GraphBuilder()
      .kind('function')
      .id('announce')
      .node('entry', 'Entry', {
        name: 'announce',
        returnType: 'unit',
        parameters: [{ name: 'value', type: 'int64' }],
      })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('return', 'Return');
    builder
      .connect('e1', 'entry', 'exec_out', 'chant', 'exec_in')
      .connect('e2', 'chant', 'exec_out', 'return', 'exec_in')
      .connect('d1', 'entry', 'param_0', 'chant', 'arg_0');
    const first = compileOk(builder.build());
    const parsed = parseGraphJson(JSON.stringify(builder.build()));
    assert.ok(parsed.graph);
    const serialized = serializeGraph(parsed.graph);
    const second = compileMioGraphJson(serialized);
    assert.equal(second.ok, true);
    assert.equal(second.source, first.source);
    compileAndRun(
      this,
      'unit_function',
      first.source ?? '',
      '41\n',
      '\nannounce(41);\n',
    );
  });

  test('calls an imported Bunko function with a declared signature', function () {
    if (bunkoRoot === undefined) {
      this.skip();
      return;
    }
    const builder = new GraphBuilder()
      .variable('result', 'float64', 0)
      .importPath('kiso/math')
      .functionSignature({
        name: 'math.sqrt',
        parameters: [{ name: 'value', type: 'float64' }],
        returnType: 'float64',
      })
      .node('entry', 'Entry', { name: 'mio_graph_main' })
      .node('call', 'FunctionCall', { function: 'math.sqrt' })
      .node('constant', 'Constant', { type: 'float64', value: 144 })
      .node('set', 'VariableSet', { variable: 'result' })
      .node('chant', 'FunctionCall', { function: 'chant' })
      .node('read', 'VariableGet', { variable: 'result' });
    builder
      .connect('e1', 'entry', 'exec_out', 'call', 'exec_in')
      .connect('e2', 'call', 'exec_out', 'set', 'exec_in')
      .connect('e3', 'set', 'exec_out', 'chant', 'exec_in')
      .connect('d1', 'constant', 'value', 'call', 'arg_0')
      .connect('d2', 'call', 'result', 'set', 'value')
      .connect('d3', 'read', 'value', 'chant', 'arg_0');
    compileAndRun(this, 'bunko', compileOk(builder.build()).source ?? '', '12\n');
  });

  test('never returns source for a rejected graph', function () {
    const builder = programGraph().node('set', 'VariableSet', {
      variable: 'r',
    });
    builder.connect('e1', 'entry', 'exec_out', 'set', 'exec_in');
    const result = compile(builder.build());
    assert.equal(result.ok, false);
    assert.equal(result.source, undefined);
  });
});
