# SealDice Type Contract

sealwrapper keeps one reviewed TypeScript contract per registered SealDice
target. The current registry contains `1.6.0`; a future target adds a sibling
directory under `api/sealdice/<target>/` and `types/sealdice/<target>/` in the
same signed tool release. A declaration is reproducible, but not blindly
inferred from Go types.

## Inputs and Outputs

- `tools/seal-api-scan/` parses the lock-managed core's `dice/` production Go
  files using `go/parser`. It reads `Dice.JsInit`, nested `seal.Set(...)`
  objects, function signatures, arity, source locations, and `jsbind` fields.
  It neither imports nor builds core.
- `api/sealdice/<target>/inventory.json` is the committed AST inventory.
- `api/sealdice/<target>/seal.d.ts.template` is the reviewed semantic layer for
  JavaScript behaviour Go signatures cannot express: optional arguments,
  nullability, callbacks, Goja conversion, and dynamic objects.
- `api/sealdice/<target>/semantic-override.json` records the target and any
  explicitly justified source-only or declaration-only paths.
- `types/sealdice/<target>/seal.d.ts` and
  `api/sealdice/<target>/report.md` are generated outputs.

The renderer rejects an extracted API missing from the declaration, a declared
`seal.*` member absent from the inventory, incompatible kinds, and TypeScript
required arity greater than the Go binding arity. The scanner hashes only
non-test `dice/**/*.go` files, so the test-only bridge overlay cannot alter the
API fingerprint.

## Workflow

Normal plugin authors select one target when a command needs a single
declaration. Omitting `--target` uses the project's `defaultTarget`:

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
