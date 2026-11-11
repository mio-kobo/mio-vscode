import { timedAsync } from '../editor/performance';
import * as vscode from 'vscode';
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol';

/** Keep protocol version information until asynchronous diagnostic conversion finishes. */
export class MioPushDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('mio-lsp');
  private epoch = 0;
  private readonly latest = new Map<string, number>();
  private readonly hidden = new Set<string>();
  private readonly snapshots = new Map<string, { document: vscode.TextDocument; version: number; diagnostics: vscode.Diagnostic[] }>();
  private readonly listeners = [
    vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputText)) { continue; }
        const uri = tab.input.uri;
        const stillOpen = vscode.window.tabGroups.all.some(group => group.tabs.some(other => other.input instanceof vscode.TabInputText && other.input.uri.toString() === uri.toString()));
        if (!stillOpen) { this.hidden.add(uri.toString()); this.collection.delete(uri); }
      }
      // Preview-tab reuse may be reported as a changed tab rather than opened.
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof vscode.TabInputText)) { continue; }
          const key = tab.input.uri.toString();
          const wasHidden = this.hidden.delete(key);
          const snapshot = this.snapshots.get(key);
          if (wasHidden && snapshot && !snapshot.document.isClosed && snapshot.document.version === snapshot.version) {
            this.collection.set(tab.input.uri, snapshot.diagnostics);
          }
        }
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => { this.hidden.delete(document.uri.toString()); this.invalidate(document.uri); }),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.contentChanges.length) { this.invalidate(event.document.uri); } }),
  ];
  private disposed = false;
  private invalidate(uri: vscode.Uri): void {
    this.latest.delete(uri.toString());
    this.snapshots.delete(uri.toString());
    this.collection.delete(uri);
  }
  async accept(params: PublishDiagnosticsParams, convert: () => Promise<vscode.Diagnostic[]>, enabled: () => boolean): Promise<void> {
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === params.uri && !doc.isClosed);
    if (this.disposed || !enabled() || !document || (params.version !== undefined && params.version !== document.version)) { return; }
    const version = document.version;
    const epoch = ++this.epoch;
    this.latest.set(params.uri, epoch);
    const diagnostics = await timedAsync('lspDiagnosticConversion', convert);
    if (this.disposed || !enabled() || document.isClosed || document.version !== version || this.latest.get(params.uri) !== epoch) { return; }
    this.snapshots.set(params.uri, { document, version, diagnostics });
    if (!this.hidden.has(params.uri)) { this.collection.set(document.uri, diagnostics); }
  }
  clear(): void { this.latest.clear(); this.snapshots.clear(); if (!this.disposed) { this.collection.clear(); } }
  dispose(): void {
    this.disposed = true;
    this.latest.clear();
    this.hidden.clear();
    this.snapshots.clear();
    for (const listener of this.listeners) { listener.dispose(); }
    this.collection.dispose();
  }
}
