# SealDice Type Contract

sealwrapper supports one exact host target: SealDice `1.6.0`. Its TypeScript
declaration is reproducible, but not blindly inferred from Go types.

## Inputs and Outputs

- `tools/seal-api-scan/` parses the lock-managed core's `dice/` production Go
  files using `go/parser`. It reads `Dice.JsInit`, nested `seal.Set(...)`
  objects, function signatures, arity, source locations, and `jsbind` fields.
  It neither imports nor builds core.
- `api/sealdice/1.6.0/inventory.json` is the committed AST inventory.
- `api/sealdice/1.6.0/seal.d.ts.template` is the reviewed semantic layer for
  JavaScript behaviour Go signatures cannot express: optional arguments,
  nullability, callbacks, Goja conversion, and dynamic objects.
- `api/sealdice/1.6.0/semantic-override.json` records the target and any
  explicitly justified source-only or declaration-only paths.
- `types/sealdice/1.6.0/seal.d.ts` and
  `api/sealdice/1.6.0/report.md` are generated outputs.

The renderer rejects an extracted API missing from the declaration, a declared
`seal.*` member absent from the inventory, incompatible kinds, and TypeScript
required arity greater than the Go binding arity. The scanner hashes only
non-test `dice/**/*.go` files, so the test-only bridge overlay cannot alter the
API fingerprint.

## Workflow

Normal plugin authors use only the reviewed output:

```sh
sealw types sync --target 1.6.0
sealw typecheck --target 1.6.0
```

Maintainers first prepare the project's lock-managed core, then audit it:

```sh
sealw core sync --target 1.6.0
sealw types audit --target 1.6.0
```

After an intentional target update and review of the resulting diff, they may
regenerate the sealwrapper-owned source assets:

```sh
sealw types update --write --target 1.6.0
```

Neither command accepts a user-supplied core path. `audit` only reads the
existing managed worktree; `update` requires `--write` and rewrites only the
tool's inventory, generated declaration, and report. CI should run
`sealw types audit` after core sync and `npm run check` to detect both live
core drift and stale committed outputs. The same audit also performs a
read-only reply grammar scan: it extracts `condType`, `matchType`, `matchOp`,
and `resultType` vocabularies from the target's production AST and compares
them with the strict checker in the applied test-only overlay. A mismatch is a
review failure; the signed overlay is never edited automatically.
