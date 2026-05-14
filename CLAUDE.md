# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension that adds **Branches** and **Tags** views to the Source Control sidebar (IntelliJ-style branch management). Target: VS Code `^1.85.0`, Node 18, TypeScript strict.

## Commands

```bash
npm run compile    # esbuild bundle → out/extension.js
npm run watch      # esbuild watch mode
npm run typecheck  # tsc --noEmit (build does NOT type-check; run this separately)
```

There is no test suite, linter, or formatter configured. Press `F5` in VS Code to launch an Extension Development Host for manual testing. Package for distribution with `npx @vscode/vsce package --allow-missing-repository`.

Note: `esbuild` does not type-check — always run `npm run typecheck` before considering a change complete.

## Architecture

Four-file source tree under `src/`. The entry point `extension.ts` wires three collaborators created on activation:

- **`gitApi.ts`** — typed shim over the built-in `vscode.git` extension API (v1). Re-declares `Ref` / `Branch` / `Repository` / `GitApi` because VS Code's git extension does not ship its types. Some methods used at runtime (`renameBranch`, `tag`, `deleteTag`, `setTrackingBranch`) exist on the implementation but are not in the typed surface — call sites cast to `any`.
- **`branchTreeProvider.ts`** — `BranchesProvider` and `TagProvider` (both extend `AbstractProvider`), plus `HiddenRepos` (per-workspace memento for hidden repo paths) and the `TreeItem` subclasses. `AbstractProvider` debounces repo state changes (50ms) and attaches/detaches listeners on `onDidOpenRepository`/`onDidCloseRepository`.
- **`commands.ts`** — registers every `gitBranches.*` command listed in `package.json` `contributes.commands`. Also contains the branch-history webview (SVG lane graph renderer) used by `gitBranches.openHistory`.

### Two paths for git operations

This is the central architectural decision and the source of most subtlety in the code:

1. **`vscode.git` API methods** (`repo.checkout`, `repo.merge`, `repo.push`, `repo.pull`, `repo.fetch`, `repo.createBranch`, `repo.deleteBranch`, `repo.getBranches`, `repo.getRefs`) — preferred where available.
2. **`execFile` against the `git` binary** via the `runGit` helper in `commands.ts` — used for everything the public API doesn't expose: rebase, cherry-pick, rename, stash, delete remote branch, tags, merge strategies (`--squash`, `--no-ff`), `for-each-ref`, `ls-remote`, etc.

The git binary path comes from `vscode.workspace.getConfiguration('git').get('path')` (helper `getGitPath()` is duplicated in `commands.ts` and `branchTreeProvider.ts`). After any `execFile` git operation, callers invoke `vscode.commands.executeCommand('git.refresh')` so the built-in extension's cached state stays consistent — `runGit()` does this automatically.

### Refresh flow

`extension.ts` exposes a single `refresh()` closure to `registerCommands`. It calls `git.refresh`, waits 500ms for the built-in extension to update, then calls `invalidate()` on both providers. The `withProgress(title, fn)` wrapper in `commands.ts` runs an operation under a progress notification, awaits `_refresh?.()` on success, and shows the error's `stderr` (if any) otherwise. **All command handlers should use `withProgress` for any git operation** — it is the unified place that ties errors, progress UI, and refresh together.

### Provider quirks worth knowing

- `BranchesProvider` caches remote branches (`remoteCache`) only between `getRemoteGroups` and `getRemoteBranches` calls within the same render cycle; it's cleared on `invalidate()`. The cache filters out any "remote" that isn't in `repo.state.remotes` to avoid path-style branch names (e.g. `feature/x`) being misread as remote names.
- `getBranches({ remote: false })` returns the HEAD branch's `ahead`/`behind` as `undefined` in some VS Code versions; the provider patches these from `repo.state.HEAD` (which is reliable, same source as the status bar).
- `TagProvider` runs an async background sync check via `git for-each-ref` (local tag commits, peeled via `%(*objectname)`) + `git ls-remote --tags` (network). The `ls-remote` failure mode is signalled by `remoteCommits === null` → no sync indicator shown (rather than treating every tag as unpublished).
- `HiddenRepos` is per-workspace state (`workspaceState` memento) keyed by `repo.rootUri.fsPath`. Both providers filter through `visibleRepos()` and re-fire on `hidden.onDidChange`.

### Multi-repo behavior

When there is exactly one visible repo, the providers render its children at the root level. With multiple repos, each appears as a `RepoItem` parent. Command handlers that don't receive a `TreeItem` argument (toolbar commands, palette invocations) use `pickRepo()` to disambiguate.

### Bundling

`esbuild.js` bundles `src/extension.ts` → `out/extension.js`, externalizing `vscode`, targeting `node18`, CommonJS. `package.json` `main` points at the bundled output.
