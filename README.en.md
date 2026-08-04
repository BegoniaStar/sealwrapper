# sealwrapper

`sealwrapper` (`sealw`) is a development and release tool for
[SealDice](https://github.com/sealdice/sealdice-core) `sealpack` extensions. It
creates reproducible `.sealpack` archives, validates them against a
lock-managed SealDice core, and provides TypeScript contracts, deterministic
fake-QQ scenarios, reports, and release provenance.

The current target registry supports SealDice `1.6.0`. A project is always
sealpack-only: this tool does not publish bare JavaScript extensions, accept a
user-supplied core checkout, or bundle the SealDice core, bridge, or validator.

[中文文档](README.md) | [Documentation index](docs/README.md)

## What It Does

- Scaffolds JavaScript, resource-only, or hybrid SealDice packages.
- Locks every selected host target, source commit, test-only bridge overlay,
  API contract, and trust descriptor in `seal.lock` v3.
- Stages optional JavaScript bundles and the supported content roots:
  `decks`, `reply`, `helpdoc`, `templates`, and `assets`.
- Typechecks plugin source against the target-specific `seal.*` declaration.
- Performs strict resource validation and a real Install -> Enable -> Reload
  smoke test through the managed core.
- Runs deterministic fake-QQ scenarios, snapshots, hermetic HTTP mocks, and
  offline JSON/SVG/HTML/PNG transcript reports.
- Publishes a deterministic archive with SHA-256 checksum, provenance, and an
  optional Ed25519 provenance signature.

## Supported Platforms

Linux on a POSIX shell is the only supported execution environment and the
only platform covered by CI. macOS may work when its local toolchain is made
compatible, but it is not a supported or tested target. Windows is unsupported:
the installed `sealw` launcher is intentionally a POSIX shell script.

## Requirements

This repository pins its developer toolchain in [`.mise.toml`](.mise.toml):

| Tool | Required version | Why |
| --- | --- | --- |
| Node.js | `>=26.5.0 <27` | CLI, bundling, TypeScript, and tests |
| Go | `1.25.0` | Managed-core bridge and API scanner |
| Git | Available on `PATH` | Locked core mirror and worktree |

Use [mise](https://mise.jdx.dev/) rather than a system-wide runtime. A newer Go
release is intentionally rejected: the bridge and its lock descriptor require
the exact Go version recorded for the selected target.

## Installation

The release is currently distributed from this private Git repository. From a
checkout:

```sh
git clone https://github.com/BegoniaStar/sealwrapper.git
cd sealwrapper
mise install
mise exec -- npm ci
mise exec -- ./sealw --help
```

To make `sealw` available outside the checkout, install the compiled CLI:

```sh
mise exec -- npm install -g .
sealw --help
```

The first `core sync` needs network access, Git, and Go `1.25.0` to obtain the
lock-pinned core. `--offline` is cache-only and works only after a verified
managed core already exists.

## Quick Start

The following creates a hybrid package without downloading a core during
scaffolding. It assumes `sealw` is installed as above.

```sh
sealw init my-first-plugin --kind hybrid --no-sync
cd my-first-plugin
sealw doctor
sealw core sync
sealw types sync
sealw typecheck
sealw resource check
sealw test
sealw package
```

`init` creates `seal.config.json`, `seal.lock`, `README.md`, an ignored `.seal/`
directory, a source entry point, and a minimal unit test. Add commands to
`src/index.ts`, then create scenario JSON under `tests/scenarios/` before
releasing. The [quick-start tutorial](docs/quickstart.md) walks through a
complete first command and test.

## Daily Workflow

| Goal | Command |
| --- | --- |
| Check local prerequisites | `sealw doctor` |
| Fetch or verify the managed host core | `sealw core sync` / `sealw core verify` |
| Refresh or verify host declarations | `sealw types sync` / `sealw types verify` |
| Check plugin source | `sealw typecheck` |
| Build and validate package resources | `sealw resource check` |
| Test installation in the managed host | `sealw test` |
| Run fake-QQ scenarios | `sealw scenario test` |
| Rebuild local JS staging while editing | `sealw watch` |
| Produce a gated release | `sealw package` |

Commands that validate a package run every ID in `sealDice.buildTarget` when
`--target` is omitted. Commands that need one declaration or managed core use
`sealDice.defaultTarget`. Use `sealw <command> --help` for the exact accepted
parameters. Two-word spellings such as `core sync` and `scenario test` are the
documented command forms.

## Documentation

- [Start a first package](docs/quickstart.md)
- [Configure a package and target matrix](docs/configuration.md)
- [Develop, typecheck, validate, and test](docs/development-and-testing.md)
- [Write scenarios and render reports](docs/scenario-testing.md)
- [Package, sign, and automate releases](docs/release-and-ci.md)
- [Maintain target API contracts](docs/type-contract.md)
- [Find implementation and test ownership](docs/implementation-map.md)

## Examples

The repository contains independently runnable packages under
[`examples/`](examples/). Start with
[`004-custom-command`](examples/004-custom-command/) for a small command, then
move to [`adventure-prompts`](examples/adventure-prompts/) for a hybrid package
with a JSON deck and reply rules. Other examples cover storage, context data,
delegated rolls, HTTP mocks, custom rules, and the migrated
[`lightscript-loader`](examples/lightscript-loader/).

Run the full example regression with:

```sh
mise exec -- npm run test:examples
```

Use `mise exec -- npm run test:examples -- --plan` to list the work without
syncing a core. `test:examples:offline` requires an already verified cache for
every selected example target.

## Repository Verification

```sh
mise install
mise exec -- npm ci
mise exec -- npm run check
```

`check` builds the CLI, lints source, measures unit and managed-core
integration coverage together, runs the Go API scanner, smoke-tests the packed
npm installation, and runs all examples.
CI additionally installs Noto CJK fonts and `rsvg-convert` for reproducible
offline PNG reports.

## License

[MIT](LICENSE)
