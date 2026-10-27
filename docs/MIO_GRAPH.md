# Mio Graph

Mio Graph is the visual-programming front end for Mio. A graph is stored as a
`.miog` JSON document and compiled into real Mio source that the existing Mio
toolchain can check, build, and run.

This document describes the first-phase implementation that ships with the
`mio-language-support` extension. The graph core is plain TypeScript: it does
not import `vscode`, so it can be tested and reused by future editors.

## Pipeline

```text
.miog JSON
  -> Graph Model      src/graph/model
  -> Graph Validation src/graph/validation
  -> Semantic analysis + Graph IR src/graph/analysis + src/graph/ir
  -> Mio source generation      src/graph/codegen
  -> .mio source (+ source map)
```

The public API is exported from `src/graph/index.ts`:

```ts
import {
  compileMioGraphJson,
  compileMioGraph,
  parseGraphJson,
  serializeGraph,
  validateGraph,
} from './src/graph'; // repository-relative; see src/graph/index.ts

const result = compileMioGraphJson(miogText);
if (result.ok) {
  console.log(result.source);
  console.log(result.sourceMap);
} else {
  for (const diagnostic of result.diagnostics) {
    console.error(diagnostic.code, diagnostic.nodeId, diagnostic.message);
  }
}
```

`compileMioGraphJson` is pure and deterministic: the same graph always produces
byte-identical source, with no timestamps and no dependence on node positions
or the order of the `nodes` array.

## File format

```json
{
  "formatVersion": 1,
  "id": "score_report",
  "version": 1,
  "kind": "program",
  "metadata": {
    "name": "Score Report",
    "variables": [
      { "name": "score", "type": "int64", "initialValue": 72 }
    ],
    "imports": [],
    "functions": []
  },
  "nodes": [
    { "id": "entry", "type": "Entry", "params": { "name": "mio_graph_main" } }
  ],
  "connections": [
    {
      "id": "c1",
      "from": { "nodeId": "entry", "pinId": "entry.exec_out" },
      "to": { "nodeId": "set_score", "pinId": "set_score.exec_in" }
    }
  ]
}
```

- `formatVersion` is the document schema version. Documents newer than the
  extension are rejected instead of guessed.
- `id` is the stable graph identifier, `version` is the author-owned graph
  revision. Neither affects execution order.
- `kind` is `program` (compiles to a wrapper function plus a call) or
  `function` (compiles to a `waza` declaration).
- `metadata.variables` declares the variables used by `VariableGet` /
  `VariableSet`. `initialValue` is required because Mio has no
  "declare without initializer" form.
- `metadata.imports` becomes `yobu "…";` lines, for example `kiso/math`.
- `metadata.functions` declares the contract of external functions used by
  `FunctionCall` nodes. Mio builtins (`chant`) are known without declaration.
- `nodes` contains `id`, `type`, `params`, optional `position`, and optional
  `pins` overrides.
- `connections` only stores stable IDs; it never depends on object identity or
  canvas coordinates.

Pin IDs are derived as `<nodeId>.<pinName>`, for example `add1.a` or
`branch.true`. They are therefore stable across saves as long as the node ID and
the node type stay the same. A `.miog` file may omit `pins`; the model derives
them from the node type. Explicit `pins` entries may only override
`defaultValue`, an unset `dataType`, and output `maxConnections`.

`serializeGraph(graph)` writes the full derived pin set, so a save/load round
trip is lossless.

## Node reference

Exec pins are `exec_in` / `exec_out`; every exec pin allows exactly one
connection.

| Node | Params | Pins | Notes |
| --- | --- | --- | --- |
| `Entry` | `name` (program wrapper or function name), `returnType`, `parameters` | `exec_out`; `param_0…` in function graphs | exactly one per graph |
| `Return` | – | `exec_in`, `value` (only when return type is not `unit`) | ends the current path |
| `Constant` | `type`, `value` | `value` | literals are validated against the Mio type |
| `VariableGet` | `variable` | `value` | variable must be declared in metadata |
| `VariableSet` | `variable` | `exec_in`, `exec_out`, `value` | |
| `Add` `Subtract` `Multiply` `Divide` | optional `dataType` | `a`, `b`, `result` | numeric only, operands share one type |
| `Equal` `NotEqual` | optional `dataType` | `a`, `b`, `result: bool` | equality is defined for all supported scalar types |
| `GreaterThan` `GreaterThanOrEqual` `LessThan` `LessThanOrEqual` | optional `dataType` | `a`, `b`, `result: bool` | numeric only |
| `And` `Or` | – | `a: bool`, `b: bool`, `result: bool` | |
| `Not` | – | `value: bool`, `result: bool` | |
| `Branch` | – | `exec_in`, `condition: bool`, `true`, `false` | generates `moshi` / `sore` |
| `Sequence` | `branches` (1–64, default 2) | `exec_in`, `then_0…` | executes outputs in pin index order |
| `FunctionCall` | `function` | `exec_in`, `exec_out`, `arg_0…`, `result` (when the return type is not `unit`) | signature comes from metadata or a Mio builtin |

### Types

Supported data types are Mio's scalar types: `int8`, `int16`, `int32`
(`rune` normalizes to `int32`), `int64`, `uint8`, `uint16`, `uint32`,
`float32`, `float64`, `bool`, and `string`. `unit` is only a return type.

Mio has **no implicit conversions**. Every data connection therefore requires
exactly the same type on both sides. Arithmetic nodes are numeric-only;
`Add` does not concatenate strings because Mio does not support string
concatenation in v1. Arrays, maps, structs, enums, nullable values, function
values, loops, and explicit conversions are not part of phase 1 and are
reported as unsupported rather than emitted incorrectly.

## Execution and data flow

- Execution order is determined **only** by exec connections. The order of the
  `nodes` array and the `position` fields are irrelevant.
- `Sequence` executes `then_0`, `then_1`, … in numeric pin order.
- `Branch` emits `moshi (cond) { … } sore { … }`. An empty branch block is legal
  in Mio and is emitted as an empty block; `sore` is omitted when the false
  branch is empty.
- Exec inputs allow at most one connection, so branch merging is rejected with a
  diagnostic instead of generating ambiguous code.
- Data nodes are evaluated where they are read. A computed expression with
  fan-out greater than one is materialized into a stable temporary
  (`__mio_graph_t0`, `__mio_graph_t1`, …) so it is evaluated once per statement.
- A `FunctionCall` that participates in the exec flow and whose result is used
  stores its result in one temporary at the exec position. Using that result
  before its exec position, or from an exclusive branch, is a compile error.
- An impure `FunctionCall` used as an inline value must be read exactly once.
  Otherwise the graph is rejected (`MIOG3008`).
- Division always uses Mio's native semantics: integer division truncates,
  float division follows IEEE 754.

### Generated shape

Program graphs compile to a wrapper function and a call:

```mio
// Generated by Mio Graph. Do not edit this file by hand.
// Graph: score_report (version 1)

waza mio_graph_main() -> unit {
    kaku score: int64 = 72;
    kaku passing: int64 = 60;
    kaku message: string = "failed";
    kaku bonus: int64 = 0;
    kaku total: int64 = 0;
    bonus = score + 5;
    total = bonus * 2;
    moshi (score > passing) {
        message = "passed";
        chant(message);
        chant(total);
        kaesu;
    } sore {
        chant(message);
        kaesu;
    }
}

mio_graph_main();
```

Function graphs compile to a declaration:

```mio
waza square(value: int64) -> int64 {
    kaesu value * value;
}
```

The wrapper is necessary because `kaesu` is only valid inside a function.

## Diagnostics

Every diagnostic carries a stable code and, when applicable, `nodeId`,
`pinId`, and `connectionId`:

| Range | Meaning |
| --- | --- |
| `MIOG0xxx` | JSON schema, node parameters, literals, declarations |
| `MIOG1xxx` | connections: unknown nodes/pins, direction, kind, limits, duplicates |
| `MIOG2xxx` | type checking, required inputs, type inference |
| `MIOG3xxx` | execution flow: entry, cycles, reachability, returns, temp scope |
| `MIOG4xxx` | reserved for generation-time failures |
| `MIOG4999` | internal invariant violation (should never happen on valid input) |

Notable codes:

- `MIOG2001` type mismatch on a connection
- `MIOG2002` required input is neither connected nor defaulted
- `MIOG2005` a node's type cannot be inferred
- `MIOG3003` / `MIOG3004` exec / data cycle
- `MIOG3005` exec node unreachable from `Entry`
- `MIOG3006` a non-`unit` function path ends without `Return`
- `MIOG3007` call result used before its exec position
- `MIOG3008` impure result read more than once
- `MIOG3012` call result used outside the branch that produced it

The VS Code command maps these diagnostics to the `.miog` document. The range
is located by the quoted node/pin/connection ID in the JSON text; the
structured fields remain available to a future canvas UI.

## VS Code integration

Command palette: **Mio Graph: Generate Mio Source** (command id
`mioGraph.generateSource`). It is enabled for the `mio-graph` language
(`.miog` files).

1. Reads the active `.miog` document (unsaved edits included).
2. Compiles it in-process.
3. On errors: publishes `mio-graph` diagnostics on the document and writes the
   full list to the **Mio** output channel. Nothing is written to disk.
4. On success: writes `<name>.mio` next to the graph.
   - If the target does not exist, it is created.
   - If its content is identical, it is left untouched and opened.
   - If it exists and starts with the `// Generated by Mio Graph` marker, it is
     regenerated.
   - If it exists without that marker, a modal confirmation is required. The
     programmatic API defaults to `overwrite: "never"`, so a webview or script
     must opt in explicitly.
5. Opens the generated `.mio` file.
6. Runs the existing `mio check` integration on the generated text (with the
   Bunko root auto-detected) and reports compiler diagnostics. If the CLI is
   not configured, generation still succeeds and validation is reported as
   skipped.

The extension API exposes the same operation to future editors:

```ts
const api = vscode.extensions.getExtension('exmikupro.mio-language-support')
  ?.exports as MioExtensionApi;

const outcome = await api.generateMioGraphSource(uri, {
  overwrite: 'never', // 'prompt' | 'always' | 'never'
  validate: true,
});
```

## Function calls

`FunctionCall` nodes never hard-code standard-library knowledge. The name is
resolved through a `FunctionSignatureProvider`:

1. `metadata.functions` declarations in the graph,
2. an optional provider injected through `CompileGraphOptions.signatureProvider`
   (the hook for a future `mio lsp` / compiler-backed signature source),
3. Mio builtins (`chant`).

A `FunctionCall` emits a plain Mio call, so the referenced function must be
resolvable in the generated file: a Mio builtin or an imported Bunko function
(for example `math.sqrt` after `yobu "kiso/math";`). `mio check` verifies that
the contract declared in `metadata.functions` matches the real function.

Because a single `.mio` file cannot import another user file, a program graph
cannot call a helper defined in a separate `.miog`. Phase 2 will add
multi-graph documents (or companion declaration graphs) so helper functions can
be generated into the same file.

## Phase 1 limitations

- No arrays, maps, structs, enums, nullable values, `mu`, function values,
  loops (`aida`), `nukeru` / `tsuzuku`, generic types, or explicit conversions.
- No branch merging. A node's exec input accepts one connection, and two
  branch outputs cannot rejoin.
- No multi-graph `.miog` documents, so a program graph cannot call a function
  graph defined elsewhere.
- `int64` constants are limited to the JavaScript safe-integer range
  (|value| ≤ 2^53-1). Larger values are rejected with `MIOG0015` instead of
  being silently rounded.
- Node positions are preserved but never influence code generation.
- Unsupported node types are errors. They are never ignored.

## Next step: React Flow canvas

1. Generate the canvas model from `buildNodePins` + `nodeCategory` so the
   editor renders exactly the pins the compiler understands.
2. Serialize canvas edits with `toGraphJson` / `serializeGraph`; keep node IDs
   and pin IDs (not object references) as the edge identity.
3. Use `compileMioGraphJson` for live diagnostics. Map `GraphDiagnostic.nodeId`
   / `pinId` back to canvas elements; the source map (`sourceMap.entries`) can
   highlight the emitted statements for a node.
4. Keep the webview stateless: it sends the graph JSON and receives
   `{ ok, source, diagnostics, sourceMap }`. The extension host owns file I/O,
   overwrite confirmation, and `mio check`.
5. Add multi-graph documents and function-call graphs before exposing
   `FunctionCall` to user-defined helpers.

## Tests

```bash
npm run compile
npm run test:unit
```

The unit tests cover the model, validation, type checking, execution ordering,
branching, function calls, determinism, serialization, and diagnostics. When a
Mio CLI is available (`.test-tmp/mio`, `MIO_TEST_CLI`, or `PATH`), the compiler
integration tests write generated `.mio` files, run the real `mio check`, and
execute them with `mio run` to compare output.
