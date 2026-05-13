# Fork Maintenance

This fork carries changes I want to use even when upstream is not taking them.

## Remotes

Use `origin` for my fork and `upstream` for the official repo.

```bash
git remote -v
```

Keep upstream push disabled:

```bash
git remote set-url --push upstream DISABLED
git config remote.pushDefault origin
```

## Branches

- `main`: stable fork branch.
- `upstream/main`: official T3 Code.
- `fork/<feature>`: fork-only feature branch.
- `sync/<date>`: optional upstream sync branch.

Keep fork features in small PRs. Stack PRs when one feature depends on another.

## Syncing

Sync before local releases and before touching code that upstream recently changed.

```bash
git checkout main
git fetch upstream
git merge upstream/main
bun fmt
bun lint
bun typecheck
```

If conflicts happen, resolve them feature by feature. Avoid broad rewrites during upstream syncs.

## Pull Requests

Open PRs inside `frontendwizard/t3code`, not upstream.

Use explicit repo, base, and head values:

```bash
gh pr create --repo frontendwizard/t3code --base main --head fork/my-feature
```

For stacked PRs, set the base to the previous feature branch.

## Local Builds

Do not commit generated DMG, zip, blockmap, or builder debug artifacts.

## Required Checks

Before considering a fork PR done:

```bash
bun fmt
bun lint
bun typecheck
```

Do not run `bun test`; use `bun run test` when tests are needed.
