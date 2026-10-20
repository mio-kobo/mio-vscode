import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'core-source.json'), 'utf8'));
const repoRoot = path.join(pluginRoot, '.mio-core');
const outputDirectory = path.join(pluginRoot, '.test-tmp');
const outputPath = path.join(outputDirectory, process.platform === 'win32' ? 'mio.exe' : 'mio');
function run(command, args, cwd = pluginRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
if (!/^[a-f0-9]{40}$/u.test(pin.commit)) throw new Error('Core commit must be a full immutable SHA');
fs.mkdirSync(outputDirectory, { recursive: true });
fs.rmSync(path.join(outputDirectory, 'NO_CLI'), { force: true });
if (!fs.existsSync(repoRoot)) {
  run('git', ['init', repoRoot]);
  run('git', ['remote', 'add', 'origin', pin.repository], repoRoot);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
if (head.status !== 0 || head.stdout.trim() !== pin.commit) {
  run('git', ['fetch', '--depth=1', '--no-tags', 'origin', pin.commit], repoRoot);
  // This is a disposable test-only checkout, never the developer's core workspace.
  run('git', ['checkout', '--detach', pin.commit], repoRoot);
}
run(process.env.GO || 'go', ['build', '-o', outputPath, './cmd/mio'], repoRoot);
run(outputPath, ['version']);
