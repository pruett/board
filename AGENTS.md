# Board

## Effect

Before writing or reviewing Effect code, read `repos/effect/LLMS.md`. It is the source of truth for idiomatic Effect v4: prefer its patterns, and the source and tests under `repos/effect/packages/effect/src` and `repos/effect/packages/effect/test`, over memory or web search. Worked examples by topic (services, errors, resources, schedule, testing, http-server, sql) are in `repos/effect/ai-docs/src/`.

## Vendored repositories

`repos/` holds read-only reference copies of upstream repos, added with `git subtree --squash`. Code imports from npm packages as usual; `repos/` is never imported, edited, built or tested.

`repos/effect` is pinned to the tag matching the `effect` version in `package.json`, so the reference matches the code we run. When bumping `effect`, move the subtree in the same change:

```sh
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```
