import * as path from 'node:path';
import * as vscode from 'vscode';
import { relativeModuleDirectory } from '../util/paths';
import { embeddedModules } from './moduleCatalog';

/** One bounded, coalesced asynchronous refresh; completion reads the last snapshot. */
export class ImportIndex implements vscode.Disposable {
  private modules = new Set(embeddedModules);
  private revision = 0;
  private pending: Promise<void> | undefined;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;
  private rootWatchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.mio');
    this.subscriptions.push(watcher, watcher.onDidCreate(() => this.invalidate()), watcher.onDidDelete(() => this.invalidate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('mio.completion.bunkoRoots')) { this.invalidate(); } }));
    this.invalidate();
  }
  candidates(prefix: string): string[] {
    const results = new Set<string>();
    for (const module of this.modules) {
      if (!module.startsWith(prefix)) { continue; }
      results.add(module);
      const slash = module.indexOf('/', prefix.length);
      if (slash >= 0) { results.add(module.slice(0, slash + 1)); }
    }
    return [...results].sort();
  }
  invalidate(): void {
    this.revision++;
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh().catch(() => { /* Keep the last snapshot if indexing is unavailable. */ }); }, 100);
  }
  refresh(): Promise<void> {
    if (this.pending) { return this.pending; }
    this.pending = (async () => {
      while (!this.disposed) {
        const revision = this.revision;
        await this.rebuild(revision);
        if (revision === this.revision) { break; }
      }
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async rebuild(revision: number): Promise<void> {
    const modules = new Set(embeddedModules);
    for (const watcher of this.rootWatchers) { watcher.dispose(); }
    this.rootWatchers = [];
    for (const folder of vscode.workspace.workspaceFolders ?? [{ uri: vscode.Uri.file(process.cwd()) }]) {
      const roots = vscode.workspace.getConfiguration('mio', folder.uri).get<string[]>('completion.bunkoRoots', []);
      const allRoots = [...(vscode.workspace.workspaceFolders?.length ? [folder.uri, vscode.Uri.joinPath(folder.uri, 'bunko')] : []), ...roots.map(root => vscode.Uri.file(path.resolve(folder.uri.fsPath, root))),
        ...(process.env.MIO_BUNKO ? [vscode.Uri.file(process.env.MIO_BUNKO)] : [])];
      for (const root of allRoots) {
        try {
          const stat = await vscode.workspace.fs.stat(root);
          if (!(stat.type & vscode.FileType.Directory)) { continue; }
        } catch { continue; }
        if (this.disposed || revision !== this.revision) { return; }
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.mio'));
        this.rootWatchers.push(watcher, watcher.onDidCreate(() => this.invalidate()), watcher.onDidDelete(() => this.invalidate()));
        const files = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*.mio'), '**/{node_modules,.git,.mio-core,.test-tmp,out}/**', 5000).then(files => files, () => []);
        if (this.disposed || revision !== this.revision) { return; }
        for (const file of files) {
          if (file.path.endsWith('_test.mio')) { continue; }
          const relative = relativeModuleDirectory(
            root.scheme === 'file' ? root.fsPath : root.path,
            file.scheme === 'file' ? file.fsPath : file.path,
            root.scheme === 'file' && process.platform === 'win32',
          );
          if (relative) { modules.add(relative); }
        }
      }
    }
    if (!this.disposed && revision === this.revision) { this.modules = modules; }
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearTimeout(this.timer); }
    for (const watcher of this.rootWatchers) { watcher.dispose(); }
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }
}
