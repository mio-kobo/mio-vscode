// Compatibility patch for locked vsce 4.0.0, matching Microsoft's documented
// OIDC exchange protocol: https://github.com/microsoft/vscode-vsce/blob/main/src/oidc.ts
// This changes the publishing tool only, never the packaged extension or authentication policy.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchOidc(source) {
  const pairs = [
    ['/_apis/gallery/token`', '/_apis/gallery/token?api-version=7.2-preview.1`'],
    ['Authorization: `Bearer ${oidcToken}`', 'Authorization: `FederatedToken ${oidcToken}`'],
  ];
  const count = value => source.split(value).length - 1;
  if (pairs.every(([oldValue, newValue]) => count(oldValue) === 0 && count(newValue) === 1)) {
    return source;
  }
  if (!pairs.every(([oldValue, newValue]) => count(oldValue) === 1 && count(newValue) === 0)) {
    throw new Error('Unexpected vsce OIDC implementation; refusing to patch');
  }
  for (const [oldValue, newValue] of pairs) { source = source.replace(oldValue, newValue); }
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { throw new Error('Expected locked vsce out/oidc.js path'); }
  const target = process.argv[2];
  fs.writeFileSync(target, patchOidc(fs.readFileSync(target, 'utf8')));
  console.log('Validated vsce OIDC API version and FederatedToken scheme (no PAT fallback).');
}
