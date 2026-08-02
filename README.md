# sealwrapper

`sealwrapper` (`sealw`) is a Node/TypeScript, sealpack-only development tool
for exact SealDice `1.6.0`. It has no bare-JS or compatibility-target release
path and distributes no core, bridge, or validator binaries.

It supports optional JS bundles plus all five target-core content classes:
`content/decks/`, `content/reply/`, `content/helpdoc/` (`.json`, `.xlsx`),
`content/templates/` (`.yaml`, `.yml`, `.json`), and `assets/`.

The repository pins its developer toolchain in [.mise.toml](.mise.toml):
Node `26.5.0` and Go `1.25.0`. Install mise, then run `mise install` before
using the npm scripts. The CLI itself still runs on Node/TypeScript; Go is only
compiled from the lock-managed core source for the test bridge and scanner.

The concise [implementation and test map](docs/implementation-map.md) ties
the approved P0/P1/P2 design requirements to their modules and regression
layers.

```sh
# after installing this tool as the project's locked dev dependency
sealw core sync --target 1.6.0
sealw types sync --target 1.6.0
sealw types verify --target 1.6.0
sealw types audit --target 1.6.0
sealw typecheck --target 1.6.0
sealw resource check --target 1.6.0
sealw resource check --target 1.6.0 --sarif .seal/reports/resources.sarif
sealw test --target 1.6.0
sealw scenario test --target 1.6.0 --snapshot
sealw scenario test --target 1.6.0 --release
sealw scenario test --target 1.6.0 --render --png --theme dark --style compact --members
sealw watch --target 1.6.0
sealw package --target 1.6.0 --sign-key keys/release.pem --sign-key-id maintainer-2026
```

For a checkout-wide verification, use the same pinned toolchain:

```sh
mise install
mise exec -- npm ci
mise exec -- npm run check
```

`check` runs the build/type gate, source lint, unit tests with coverage
thresholds, Go API scanner, required managed-core integration, and the full
example regression. `test:examples` discovers every `examples/*/seal.config.json`, prepares its
lock-managed core, syncs and verifies generated types, runs project unit tests,
checks resources, and executes every release-marked scenario with offline
JSON/SVG/HTML/PNG reports. Use
`npm run test:examples -- --plan` to inspect the plan without touching a core
checkout. `test:examples:offline` is intentionally cache-only: it requires each
selected example to already have a verified `.seal/core/` and uses offline
identity/report resolution; it never clones or fetches a mirror.

`core sync` creates only `.seal/core/`: a lock-owned bare mirror and detached
worktree at `b06a2d92a7af0b8b33be33390206297edf29c7bd`. It applies the locked
test-only overlay and uses local Go `1.25.0` to run `go test`; it never accepts
or edits a user-supplied core checkout or the template reference checkout.
The source declares `1.5.1-dev`, while the locked official runtime is
`1.6.0+20260726`; every bridge result reports both instead of concealing the
mismatch.

For JavaScript-bearing projects, `init` writes a normal `tsconfig.json` and a
managed exact-target declaration at `.seal/types/sealdice-1.6.0.d.ts`.
`sealw types sync` refreshes that declaration from sealwrapper's checked-in,
generated SealDice `1.6.0` API contract; `types verify` detects edits or stale
output. The contract itself is generated from a deterministic Go AST inventory
of the lock-managed core plus a reviewed semantic declaration template.
`sealw types audit` rescans an existing managed core and fails on API drift.
Maintainers may explicitly run `sealw types update --write` after review to
rewrite the inventory, generated declaration, and audit report.
The [type-contract maintenance guide](docs/type-contract.md) describes the
AST inventory, semantic layer, drift checks, and CI workflow.
`sealw typecheck` checks `src/` against it without emitting JavaScript, and
`sealw package` runs the same check before its resource and host gates. The
managed declaration is ignored by Git and never enters a `.sealpack`.

Scenario JSON supports deterministic `clock` and `seed`, project-wide and
per-user variables, ordered multi-user group/private messages, additional
`.sealpack` files in `packages`, output/no-output assertions, diagnostic
assertions, and transcript snapshots. A scenario is one continuous core
session: each input is dispatched, all of its replies are collected, then the
next input is dispatched. `inReplyToSequence` always refers to the author-set
input ID; `transcriptSequence` is the stable chat timeline used by the
renderer. The bridge preserves core `#{SPLIT}` behaviour, so one input can
legitimately produce several consecutive output events. JSON transcripts are
the only assertion format. Use `messages[].segments` for structured fake QQ
input; common inbound CQ text (`[CQ:at,...]`, `[CQ:face,...]`,
`[CQ:image,...]`) is safely normalized to the same segments without fetching
any referenced resource.

The lock contains an Ed25519-signed test-overlay descriptor and an explicit
HTTPS mirror set. `core sync` will only use that signed set; an alternate
mirror can supply Git objects but cannot change the canonical `origin`, commit,
patches or Go source build. A release provenance file accompanies each package
and records archive, lock, core, overlay, trust-key and patch data. Passing
`--sign-key` additionally signs that provenance file with a local Ed25519 key;
the private key is never copied into a report or `.sealpack`.

`scenario test --render` writes JSON, SVG, HTML, identity metadata, and any
frozen avatars only under `.seal/reports/`; add `--png` to rasterize the frozen
SVG with local `rsvg-convert` (or ImageMagick `magick`) without starting a
browser. SVG/HTML declare `Noto Serif CJK SC, Noto Serif CJK, serif`; install
Noto CJK locally when you need pixel-consistent PNG output. Those diagnostic artifacts do not
affect scenario assertions, lockfiles, sealpacks, checksums, or release gates.

`package` runs strict resource validation and real Install → Enable → Reload
before it creates a release. Archive, checksum, provenance and any signature
are prepared under `.seal/`; only then is the complete non-overwriting release
set published. A signing/provenance failure leaves no new release artifact or
checksum. The bridge limits ZIP entry count, compressed and expanded sizes,
and each entry's compression ratio (100:1).

For CI, mark scenario JSON with `"release": true` and run
`sealw scenario test --release`. Explicit cooldown, priority and seeded random
assertions are evaluated against the fake-QQ JSON transcript. `watch` is a
local JS-staging helper only: it does not contact or reload a host. A runnable
[mixed deck/reply/JS example](examples/adventure-prompts/) includes a pinned
lock and real fake-QQ scenarios for both JSON-deck call paths.
