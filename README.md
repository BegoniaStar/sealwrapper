# sealwrapper

`sealwrapper` (`sealw`) is a Node/TypeScript, sealpack-only development tool
for registry-backed SealDice targets. The current registry contains only
`1.6.0`; adding a future target is a signed sealwrapper release that adds its
core provenance, bridge overlay, API contract, and trust descriptor together.
The tool has no bare-JS release path and distributes no core, bridge, or
validator binaries.

The CLI uses `@rushstack/ts-command-line` for typed, strict action and
parameter definitions. Existing two-word forms such as `core sync` and
`scenario test` remain supported and are normalized to the internal action
names. Long-running local operations show an `ora` spinner only on an
interactive terminal; CI, redirected output, and calls that inject a writer
remain silent and keep stdout stable.

It supports optional JS bundles plus all five target-core content classes:
`content/decks/`, `content/reply/`, `content/helpdoc/` (`.json`, `.xlsx`),
`content/templates/` (`.yaml`, `.yml`, `.json`), and `assets/`.

The repository pins its developer toolchain in [.mise.toml](.mise.toml):
Node `26.5.0` and Go `1.25.0`. Install mise, then run `mise install` before
using the npm scripts. The CLI itself still runs on Node/TypeScript; Go is only
compiled from the lock-managed core source for the test bridge and scanner.

## Installation

The current release is a private Git package rather than an npm-registry
package. Install it from a checkout:

```sh
git clone https://github.com/BegoniaStar/sealwrapper.git
cd sealwrapper
mise install
mise exec -- npm ci
mise exec -- ./sealw --help
```

To install the compiled CLI globally from that checkout, run:

```sh
mise exec -- npm install -g .
mise exec -- sealw --help
```

`npm install -g git+https://...` additionally requires npm's `allow-git` setting
to permit Git dependencies. The first `core sync` also needs Git, Go `1.25.0`,
and network access to the lock-pinned mirror; `--offline` works only after that
core is cached and verified.

The concise [implementation and test map](docs/implementation-map.md) ties
the approved P0/P1/P2 design requirements to their modules and regression
layers.

```sh
# after installing this tool as the project's locked dev dependency
sealw core sync --target 1.6.0       # omit --target to use the lock default
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
sealw package --sign-key keys/release.pem --sign-key-id maintainer-2026
```

`package`, `resource check`, and `test` run every target in
`sealDice.buildTarget` when `--target` is omitted, so a matrix gate cannot hide
a target-specific failure. One archive is released only after every selected
target passes typecheck, resource validation, and Install → Enable → Reload.
Supplying `--target` narrows a local gate to one registered target; commands
that materialize one core or declaration use the configured default when it is
omitted.

## Target matrix and lockfile

New projects use schema v2:

```json
{
  "schemaVersion": 2,
  "sealDice": {
    "buildTarget": ["1.6.0"],
    "defaultTarget": "1.6.0"
  },
  "sealpack": {
    "minSealDice": "1.6.0"
  }
}
```

When a later target is published, a project can opt into both with
`"buildTarget": ["1.6.0", "1.7.0"]`. `minSealDice` is the lowest selected
SemVer target because SealDice markets interpret it as `>= min_version`.
There is no separate `compatibilityTargets` field: the target list is the
single source of truth for build and release compatibility.
Because the market expression has no upper bound, adding a new registry target
should be treated as a release-gate update: add it to `buildTarget`, refresh
its lock/core/type assets, and run `package` before claiming support for that
host version.

`seal.lock` v3 records the registry version, target set, default target, and a
complete signed descriptor for every target. v3 is the only supported project
and lock format; older files must be explicitly rewritten with
`sealw lock update` so a trust-root or registry migration is reviewable rather
than silently substituted. Managed state is isolated at
`.seal/core/<target>/mirror.git`, `.seal/core/<target>/worktree`, and
`.seal/core/<target>/state.json`, so two target checkouts cannot overwrite one
another. A v2 lock can be migrated in place with
`sealw lock update --allow-dirty`; the command reports the lock and registry
version changes before writing the current descriptor.

Maintainers add a target to the immutable `targetRegistry` in
`src/pinned-target.ts`, then add the matching `api/sealdice/<target>/`,
`types/sealdice/<target>/`, and `patches/sealdice-core/<target>/` assets. The
descriptor is trust-signed as one unit; projects can select the new ID only
after that sealwrapper release is available.

Use `sealw --help` or `sealw scenario test --help` for generated command and
parameter documentation. Unknown options and unsupported choice values fail
before project or managed-core work begins.
All commands except `package` also accept `--format text|json|junit`. Text is
the default; JSON emits one `sealwrapper.cli/v1` envelope and JUnit emits one
JUnit suite, so CI can consume every command through the same interface.

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
selected example to already have verified `.seal/core/<target>/` directories and uses offline
identity/report resolution; it never clones or fetches a mirror.

`core sync` creates only the selected target's `.seal/core/<target>/` directory:
a lock-owned bare mirror and detached worktree at the descriptor's pinned
commit. It applies the locked test-only overlay and uses that target's pinned
Go toolchain to run `go test`; it never accepts
or edits a user-supplied core checkout or the template reference checkout.
The source declares `1.5.1-dev`, while the locked official runtime is
`1.6.0+20260726`; every bridge result reports both instead of concealing the
mismatch.
Before touching managed state, `core sync` and `doctor` probe Node, Git, and
every Go version selected by the lock and report all missing or mismatched
tools together.

For JavaScript-bearing projects, `init` writes a normal `tsconfig.json` and a
managed target declaration at `.seal/types/sealdice-<target>.d.ts`.
`sealw types sync` refreshes that declaration from the selected target's
checked-in generated API contract; `types verify` detects edits or stale
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
When more than one target is selected, snapshots and rendered report names
include the target ID (for example, `scenario.json.1.7.0.snapshot.json`) so
transcripts from different host contracts cannot overwrite one another.

Network permissions are opt-in: the generated manifest defaults to
`network: false`. For a package that declares `network: true`, the test bridge
uses a hermetic HTTP mock rather than the real Internet. A request must target
one of the manifest's `networkHosts` and match a scenario-declared route,
including method, URL, headers, and body; HTTPS CONNECT is also denied by this
HTTP-only bridge. Otherwise it fails closed. Matched
requests and fixed responses are recorded in the JSON transcript, so a passing
scenario proves the fetch path without granting external network access.

The lock contains an Ed25519-signed test-overlay descriptor and an explicit
HTTPS mirror set. `core sync` will only use that signed set; an alternate
mirror can supply Git objects but cannot change the canonical `origin`, commit,
patches or Go source build. A release provenance file accompanies each package
and records the complete target matrix plus archive, lock, core, overlay,
trust-key and patch data. Passing
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
