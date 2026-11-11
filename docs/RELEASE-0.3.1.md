# Mio extension 0.3.1 validation record

Source: `mio-kobo/mio-vscode`, branch based on
`8a3836b6b13ef6ef36751e5dcfae60a6b967d94b` (`main`). The initial clean checkout
was `f68d8eb`; two newer upstream commits were fast-forwarded before editing.
The initial manifest was 0.3.0; no remote tags or GitHub releases existed.
The repository release guard confirmed Marketplace 0.3.1 was unpublished.
Release tags use the existing convention **`vscode-V0.3.1`**.

## Scope and behavior

Implemented: native control-flow/function snippets; conservative conversion
context detection; cached import completion from 39 verified embedded packages
and local roots; individually configurable editing; opt-in native on-type
semicolon formatting; version/lifecycle checks for CLI and push diagnostics;
serialized client restarts; removal of duplicate/unrelated LSP configuration notifications; immediate local registration without awaiting LSP startup.

The requested `uint64` conversion is **not implemented**: both the pinned
self-hosted `TypeKind` enum and builtin list omit it, and the pinned CLI returns
`E0201` for `waza main() -> unit { kaku x = uint64(1); chant(x); }`.
The extension does not invent compiler support or depend on unreleased 2.2.0.
Other requested numeric types are covered. Existing `if`, `while`, `print`,
`array-len` aliases remain; the former `rune` declaration alias is `rune-literal`.
Smart expansion uses completion acceptance, with native Tab/Shift+Tab/$0 navigation;
Space is not intercepted. Existing calls, comments and ordinary strings are protected.
Local smart transformations decline multiple cursors.

Semicolons default off and require the user's `[mio].editor.formatOnType` opt-in.
Only simple complete declarations, calls, returns and imports are recognized.
Complex or multiline expressions are deliberately skipped. Undo grouping is owned
by VS Code; formatting and Enter may be two native undo steps. Paste is unchanged.

Import indexing is asynchronous, coalesced and bounded to 5,000 files per root.
The old snapshot remains available during refresh; missing roots are ignored.
New/deleted workspace modules, configured-root modules, root settings and workspace
changes invalidate the cache. A missing external root becomes indexed after a root
configuration/workspace refresh. Full's static catalog is not a claim that Core
has those libraries installed. Root-relative workspace candidates still require
compiler-compatible import configuration. No network package discovery is used.

A closed tab can retain a VS Code document model (e.g. completion references).
Both diagnostic owners clear the last closed tab; version-matching compiler results
can be restored when reopening the retained model. Empty dirty-state events do not
invalidate actual diagnostic work. No error code, including `E0101`, is suppressed.
Incomplete `yobu ` reports `E0101`; an unterminated quote reports `E0001` in the
pinned compiler. Unversioned server notifications cannot be proven to belong to
an earlier edit, so that limitation remains. CLI fallback validates on save/manual
check, not every keystroke; editing invalidates its old result until revalidation.

No compiler, grammar, bytecode, AOT, runtime, GC or Bunko source was edited.
`.mio-core` is the existing test workflow's disposable, immutable source checkout:
`7903f6d18a37b3e4a84fb381f019d1683d3fb81a`, the Mio v2.1.2 release commit. The
Go reference CLI identifies itself as `Mio 2.1.2-dev`; it is not mislabeled as a
separately downloaded native release binary. Native Full distribution binaries
were not independently exercised locally.

## Measurements

Measured on macOS Darwin 24.6.0 / ARM64, VS Code 1.145.2, Extension Host Node
24.22.1. Mio LSP was running for both datasets. Source fixtures have 20 or 1,000
unique variable declarations plus a function wrapper. Completion API timings use
50 samples after five warmups at the same position; diagnostics use ten unique
unsaved undefined-name edits with 5 ms observation polling. These are small local
samples, not service-level guarantees. The after-run additionally measures 50
alternating-prefix edits for cold and warm local completion. Raw records are in
[before](benchmarks/0.3.1-before.json) and [after](benchmarks/0.3.1-after.json).
All values below are milliseconds.

| Operation | Lines | Before median / P95 / max | After median / P95 / max |
| --- | ---: | ---: | ---: |
| completion API including LSP | 20 | 1.577 / 2.536 / 3.496 | 1.442 / 4.620 / 10.003 |
| unsaved edit to LSP diagnostic (5ms polling) | 20 | 160.133 / 163.155 / 163.155 | 157.568 / 172.731 / 172.731 |
| completion API including LSP | 1000 | 2.327 / 4.673 / 4.890 | 2.665 / 4.267 / 4.501 |
| unsaved edit to LSP diagnostic (5ms polling) | 1000 | 211.882 / 216.569 / 216.569 | 207.607 / 212.130 / 212.130 |

| Extension-local operation (after only) | Lines | Median / P95 / max |
| --- | ---: | ---: |
| local completion cold after edit | 20 | 0.035 / 0.068 / 0.192 |
| local completion cached | 20 | 0.006 / 0.018 / 0.044 |
| local completion cold after edit | 1000 | 0.586 / 0.734 / 1.419 |
| local completion cached | 1000 | 0.005 / 0.012 / 0.039 |

| Instrumented span (after only) | Samples | Median / P95 / max |
| --- | ---: | ---: |
| localCompletion | 310 | 0.013 / 0.597 / 1.414 |
| lspCompletionRoundTrip | 110 | 1.023 / 3.513 / 18.305 |
| lspDiagnosticConversion | 23 | 0.017 / 0.039 / 0.112 |

The local provider runs without awaiting the LSP and supplies useful static items
when the CLI is absent. The full completion API still waits for server completion.
Its medium-file median increased slightly; no across-the-board speedup is claimed.
The round-trip span includes transport, server analysis and client conversion;
it is **not isolated server CPU time**. Diagnostic conversion is measured separately.
The existing initialization requests a 150 ms server debounce. End-to-end live
updates remain roughly 160–210 ms, with server analysis/debounce dominating the
sub-millisecond extension conversion; server-internal time was not directly profiled.
The new client-side checks address stale responses and lifecycle correctness, not
MioCore's processing latency.

## Reproducing validation

```sh
npm ci
npm run compile
npm run lint
MIO_RELEASE_TESTS=1 npm test
MIO_BENCHMARK=after MIO_EDITING_TIMINGS=1 npm run test:integration
python3 -B .github/scripts/test_plugin_release.py -v
npm run package
npm run check:vsix
python3 .github/scripts/plugin-release.py vscode vscode-V0.3.1 \
  --archive mio-language-support-0.3.1.vsix --checksum
```

`npm test` builds only the pinned disposable reference CLI. Benchmark mode runs
only the benchmark suite, in a separate Extension Host to avoid mixing rapid-edit
stress and functional cases. Each host uses a fresh temporary user profile. Set
`VSCODE_EXECUTABLE_PATH` to repeat against another VS Code executable. The declared
minimum 1.85 line (tested at 1.85.2) and official stable 1.146.0 passed locally. The installed 1.145.2 was used for the before/after measurements. CI validates Linux,
macOS and Windows using its existing workflow. Lint has three pre-existing `curly`
warnings in `scripts/build-test-cli.mjs` and no errors.

To reproduce the pre-change baseline, compile this revision and preserve its emitted
`out/test/suite/00performance.test.js`. In a clean checkout of base `8a3836b`, run
its normal install/compile/pretest commands, copy that emitted harness into its
`out/test/suite/`, then run `MIO_BENCHMARK=before npm run test:integration`.
The harness conditionally loads the local provider, so the base measures only
its existing LSP completion and diagnostics. Keep the same VS Code executable and
source pin. The saved baseline was captured before feature changes, with that
same fixture/request pattern.

Set `MIO_EDITING_TIMINGS=1` when developing to collect at most 1,000 samples per
span in the in-memory `editingTimings` map. No timing logs are written by default.
This instrumentation does not turn server time into extension-only time.

## Test coverage and artifacts

Unit tests cover lexical contexts, every supported numeric type, generic/array
annotations, partial prefixes, Unicode imports, embedded catalog membership,
complete/incomplete statements, comments, blocks and multiline safety.
Extension Host scenarios cover native snippet Tab/Shift+Tab/final position and
undo/redo, existing delimiters, multicursor refusal, range edits, filesystem cache
refresh, missing/external roots, native Enter/undo/redo/repeated Enter/paste,
out-of-order push conversion, unsaved CLI stale results, real error creation and
resolution, rapid imports, closed retained models and LSP/CLI ownership changes.
Existing graph, grammar, resolver, CLI, Test Explorer and semantic-navigation tests
remain included. No native keyboard overrides or semantic compiler pass is used for
static expansion. Local results: **226 unit tests**, **29 functional Extension Host tests** on both the minimum-version line and official stable, **one separate benchmark test**, and **nine release-guard tests** passed. CI results are linked from the GitHub release.

Production package: `mio-language-support-0.3.1.vsix`, plus its SHA256 sidecar.
The existing VSIX checker validates required assets and excludes source/tests/core
checkout; the archive release guard checks its manifest/version/checksum. Publishing
must wait for passing repository CI and the existing tag-driven OIDC workflow;
Marketplace environment approvals, if required, are not bypassed.

## Changed files

- `CHANGELOG.md`
- `README.md`
- `README.zh-CN.md`
- `package-lock.json`
- `package.json`
- `package.nls.json`
- `package.nls.zh-cn.json`
- `snippets/mio.json`
- `src/diagnostics/diagnosticManager.ts`
- `src/extension.ts`
- `src/lsp/client.ts`
- `src/test/runTest.ts`
- `src/test/suite/extension.test.ts`
- `src/test/suite/index.ts`
- `src/test/unit/manifest.test.ts`
- `docs/RELEASE-0.3.1.md`
- `docs/benchmarks/0.3.1-after.json`
- `docs/benchmarks/0.3.1-before.json`
- `src/diagnostics/pushDiagnostics.ts`
- `src/editor/completionContext.ts`
- `src/editor/completionProvider.ts`
- `src/editor/context.ts`
- `src/editor/imports.ts`
- `src/editor/moduleCatalog.ts`
- `src/editor/performance.ts`
- `src/editor/semicolonProvider.ts`
- `src/test/suite/00performance.test.ts`
- `src/test/suite/01editing.test.ts`
- `src/test/unit/editing.test.ts`
