import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BranchItem } from './branchTreeProvider';
import { GitApi, Ref, Repository } from './gitApi';

const execFileAsync = promisify(execFile);

function getGitPath(): string {
    return vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
}

async function runGit(repo: Repository, args: string[]): Promise<void> {
    const cwd = repo.rootUri.fsPath;
    await execFileAsync(getGitPath(), args, { cwd });
    // Notify the built-in git extension to refresh its internal state
    await vscode.commands.executeCommand('git.refresh');
}

function parseRemoteBranch(repo: Repository, ref: Ref): { remote: string; branch: string } {
    const fullName = ref.name ?? '';

    // ref.remote is the authoritative remote name set by the git extension
    if (ref.remote) {
        const branch = fullName.startsWith(ref.remote + '/')
            ? fullName.slice(ref.remote.length + 1)
            : fullName;
        return { remote: ref.remote, branch };
    }

    // Match against known remotes sorted longest-first (handles remotes with slashes)
    const remotes = [...repo.state.remotes].sort((a, b) => b.name.length - a.name.length);
    for (const r of remotes) {
        if (fullName.startsWith(r.name + '/')) {
            return { remote: r.name, branch: fullName.slice(r.name.length + 1) };
        }
    }

    // Split on first slash
    const idx = fullName.indexOf('/');
    if (idx !== -1) {
        return { remote: fullName.slice(0, idx), branch: fullName.slice(idx + 1) };
    }

    // Last resort: use first configured remote
    const firstRemote = repo.state.remotes[0]?.name ?? 'origin';
    return { remote: firstRemote, branch: fullName };
}

async function pickRepo(repos: Repository[]): Promise<Repository | undefined> {
    const picked = await vscode.window.showQuickPick(
        repos.map(r => ({ label: r.rootUri.path.split('/').pop() ?? '', repo: r })),
        { placeHolder: 'Select repository' }
    );
    return picked?.repo;
}

async function confirm(message: string, confirmLabel: string): Promise<boolean> {
    const result = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return result === confirmLabel;
}

let _refresh: (() => Promise<void>) | undefined;

async function withProgress<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
        try {
            const result = await fn();
            await _refresh?.();
            return result;
        } catch (e: any) {
            const msg = e.stderr ?? e.message ?? String(e);
            vscode.window.showErrorMessage(String(msg).trim());
            return undefined;
        }
    });
}

export function registerCommands(
    context: vscode.ExtensionContext,
    gitApi: GitApi,
    refresh: () => Promise<void>,
): void {
    _refresh = refresh;
    const reg = (id: string, fn: (item?: BranchItem) => Promise<void>) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    // ---- Local branch commands ----

    reg('gitBranches.update', async (item?) => {
        if (!item) { return; }
        const isCurrent = item.repo.state.HEAD?.name === item.ref.name;

        if (isCurrent) {
            // Current branch: repo.state.HEAD.upstream is always reliable
            if (!item.repo.state.HEAD?.upstream) {
                vscode.window.showErrorMessage(`"${item.ref.name}" has no upstream configured. Use Set Upstream first.`);
                return;
            }
            await withProgress(`Updating ${item.ref.name}...`, () => item.repo.pull());
            return;
        }

        // Non-current branch: getBranches() may not populate upstream in all VS Code versions,
        // so resolve it directly from git as a reliable fallback.
        let upstreamRef: string;
        try {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['rev-parse', '--abbrev-ref', `${item.ref.name}@{upstream}`],
                { cwd: item.repo.rootUri.fsPath }
            );
            upstreamRef = stdout.trim(); // e.g. "origin/feature-3.0.0"
        } catch {
            vscode.window.showErrorMessage(`"${item.ref.name}" has no upstream configured. Use Set Upstream first.`);
            return;
        }

        const slashIdx = upstreamRef.indexOf('/');
        const remote = upstreamRef.slice(0, slashIdx);
        const remoteBranch = upstreamRef.slice(slashIdx + 1);
        await withProgress(`Updating ${item.ref.name}...`, () =>
            runGit(item.repo, ['fetch', remote, `${remoteBranch}:${item.ref.name}`])
        );
    });

    reg('gitBranches.checkout', async (item?) => {
        if (!item) { return; }
        await withProgress(`Checking out ${item.ref.name}...`, () =>
            item.repo.checkout(item.ref.name!)
        );
    });

    reg('gitBranches.merge', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(`Merge "${item.ref.name}" into current branch?`, 'Merge');
        if (!ok) { return; }
        await withProgress(`Merging ${item.ref.name}...`, () =>
            item.repo.merge(item.ref.name!)
        );
    });

    reg('gitBranches.rebase', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(
            `Rebase current branch onto "${item.ref.name}"? This rewrites history.`,
            'Rebase'
        );
        if (!ok) { return; }
        await withProgress(`Rebasing onto ${item.ref.name}...`, () =>
            runGit(item.repo, ['rebase', item.ref.name!])
        );
    });

    reg('gitBranches.rename', async (item?) => {
        if (!item) { return; }
        const newName = await vscode.window.showInputBox({
            prompt: 'New branch name',
            value: item.ref.name,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!newName || newName === item.ref.name) { return; }
        await withProgress(`Renaming branch...`, () =>
            runGit(item.repo, ['branch', '-m', item.ref.name!, newName.trim()])
        );
    });

    reg('gitBranches.push', async (item?) => {
        if (!item) { return; }
        // Use the branch's configured upstream remote, or ask the user
        const upstream = (item.ref as any).upstream as { remote?: string } | undefined;
        let remoteName = upstream?.remote;
        if (!remoteName) {
            const remotes = item.repo.state.remotes;
            if (remotes.length === 0) {
                vscode.window.showErrorMessage('No remotes configured.');
                return;
            }
            if (remotes.length === 1) {
                remoteName = remotes[0].name;
            } else {
                const picked = await vscode.window.showQuickPick(
                    remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
                    { placeHolder: 'Select remote to push to' }
                );
                if (!picked) { return; }
                remoteName = picked.label;
            }
        }
        await withProgress(`Pushing ${item.ref.name} to ${remoteName}...`, () =>
            item.repo.push(remoteName, item.ref.name, true)
        );
    });

    reg('gitBranches.setUpstream', async (item?) => {
        if (!item) { return; }
        const remotes = item.repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        const pickedRemote = await vscode.window.showQuickPick(
            remotes.map(r => ({ label: r.name, description: r.fetchUrl })),
            { placeHolder: 'Select remote to track' }
        );
        if (!pickedRemote) { return; }
        const remoteBranchName = await vscode.window.showInputBox({
            prompt: `Remote branch name on "${pickedRemote.label}"`,
            value: item.ref.name,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!remoteBranchName) { return; }
        const upstream = `${pickedRemote.label}/${remoteBranchName.trim()}`;
        await withProgress(`Setting upstream to ${upstream}...`, () =>
            runGit(item.repo, ['branch', `--set-upstream-to=${upstream}`, item.ref.name!])
        );
    });

    reg('gitBranches.createFrom', async (item?) => {
        if (!item) { return; }
        const newName = await vscode.window.showInputBox({
            prompt: `New branch name (from ${item.ref.name})`,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!newName) { return; }
        await withProgress(`Creating branch ${newName}...`, () =>
            item.repo.createBranch(newName.trim(), true, item.ref.name)
        );
    });

    reg('gitBranches.deleteLocal', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(`Delete local branch "${item.ref.name}"?`, 'Delete');
        if (!ok) { return; }
        await withProgress(`Deleting branch ${item.ref.name}...`, async () => {
            try {
                await item.repo.deleteBranch(item.ref.name!, false);
            } catch (e: any) {
                if (String(e.stderr ?? e.message ?? e).includes('not fully merged')) {
                    const force = await confirm(
                        `"${item.ref.name}" is not fully merged. Force delete?`,
                        'Force Delete'
                    );
                    if (force) {
                        await item.repo.deleteBranch(item.ref.name!, true);
                    }
                } else {
                    throw e;
                }
            }
        });
    });

    // ---- Remote branch commands ----

    reg('gitBranches.checkoutRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const localName = await vscode.window.showInputBox({
            prompt: 'Local branch name',
            value: branch,
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!localName) { return; }
        await withProgress(`Checking out ${item.ref.name}...`, () =>
            runGit(item.repo, ['checkout', '-b', localName.trim(), `${remote}/${branch}`])
        );
    });

    reg('gitBranches.pull', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        await withProgress(`Fetching ${branch} from ${remote}...`, () =>
            item.repo.fetch(remote, branch)
        );
    });

    reg('gitBranches.deleteRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const ok = await confirm(
            `Delete remote branch "${branch}" on "${remote}"?`,
            'Delete'
        );
        if (!ok) { return; }
        await withProgress(`Deleting remote branch ${branch}...`, async () => {
            try {
                await runGit(item.repo, ['push', remote, '--delete', branch]);
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('remote ref does not exist')) {
                    // Branch already gone from remote; offer to prune stale local tracking ref
                    const action = await vscode.window.showWarningMessage(
                        `"${branch}" no longer exists on "${remote}". The local tracking ref is stale. Prune it?`,
                        'Prune',
                        'Cancel'
                    );
                    if (action === 'Prune') {
                        await runGit(item.repo, ['fetch', remote, '--prune']);
                    }
                } else {
                    throw e;
                }
            }
        });
    });

    // ---- Tag commands ----

    reg('gitBranches.checkoutTag', async (item?) => {
        if (!item) { return; }
        await withProgress(`Checking out tag ${item.ref.name}...`, () =>
            item.repo.checkout(item.ref.name!)
        );
    });

    reg('gitBranches.pushTag', async (item?) => {
        if (!item) { return; }
        const remotes = item.repo.state.remotes;
        if (remotes.length === 0) {
            vscode.window.showErrorMessage('No remotes configured.');
            return;
        }
        let remoteName: string;
        if (remotes.length === 1) {
            remoteName = remotes[0].name;
        } else {
            const picked = await vscode.window.showQuickPick(
                remotes.map(r => ({ label: r.name, description: r.pushUrl ?? r.fetchUrl })),
                { placeHolder: 'Select remote to push tag to' }
            );
            if (!picked) { return; }
            remoteName = picked.label;
        }
        await withProgress(`Pushing tag ${item.ref.name} to ${remoteName}...`, () =>
            runGit(item.repo, ['push', remoteName, `refs/tags/${item.ref.name}`])
        );
    });

    reg('gitBranches.deleteTag', async (item?) => {
        if (!item) { return; }
        const ok = await confirm(`Delete local tag "${item.ref.name}"?`, 'Delete');
        if (!ok) { return; }
        await withProgress(`Deleting tag ${item.ref.name}...`, () =>
            runGit(item.repo, ['tag', '-d', item.ref.name!])
        );
    });

    // ---- Global toolbar commands ----

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.fetchAll', async () => {
        const repos = gitApi.repositories;
        await withProgress('Fetching all remotes...', async () => {
            const results = await Promise.allSettled(repos.map(r => r.fetch()));
            const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failed.length > 0) {
                const msgs = failed.map(r => String(r.reason?.stderr ?? r.reason?.message ?? r.reason)).join('\n');
                throw new Error(msgs);
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.createBranch', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        const name = await vscode.window.showInputBox({
            prompt: 'New branch name (from current HEAD)',
            validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
        });
        if (!name) { return; }
        await withProgress(`Creating branch ${name}...`, () =>
            repo.createBranch(name.trim(), true)
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.createTag', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        const name = await vscode.window.showInputBox({
            prompt: 'Tag name',
            validateInput: v => v.trim() ? undefined : 'Tag name cannot be empty',
        });
        if (!name) { return; }

        const message = await vscode.window.showInputBox({
            prompt: 'Tag message (leave empty for lightweight tag)',
        });
        if (message === undefined) { return; }

        const tagArgs = message.trim()
            ? ['tag', '-a', name.trim(), '-m', message.trim()]
            : ['tag', name.trim()];
        await withProgress(`Creating tag ${name}...`, () =>
            runGit(repo, tagArgs)
        );
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.refresh', async () => {
        await refresh();
    }));

    // ---- Branch history ----

    reg('gitBranches.openHistory', async (item?) => {
        if (!item) { return; }
        const fullRef = item.ref.name ?? '';

        // Prefer Git Graph if installed — it provides a richer visual experience
        const gitGraph = vscode.extensions.getExtension('mhutchie.git-graph');
        if (gitGraph) {
            if (!gitGraph.isActive) { await gitGraph.activate(); }
            await vscode.commands.executeCommand('git-graph.view', item.repo.rootUri);
            return;
        }

        // Fallback: git log in an integrated terminal
        const terminal = vscode.window.createTerminal({
            name: `History: ${fullRef}`,
            cwd: item.repo.rootUri.fsPath,
            isTransient: true,
        });
        // Single-quote the ref to prevent shell interpretation; git refnames cannot contain single quotes
        terminal.sendText(
            `${getGitPath()} log --graph --oneline --decorate --color=always '${fullRef}'`
        );
        terminal.show();
    });

    // ---- Cherry-pick ----

    reg('gitBranches.cherryPick', async (item?) => {
        if (!item) { return; }
        const commit = item.ref.commit;
        if (!commit) {
            vscode.window.showErrorMessage('No commit hash available for this ref.');
            return;
        }
        const label = item.ref.name ?? commit.substring(0, 8);
        const ok = await confirm(`Cherry-pick tip commit of "${label}" (${commit.substring(0, 8)}) into current branch?`, 'Cherry-pick');
        if (!ok) { return; }
        await withProgress(`Cherry-picking ${commit.substring(0, 8)}...`, () =>
            runGit(item.repo, ['cherry-pick', commit])
        );
    });

    // ---- Stash ----

    async function getStashList(repo: Repository): Promise<{ label: string; index: number }[]> {
        const { stdout } = await execFileAsync(getGitPath(), ['stash', 'list', '--format=%gd: %s'], { cwd: repo.rootUri.fsPath });
        return stdout.trim().split('\n').filter(Boolean).map((line, i) => ({ label: line, index: i }));
    }

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.stash', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        const message = await vscode.window.showInputBox({
            prompt: 'Stash message (leave empty for default)',
        });
        if (message === undefined) { return; }

        const args = message.trim() ? ['stash', 'push', '-m', message.trim()] : ['stash', 'push'];
        await withProgress('Stashing changes...', () => runGit(repo, args));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.stashPop', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Popping latest stash...' }, async () => {
            try {
                await runGit(repo, ['stash', 'pop']);
                await _refresh?.();
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    // Stash was applied but has conflicts — this is not a fatal error
                    vscode.window.showWarningMessage('Stash applied with conflicts. Resolve conflicts before continuing.');
                    await _refresh?.();
                } else {
                    vscode.window.showErrorMessage(msg.trim());
                }
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.stashApply', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        let stashes: { label: string; index: number }[];
        try {
            stashes = await getStashList(repo);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e.stderr ?? e.message ?? e).trim());
            return;
        }
        if (stashes.length === 0) {
            vscode.window.showInformationMessage('No stashes found.');
            return;
        }
        const picked = await vscode.window.showQuickPick(stashes.map(s => s.label), { placeHolder: 'Select stash to apply' });
        if (!picked) { return; }
        const idx = stashes.find(s => s.label === picked)?.index ?? 0;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Applying stash@{${idx}}...` }, async () => {
            try {
                await runGit(repo, ['stash', 'apply', `stash@{${idx}}`]);
                await _refresh?.();
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    vscode.window.showWarningMessage('Stash applied with conflicts. Resolve conflicts before continuing.');
                    await _refresh?.();
                } else {
                    vscode.window.showErrorMessage(msg.trim());
                }
            }
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.stashDrop', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }

        let stashes: { label: string; index: number }[];
        try {
            stashes = await getStashList(repo);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e.stderr ?? e.message ?? e).trim());
            return;
        }
        if (stashes.length === 0) {
            vscode.window.showInformationMessage('No stashes found.');
            return;
        }
        const picked = await vscode.window.showQuickPick(stashes.map(s => s.label), { placeHolder: 'Select stash to drop' });
        if (!picked) { return; }
        const idx = stashes.find(s => s.label === picked)?.index ?? 0;
        const ok = await confirm(`Drop stash@{${idx}}?`, 'Drop');
        if (!ok) { return; }
        await withProgress(`Dropping stash@{${idx}}...`, () => runGit(repo, ['stash', 'drop', `stash@{${idx}}`]));
    }));
}
