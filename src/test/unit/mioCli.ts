// 真实 Mio 编译器的测试入口：优先使用 CI/pretest 构建的 .test-tmp/mio，
// 其次 MIO_TEST_CLI，最后搜索 PATH。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const pluginRoot = path.resolve(__dirname, '../../..');

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findMioCli(): string | undefined {
  const fromEnvironment = process.env['MIO_TEST_CLI'];
  if (fromEnvironment !== undefined && isExecutable(fromEnvironment)) {
    return fromEnvironment;
  }
  const name = process.platform === 'win32' ? 'mio.exe' : 'mio';
  const candidate = path.join(pluginRoot, '.test-tmp', name);
  if (isExecutable(candidate)) {
    return candidate;
  }
  const pathValue = process.env['PATH'] ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory === '') {
      continue;
    }
    const found = path.join(directory, name);
    if (isExecutable(found)) {
      return found;
    }
  }
  return undefined;
}

// .mio-core 中的 Bunko 目录用于验证 yobu 导入。
export function findBunkoRoot(): string | undefined {
  const repository =
    process.env['MIO_TEST_REPO_ROOT'] ?? path.join(pluginRoot, '.mio-core');
  const candidate = path.join(repository, 'bunko');
  return fs.existsSync(candidate) ? candidate : undefined;
}

export interface MioProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runMio(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): MioProcessResult {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function pluginRootPath(): string {
  return pluginRoot;
}
