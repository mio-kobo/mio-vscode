import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildRunPattern,
  isTestFileName,
  isTestFunctionName,
  parseTestReport,
  TestReportError,
} from '../../testing/testReport';
import { findMioCli } from './mioCli';

const pluginRoot = path.resolve(__dirname, '../../..');

suite('mio test report parsing', () => {
  test('maps passed, failed and skipped tests', () => {
    const packages = parseTestReport(
      JSON.stringify({
        schema_version: 1,
        packages: [
          {
            path: '.',
            status: 'failed',
            tests: [
              { name: 'test_ok', path: 'a_test.mio', status: 'passed', duration_ms: 0.5 },
              {
                name: 'test_bad',
                path: 'a_test.mio',
                status: 'failed',
                failures: [{ code: 'E0602', message: 'sum is wrong' }],
              },
              {
                name: 'test_skip',
                path: 'a_test.mio',
                status: 'failed',
                failures: [
                  { code: 'E0602', message: '@@mio-test-skip@@' },
                  { code: 'E0602', message: 'not ready' },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.equal(packages.length, 1);
    const [ok, bad, skip] = packages[0]!.tests;
    assert.equal(ok!.outcome, 'passed');
    assert.equal(ok!.durationMs, 0.5);
    assert.equal(bad!.outcome, 'failed');
    assert.deepEqual(bad!.messages, ['sum is wrong']);
    assert.equal(skip!.outcome, 'skipped');
    assert.deepEqual(skip!.messages, ['not ready']);
  });

  test('keeps compile failures distinct from test failures', () => {
    const [pkg] = parseTestReport(
      JSON.stringify({
        schema_version: 1,
        packages: [
          {
            path: '.',
            status: 'compile_failed',
            tests: [],
            error: { code: 'E0605', message: 'module not found' },
          },
        ],
      }),
    );
    assert.equal(pkg!.compileError, 'E0605: module not found');
    assert.equal(pkg!.tests.length, 0);
  });

  test('rejects non-JSON output and unknown schema versions', () => {
    assert.throws(() => parseTestReport('Starting tests .'), TestReportError);
    assert.throws(
      () => parseTestReport(JSON.stringify({ schema_version: 2, packages: [] })),
      /schema_version 2/u,
    );
    assert.throws(
      () => parseTestReport(JSON.stringify({ schema_version: 1 })),
      /packages/u,
    );
    assert.throws(() => parseTestReport('null'), TestReportError);
  });

  test('builds an anchored, escaped --run pattern', () => {
    assert.equal(buildRunPattern([]), undefined);
    assert.equal(buildRunPattern(['test_a', 'test_a', 'test_b']), '^(test_a|test_b)$');
    assert.equal(buildRunPattern(['test_a.b+c']), '^(test_a\\.b\\+c)$');
  });

  test('recognizes test files and functions like the toolchain', () => {
    assert.ok(isTestFileName('/x/math_test.mio'));
    assert.ok(!isTestFileName('/x/math.mio'));
    assert.ok(isTestFunctionName('test_add'));
    assert.ok(!isTestFunctionName('helper'));
  });
});

suite('mio test report from the real compiler', () => {
  let temporaryRoot: string;

  setup(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mio test 中文 日本語-'));
  });

  teardown(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function runMioTest(args: string[]): string {
    const cli = findMioCli();
    assert.ok(cli !== undefined, 'a real Mio CLI is required (run npm run pretest)');
    const bunko = path.join(pluginRoot, '.mio-core', 'bunko');
    assert.ok(fs.existsSync(bunko), `Bunko root missing: ${bunko}`);
    const result = spawnSync(cli, ['test', ...args, '--format=json'], {
      cwd: temporaryRoot,
      env: { ...process.env, MIO_BUNKO: bunko },
      encoding: 'utf8',
      shell: false,
    });
    return result.stdout;
  }

  test('reports per-test results', () => {
    fs.writeFileSync(
      path.join(temporaryRoot, 'math_test.mio'),
      [
        'yobu "kiso/testing";',
        '',
        'waza test_add() -> unit {',
        '    testing.expect(1 + 1 == 2, "add");',
        '}',
        'waza test_fail() -> unit {',
        '    testing.expect(1 + 1 == 3, "sum is wrong");',
        '}',
        '',
      ].join('\n'),
    );
    const [pkg] = parseTestReport(runMioTest(['.']));
    assert.equal(pkg!.compileError, undefined);
    const byName = new Map(pkg!.tests.map((t) => [t.name, t]));
    assert.equal(byName.get('test_add')?.outcome, 'passed');
    assert.equal(byName.get('test_fail')?.outcome, 'failed');
    assert.deepEqual(byName.get('test_fail')?.messages, ['sum is wrong']);
    assert.equal(byName.get('test_add')?.file, 'math_test.mio');

    const [filtered] = parseTestReport(runMioTest(['.', `--run=${buildRunPattern(['test_add'])!}`]));
    assert.deepEqual(filtered!.tests.map((t) => t.name), ['test_add']);
  });

  test('reports a compile failure instead of test results', () => {
    fs.writeFileSync(
      path.join(temporaryRoot, 'broken_test.mio'),
      'waza test_x() -> unit {\n    kaku y = ;\n}\n',
    );
    const [pkg] = parseTestReport(runMioTest(['.']));
    assert.ok(pkg!.compileError !== undefined, 'expected a compile error');
    assert.equal(pkg!.tests.length, 0);
  });
});
