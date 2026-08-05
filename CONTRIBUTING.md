# Contributing

Use the pinned toolchain and run the narrowest relevant test while developing:

```sh
mise install
mise exec -- npm ci
mise exec -- npm test
```

Before requesting review, run `mise exec -- npm run check`. Changes to lock
validation, managed-core paths, release publication, or trust descriptors also
need a negative regression test. Do not update a generated API contract without
reviewing the corresponding managed core and using `sealw types update --write`.

Source files use LF endings, a final newline, explicit error handling, and no
TypeScript suppression comments, `eval`, or `Function` constructors. Keep
production input untyped only at an explicit `unknown` boundary and validate it
before use.

Do not commit `.seal/`, private signing keys, downloaded cores, or generated
release artifacts. Security-sensitive reports follow [SECURITY.md](SECURITY.md),
not public issues.
