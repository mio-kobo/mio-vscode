# Marketplace v0.3.1 recovery

## Root cause and durable fix

Original run [43055872917](https://github.com/mio-kobo/mio-vscode/actions/runs/43055872917)
built and validated the release, then failed during OIDC exchange with HTTP 400:
`No api-version was supplied`. The tag's lockfile resolves `@vscode/vsce` 4.0.0.
That implementation omits the query parameter and uses `Bearer` for token exchange.

The maintained branch now pins **4.1.0** exactly in both package manifests.
`npm ls @vscode/vsce` and the pristine installed `out/oidc.js` confirm
`/_apis/gallery/token?api-version=7.2-preview.1` and `Authorization: FederatedToken`.
Only this package's lock entry and its root declaration change; no unrelated
packages are upgraded. The earlier temporary node_modules compatibility patch and
its test are removed. No installed dependency is patched by the repaired workflow.

The existing `publish-vscode.yml` handles both future tag builds and controlled
manual recovery. Recovery uses maintained publishing tools while separately
checking out the immutable tag for source/history validation. It retrieves the
original artifact instead of rebuilding it. It verifies:

- Run ID, repository, workflow filename, push event, tag and exact commit.
- Successful original `build` job, even when the later publish job failed.
- Exactly one non-expired version-matching artifact from that run and repository.
- Original SHA-256 sidecar, VSIX manifest, package version and publisher.
- Duplicate version via both Gallery metadata and the version-specific public
  package endpoint (Gallery search metadata can lag publication).

The dispatch defaults to **verification only**. It requires an explicit boolean
`publish=true` to enter the existing protected publishing job. Token permissions
remain restricted to that job. Environment approvals, trusted-main ancestry,
manifest guards, checksums and OIDC-only authentication remain enforced.

## Trusted Publishing configuration

Microsoft's [official instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)
require a policy under the extension owner's Marketplace publisher:

| Field | Required value |
| --- | --- |
| Publisher | `exmikupro` |
| Repository owner | `mio-kobo` |
| Repository | `mio-vscode` |
| Workflow filename | `publish-vscode.yml` |
| GitHub environment | `marketplace-vscode` |

If a future exchange reports a missing/mismatched policy, an authorized publisher
administrator must sign in to the Marketplace publisher management page, select
`exmikupro`, open **Trusted Publishing**, and create or correct a policy using
those exact values. Repository/environment permissions must also allow the
workflow. No PAT fallback or credential extraction is used.

For this release the prior retry's successful OIDC exchange and publication are
observed runtime evidence that the policy was accepted; configuration was not
assumed from the repository variable alone.

## Publication and artifact evidence

The earlier retry [43057587695](https://github.com/mio-kobo/mio-vscode/actions/runs/43057587695)
reported publication before the follow-up instructions requiring 4.1.0 and reuse
of the original archive arrived. Independent retrieval of the version-specific
Marketplace package confirms `exmikupro.mio-language-support` **0.3.1**:

`https://marketplace.visualstudio.com/_apis/public/gallery/publishers/exmikupro/vsextensions/mio-language-support/0.3.1/vspackage`

The response can be transport-gzipped; verification decodes HTTP compression,
opens the VSIX, and checks its identity/version rather than trusting HTTP 200 or
CLI success. The new `check-marketplace-version.py` automates this read-only check.

| Archive | SHA-256 |
| --- | --- |
| Original run 43055872917 | `4fed9673381610dc9cc5b66aebfaedfd9a5f6eb030f075ee27d8c39a71b59cd5` |
| Published earlier retry | `3d5093fa29f8fd4fff5adf9297f398cc71bba227a7d19f5ec9fe3a7980ffda98` |

Both archives contain **379 identical payload entries**; their ZIP metadata makes
the byte-level hashes differ. The original archive and its original checksum
remain unchanged and verified. The published package matches the earlier retry's
archive byte for byte after HTTP transport decoding. It is not claimed to be the
exact original ZIP. No second publication is attempted, and no checksum is
replaced to hide this distinction.

The immutable tag `vscode-V0.3.1` remains at
`82b87b08e2dad11c2015d8e8346d3c59b00fa462`; extension version stays 0.3.1.
No compiler, LSP, language semantics or editor feature code is changed by this
infrastructure repair.

## Validation and operation

```sh
npm ci
npm ls @vscode/vsce
npm run compile
npm run lint
python3 -B .github/scripts/test_plugin_release.py -v
python3 -B .github/scripts/test_release_artifact.py -v
python3 -B .github/scripts/test_marketplace_version.py -v
python3 .github/scripts/check-marketplace-version.py --version 0.3.1
```

Local release guards: **16 tests passed** (9 existing, 3 provenance, 4 public-package
verification), including untrusted runs, failed builds, wrong versions/publishers,
expired artifacts, duplicate candidates, gzip transport and non-VSIX responses.
Compile and lint pass; lint retains three pre-existing `curly` warnings in the
unmodified test-CLI builder. Actionlint validates the workflow structure.

Integrity-only recovery (safe for an already published version):

```sh
gh workflow run publish-vscode.yml --ref main \
  -f release_tag=vscode-V0.3.1 \
  -f artifact_run_id=43055872917 \
  -f publish=false
```

The original tag's three-platform CI passed. A later CI run for the temporary
publishing fix encountered an unrelated Windows test-directory cleanup `EPERM`;
that editor test is outside this repair's scope and is not altered or bypassed.
The controlled recovery independently validates the original successful build and
its exact archive. No Marketplace configuration change or further publication is
needed for the already downloadable 0.3.1 version.

## Files changed by the durable repair

- `package.json` and `package-lock.json`: exact stable publishing-tool pin.
- `.github/workflows/publish-vscode.yml`: existing workflow gains original-artifact recovery and verification-only dispatch.
- `.github/scripts/verify-release-artifact.py` and `test_release_artifact.py`: provenance validation and negative tests.
- `.github/scripts/check-marketplace-version.py` and `test_marketplace_version.py`: independent package verification and duplicate prevention.
- `.github/scripts/fix-vsce-oidc.mjs` and `test_vsce_oidc.mjs`: temporary patch removed.
- `docs/MARKETPLACE-RECOVERY-0.3.1.md`: evidence, policy fields and safe operating instructions.
