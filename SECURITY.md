# Security Policy

## Supported Versions

Security fixes are applied to the current `main` branch and the latest `0.1.x`
release. Older snapshots are unsupported.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting for this repository when it is
enabled. Do not include an exploit, private key, access token, or a live target
in a public issue. If private reporting is unavailable, contact the repository
owner through the contact channel published in the repository profile.

Reports should include the affected version or commit, reproduction steps,
impact, and any mitigation already tested. Maintainers aim to acknowledge
reports within seven days and will coordinate disclosure after a fix is ready.

## Security Boundaries

`sealwrapper` executes lock-managed Git and Go tooling, validates untrusted
extension input, and writes only within a project boundary. Reports involving
path traversal, symlink races, archive expansion, subprocess lifetime,
dependency integrity, signing, or CI permissions are in scope.
