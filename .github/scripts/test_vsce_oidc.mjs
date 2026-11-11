import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchOidc } from './fix-vsce-oidc.mjs';
const original = 'const url = `${marketplaceUrl}/_apis/gallery/token`; const headers = { Authorization: `Bearer ${oidcToken}` };';
test('repairs only the documented exchange endpoint and scheme', () => {
  const result = patchOidc(original);
  assert.ok(result.includes('/_apis/gallery/token?api-version=7.2-preview.1`'));
  assert.ok(result.includes('Authorization: `FederatedToken ${oidcToken}`'));
  assert.ok(!result.includes('Bearer'));
});
test('accepts an already corrected implementation without further changes', () => {
  const patched = patchOidc(original);
  assert.equal(patchOidc(patched), patched);
});
test('fails closed for unknown, partial or ambiguous implementations', () => {
  for (const source of ['', original + original, original.replace('Bearer', 'Other')]) {
    assert.throws(() => patchOidc(source), /refusing to patch/);
  }
});
