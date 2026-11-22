import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMioCheck } from '../../cli/checkRunner';
import { mapDiagnosticPath } from '../../cli/diagnostics';
import type {
  ProcessRunner,
  ProcessRunResult,
} from '../../cli/processRunner';

// Fake CLI: reports one diagnostic for the canonical (realpath) spelling of the
// checked file, as a compiler that resolves symlinks would.
function canonicalReportingRunner(): {
  runner: ProcessRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner = {
    run: async (
      _executable: string,
      args: readonly string[],
    ): Promise<ProcessRunResult> => {
      calls.push([...args]);
      const checked = args[args.length - 1] ?? '';
      const payload = {
        code: 'E0201',
        severity: 'error',
        message: 'x',
        path: fs.realpathSync(checked),
      };
      return {
        code: 1,
        signal: null,
        stdout: '',
        stderr: JSON.stringify(payload),
        timedOut: false,
        cancelled: false,
        truncated: false,
      };
    },
  } as unknown as ProcessRunner;
  return { runner, calls };
}

suite('mio check path mapping through symlinks', () => {
  let root: string;
  let savedTmpdir: string | undefined;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-check-runner-test-'));
    savedTmpdir = process.env.TMPDIR;
  });

  teardown(() => {
    if (savedTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = savedTmpdir;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('maps a canonical temporary-package path back to the document (macOS /var case)', async function () {
    if (process.platform === 'win32') {
      this.skip(); // TMPDIR/symlink setup is POSIX-specific.
    }
    const realTmp = path.join(root, 'real-tmp');
    const linkTmp = path.join(root, 'link-tmp');
    fs.mkdirSync(realTmp);
    const canonicalTmp = fs.realpathSync(realTmp);
    fs.symlinkSync(realTmp, linkTmp, 'dir');
    process.env.TMPDIR = linkTmp;

    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const source = path.join(project, 'main.mio');
    fs.writeFileSync(source, 'waza main() {}\n');
    fs.writeFileSync(path.join(project, 'lib.mio'), 'waza f() {}\n');

    const { runner, calls } = canonicalReportingRunner();
    const result = await runMioCheck({
      runner,
      executable: 'mio',
      filePath: source,
      documentText: 'waza main() { broken }\n',
      useTempPackage: true,
    });

    assert.equal(calls.length, 1);
    assert.ok(result.checkedPath.startsWith(linkTmp + path.sep));
    assert.equal(result.payloads.length, 1);
    assert.ok(result.payloads[0]?.path?.startsWith(canonicalTmp + path.sep));
    assert.equal(
      mapDiagnosticPath(result.payloads[0]?.path, result.pathMap, result.checkedPath),
      source,
    );
    // Sibling files are mapped under both spellings as well.
    assert.equal(
      result.pathMap.get(path.join(canonicalTmp, path.basename(path.dirname(result.checkedPath)), 'lib.mio')),
      path.join(project, 'lib.mio'),
    );
    assert.equal(fs.existsSync(path.dirname(result.checkedPath)), false);
  });

  test('maps a canonical saved-file path back to the symlinked document', async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    const realProject = path.join(root, 'real-project');
    const linkProject = path.join(root, 'link-project');
    fs.mkdirSync(realProject);
    fs.symlinkSync(realProject, linkProject, 'dir');
    const source = path.join(linkProject, 'main.mio');
    fs.writeFileSync(source, 'waza main() {}\n');

    const { runner } = canonicalReportingRunner();
    const result = await runMioCheck({
      runner,
      executable: 'mio',
      filePath: source,
      documentText: '',
      useTempPackage: false,
    });

    assert.equal(
      mapDiagnosticPath(result.payloads[0]?.path, result.pathMap, result.checkedPath),
      source,
    );
  });
});
