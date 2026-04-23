# Git Branches

A VS Code extension that adds a dedicated **Branches** and **Tags** panel to the Source Control sidebar, inspired by the branch management UI in IntelliJ IDEA.

## Features

### Branches Panel

Displays local and remote branches together in a single tree, grouped by scope:

```
▼ BRANCHES
  ▼ Local
      ★ main (current)
        feature/login
        fix/typo
  ▼ Remote
    ▼ origin
        main
        feature/login
```

**Current branch** is pinned to the top with a star icon.  
**Remote branches** are grouped under their remote name.

#### Local branch actions (right-click)

| Action | Description |
|--------|-------------|
| Checkout | Switch to this branch |
| Create Branch from Here | Create and checkout a new branch from this one |
| Merge into Current | Merge this branch into the current branch |
| Rebase onto This Branch | Rebase current branch onto this one |
| Cherry-pick Tip Commit | Cherry-pick the latest commit of this branch |
| Push | Push to its upstream remote (auto-detected or prompted) |
| Set Upstream | Set the tracking remote branch |
| Rename Branch | Rename in-place |
| Delete Branch | Delete locally (offers force-delete if not fully merged) |
| View History | Open `git log` in a terminal |

#### Remote branch actions (right-click)

| Action | Description |
|--------|-------------|
| Checkout (Create Tracking Branch) | Create a local tracking branch |
| Fetch | Fetch the latest state of this branch |
| Cherry-pick Tip Commit | Cherry-pick the latest commit |
| Delete Remote Branch | Delete on the remote (offers prune if already gone) |
| View History | Open `git log` in a terminal |

#### Local group actions (right-click on "Local")

| Action | Description |
|--------|-------------|
| Create Branch | Create a new branch from current HEAD |
| Stash Changes | Stash uncommitted changes |
| Pop Stash | Pop the latest stash |
| Apply Stash... | Pick and apply a stash |
| Drop Stash... | Pick and drop a stash |

#### Remote group actions (right-click on "Remote" or a remote name)

| Action | Description |
|--------|-------------|
| Fetch All | Fetch all remotes |

### Tags Panel

Lists all local tags alphabetically.

#### Tag actions (right-click)

| Action | Description |
|--------|-------------|
| Checkout Tag | Checkout in detached HEAD mode |
| Push Tag | Push to a remote |
| Delete Tag | Delete locally |

#### Toolbar (Tags panel)

| Button | Description |
|--------|-------------|
| Create Tag | Create a lightweight or annotated tag at current HEAD |
| Refresh | Refresh the tags list |

### Toolbar (Branches panel)

| Button | Description |
|--------|-------------|
| Create Branch | Create a new branch from current HEAD |
| Refresh | Refresh the branches list |

### Multi-root workspace support

When multiple git repositories are open, branches and tags are grouped under a repository node.

## Requirements

- VS Code `1.85.0` or later
- The built-in **Git** extension must be enabled
- Git installed and accessible (uses the path configured in `git.path`)

## Installation

### From VSIX (local build)

```bash
git clone https://github.com/your-username/vscode-git-branches.git
cd vscode-git-branches
npm install
npx @vscode/vsce package --allow-missing-repository
code --install-extension vscode-git-branches-0.0.1.vsix
```

Then reload VS Code (`Developer: Reload Window`).

## Development

```bash
npm install       # install dependencies
npm run compile   # build once
npm run watch     # build in watch mode
npm run typecheck # type-check without emitting
```

Press `F5` in VS Code to launch an Extension Development Host.

## How It Works

This extension delegates all git operations to the built-in `vscode.git` extension API (v1) where possible. Operations not exposed by the public API (rebase, rename, stash, cherry-pick, delete remote branch, tags) are executed via `child_process.execFile` using the git binary configured in `git.path`.

After each operation the built-in git extension is notified via `git.refresh` so its internal state stays in sync.
