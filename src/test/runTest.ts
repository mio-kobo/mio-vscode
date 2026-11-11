import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

function findVSCodeExecutable(): string | undefined {
  const explicit = process.env.VSCODE_EXECUTABLE_PATH;
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
          '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders',
        ]
      : process.platform === 'win32'
        ? [
            path.join(
              process.env.LOCALAPPDATA ?? '',
              'Programs',
              'Microsoft VS Code',
              'Code.exe',
            ),
            'C:\\Program Files\\Microsoft VS Code\\Code.exe',
          ]
        : [
            '/usr/share/code/code',
            '/usr/bin/code',
            '/snap/bin/code',
          ];

  return candidates.find(
    (candidate) => candidate !== '' && fs.existsSync(candidate),
  );
}

async function main(): Promise<void> {
  // DSH 等宿主可能设置 ELECTRON_RUN_AS_NODE，导致 VS Code 被当作 Node 启动。
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  const workspacePath = path.resolve(
    extensionDevelopmentPath,
    'test-fixtures/workspace',
  );
  const cliPath = path.join(
    extensionDevelopmentPath,
    '.test-tmp',
    process.platform === 'win32' ? 'mio.exe' : 'mio',
  );

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-vscode-host-'));
  const options: Parameters<typeof runTests>[0] = {
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspacePath,
      '--user-data-dir', userDataPath,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
    ],
    extensionTestsEnv: {
      MIO_TEST_GREP: process.env.MIO_TEST_GREP ?? '',
      MIO_EDITING_TIMINGS: process.env.MIO_EDITING_TIMINGS ?? '',
      MIO_BENCHMARK: process.env.MIO_BENCHMARK ?? '',
      MIO_RELEASE_TESTS: process.env.MIO_RELEASE_TESTS ?? '',
      MIO_TEST_CLI: cliPath,
      MIO_TEST_PLUGIN_ROOT: extensionDevelopmentPath,
      MIO_TEST_REPO_ROOT: path.resolve(extensionDevelopmentPath, '.mio-core'),
    },
  };

  const executable = findVSCodeExecutable();
  if (executable !== undefined) {
    options.vscodeExecutablePath = executable;
    console.log(`[runTest] using VS Code: ${executable}`);
  } else {
    console.log('[runTest] no local VS Code found; downloading stable');
  }

  try { await runTests(options); } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
