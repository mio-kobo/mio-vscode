# Independent Marketplace publishing

Retain the existing identity **exmikupro.mio-language-support**: publisher `exmikupro`, extension name `mio-language-support`. Do not create a substitute publisher or change this identity during migration.

## Validation and dry run

```sh
npm ci
npm run compile
npm run lint
npm test
npm run package
npm run check:vsix
```

Tests build a real CLI from the immutable core Commit in core-source.json. Git/Go/build failures are fatal; real MioCore LSP tests must run. CI validates Linux, macOS and Windows. The Linux publishing environment additionally exercises the Bash release-history guard.

The CI workflow validates the final VSIX identity/version and generates its checksum without publishing. It does not create a tag or Release.

## Production release gates

Publishing uses `.github/workflows/publish-vscode.yml` and tags `vscode-V<version>`. The tag must belong to trusted main history and match package.json, package-lock.json and the packaged VSIX. Published versions cannot be reused. Approval is followed by another history, checksum, manifest and duplicate-version check.

The publish job is disabled unless the repository variable `MARKETPLACE_ENABLED` is exactly `true`. Keep it `false` until independent CI/Dry Run and these requirements are complete:

- Confirm the source-code license and separate icon/character-art rights.
- Configure required reviewers and tag rules for Environment `marketplace-vscode`. The current organization plan does not provide required reviewers for these Private staging repositories.
- Configure the Marketplace OIDC Trusted Publishing Policy for repository `mio-kobo/mio-vscode`, workflow `publish-vscode.yml` and Environment `marketplace-vscode`. Check the new repository's actual immutable subject; do not reuse the old core subject.
- Retain OIDC publishing (`vsce publish --oidc`) without a PAT fallback. No secret plaintext is copied from the old repository.
- Obtain the project owner's release approval after dry-run verification.

This migration has not enabled production publishing or created any release tag.
