import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { BranchItem, HiddenRepos, RepoItem } from './branchTreeProvider';
import { Branch, GitApi, Ref, Repository } from './gitApi';

const execFileAsync = promisify(execFile);

function getGitPath(): string {
    return vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
}

async function runGit(repo: Repository, args: string[]): Promise<{ stdout: string; stderr: string }> {
    const cwd = repo.rootUri.fsPath;
    const result = await execFileAsync(getGitPath(), args, { cwd });
    // Notify the built-in git extension to refresh its internal state
    await vscode.commands.executeCommand('git.refresh');
    return result;
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

// ---- History webview helpers ----

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ICON_BRANCH = '<svg class="ref-icon" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.49 2.49 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z"/></svg>';
const ICON_TAG = '<svg class="ref-icon" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M1 2.75A1.75 1.75 0 0 1 2.75 1h5.586c.464 0 .909.184 1.237.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.586 5.586a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 8.336V2.75zM5 5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>';

function renderRefs(refs: string): string {
    if (!refs.trim()) { return ''; }
    return refs.split(',').map(r => r.trim()).filter(Boolean).map(ref => {
        if (ref.startsWith('HEAD ->')) {
            const branch = escapeHtml(ref.slice('HEAD -> '.length));
            return `<span class="ref-pill ref-head">${ICON_BRANCH}<span>${branch}</span></span>`;
        }
        if (ref === 'HEAD') { return `<span class="ref-pill ref-head">${ICON_BRANCH}<span>HEAD</span></span>`; }
        if (ref.startsWith('tag: ')) {
            return `<span class="ref-pill ref-tag">${ICON_TAG}<span>${escapeHtml(ref.slice(5))}</span></span>`;
        }
        if (ref.includes('/')) { return `<span class="ref-pill ref-remote">${ICON_BRANCH}<span>${escapeHtml(ref)}</span></span>`; }
        return `<span class="ref-pill ref-local">${ICON_BRANCH}<span>${escapeHtml(ref)}</span></span>`;
    }).join('');
}

// ---- SVG graph lane renderer ----

const GRAPH_COLORS = ['#61afef', '#98c379', '#e5c07b', '#e06c75', '#c678dd', '#56b6c2', '#d19a66'];
const LANE_W = 14;
const ROW_H  = 22;
const DOT_R  = 3.5;

interface CommitData {
    hash: string;
    display: string;
    parents: string[];
    refs: string;
    subject: string;
    date: string;
    author: string;
}

interface RowLayout {
    col: number;
    color: string;
    colColors: string[];
    topLanes: (string | null)[];
    botLanes: (string | null)[];
    firstParentConvergesTo: number | null;
    mergeParents: { targetCol: number; color: string }[];
}

function computeLayout(commits: CommitData[]): RowLayout[] {
    const lanes: (string | null)[] = [];
    const laneColors: string[] = [];
    let nextColor = 0;

    return commits.map(commit => {
        // Find or allocate a lane for this commit
        let col = lanes.indexOf(commit.hash);
        if (col === -1) {
            const free = lanes.indexOf(null);
            if (free !== -1) {
                col = free;
                laneColors[col] = GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length];
            } else {
                col = lanes.length;
                lanes.push(null);
                laneColors.push(GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length]);
            }
        }
        const color = laneColors[col];

        const topLanes: (string | null)[] = lanes.slice();
        while (topLanes.length <= col) { topLanes.push(null); }

        let firstParentConvergesTo: number | null = null;
        const mergeParents: { targetCol: number; color: string }[] = [];

        if (commit.parents.length === 0) {
            lanes[col] = null;
        } else {
            const p0Lane = lanes.indexOf(commit.parents[0]);
            if (p0Lane === -1 || p0Lane === col) {
                lanes[col] = commit.parents[0];
            } else {
                // First parent already tracked by another lane — converge
                lanes[col] = null;
                firstParentConvergesTo = p0Lane;
            }
            for (const p of commit.parents.slice(1)) {
                const pLane = lanes.indexOf(p);
                if (pLane !== -1) {
                    mergeParents.push({ targetCol: pLane, color: laneColors[pLane] ?? color });
                } else {
                    let newCol = lanes.indexOf(null);
                    if (newCol === -1) { newCol = lanes.length; lanes.push(null); }
                    if (!laneColors[newCol]) { laneColors[newCol] = GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length]; }
                    lanes[newCol] = p;
                    mergeParents.push({ targetCol: newCol, color: laneColors[newCol] });
                }
            }
        }

        const botLanes: (string | null)[] = lanes.slice();
        while (botLanes.length <= col) { botLanes.push(null); }

        return { col, color, colColors: laneColors.slice(), topLanes, botLanes, firstParentConvergesTo, mergeParents };
    });
}

function renderRowSvg(row: RowLayout, svgWidth: number): string {
    const cx = row.col * LANE_W + LANE_W / 2;
    const cy = ROW_H / 2;
    const els: string[] = [];
    const maxJ = Math.max(row.topLanes.length, row.botLanes.length);

    // Pass-through verticals for other lanes
    for (let j = 0; j < maxJ; j++) {
        if (j === row.col) { continue; }
        const x   = j * LANE_W + LANE_W / 2;
        const top = j < row.topLanes.length ? row.topLanes[j] : null;
        const bot = j < row.botLanes.length ? row.botLanes[j] : null;
        const c   = (j < row.colColors.length ? row.colColors[j] : null) ?? GRAPH_COLORS[j % GRAPH_COLORS.length];
        if (top !== null && bot !== null) {
            els.push(`<line x1="${x}" y1="0" x2="${x}" y2="${ROW_H}" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/>`);
        }
    }

    // Incoming line from above (to commit dot)
    if (row.topLanes[row.col] !== null) {
        els.push(`<line x1="${cx}" y1="0" x2="${cx}" y2="${cy}" stroke="${row.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // Outgoing line below (first parent, same lane)
    if (row.botLanes[row.col] !== null) {
        els.push(`<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${ROW_H}" stroke="${row.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // First parent converges to another lane
    if (row.firstParentConvergesTo !== null) {
        const tx = row.firstParentConvergesTo * LANE_W + LANE_W / 2;
        els.push(`<path d="M ${cx},${cy} C ${cx},${ROW_H} ${tx},${cy} ${tx},${ROW_H}" fill="none" stroke="${row.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // Merge parents — bezier curves from dot to each parent lane bottom
    for (const mp of row.mergeParents) {
        const tx = mp.targetCol * LANE_W + LANE_W / 2;
        els.push(`<path d="M ${cx},${cy} C ${cx},${ROW_H} ${tx},${cy} ${tx},${ROW_H}" fill="none" stroke="${mp.color}" stroke-width="1.5" stroke-linecap="round"/>`);
    }
    // Commit dot (drawn last, appears on top)
    els.push(`<circle cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${row.color}" stroke="var(--vscode-editor-background,#1e1e1e)" stroke-width="1.5"/>`);

    return `<svg width="${svgWidth}" height="${ROW_H}" style="display:block;overflow:visible" xmlns="http://www.w3.org/2000/svg">${els.join('')}</svg>`;
}

function buildHistoryHtml(commits: CommitData[], ref: string): string {
    const layouts = computeLayout(commits);
    const totalCols = Math.max(1, ...layouts.map(r => Math.max(r.topLanes.length, r.botLanes.length)));
    const svgWidth = totalCols * LANE_W;

    const rows = commits.map((c, i) => {
        const row = layouts[i];
        return `<tr class="commit-row">
  <td class="col-graph">${renderRowSvg(row, svgWidth)}</td>
  <td class="col-hash">${escapeHtml(c.display)}</td>
  <td class="col-refs"${c.refs.trim() ? ` title="${escapeHtml(c.refs)}"` : ''}><div class="refs-inner">${renderRefs(c.refs)}</div></td>
  <td class="col-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</td>
  <td class="col-date">${escapeHtml(c.date)}</td>
  <td class="col-author">${escapeHtml(c.author)}</td>
</tr>`;
    }).join('');

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; overflow-x: auto;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 8px 14px 7px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.03em;
  }
  .toolbar span { color: var(--vscode-foreground); }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  thead th {
    position: sticky; top: 37px; z-index: 9;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    text-align: left; font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.06em; text-transform: uppercase;
    white-space: nowrap;
  }
  td { padding: 2px 10px; white-space: nowrap; vertical-align: middle; }
  tr.commit-row:hover td { background: var(--vscode-list-hoverBackground); }
  .col-graph  { padding-left: 6px; padding-right: 4px; }
  .col-hash   { color: #e5c07b; font-weight: bold; min-width: 7ch; }
  .col-refs   { min-width: 80px; max-width: 220px; }
  .col-refs .refs-inner { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-subject{ max-width: 560px; overflow: hidden; text-overflow: ellipsis; }
  .col-date   { color: var(--vscode-descriptionForeground); min-width: 100px; text-align: right; padding-right: 14px; }
  .col-author { color: #61afef; min-width: 100px; }
  .ref-pill {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 0 5px; margin-right: 3px;
    border-radius: 8px;
    font-size: 10px; line-height: 14px; height: 14px;
    vertical-align: middle;
    max-width: 110px;
    border: 1px solid transparent;
  }
  .ref-pill > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref-icon { flex: 0 0 auto; opacity: 0.85; }
  .ref-head   { background: rgba(86,182,194,.18);  color: #56b6c2; border-color: rgba(86,182,194,.35); font-weight: 600; }
  .ref-local  { background: rgba(152,195,121,.18); color: #98c379; border-color: rgba(152,195,121,.30); }
  .ref-remote { background: rgba(224,108,117,.16); color: #e06c75; border-color: rgba(224,108,117,.28); }
  .ref-tag    { background: rgba(229,192,123,.18); color: #e5c07b; border-color: rgba(229,192,123,.35); }
</style>
</head>
<body>
<div class="toolbar">History · <span>${escapeHtml(ref)}</span></div>
<table>
  <thead>
    <tr>
      <th style="min-width:${svgWidth + 16}px"></th>
      <th>Hash</th>
      <th>Refs</th>
      <th>Message</th>
      <th style="text-align:right;padding-right:14px">Date</th>
      <th>Author</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;
}

export function registerCommands(
    context: vscode.ExtensionContext,
    gitApi: GitApi,
    refresh: () => Promise<void>,
    hiddenRepos: HiddenRepos,
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

        const strategies = [
            { label: 'Merge', description: 'Create a merge commit', value: 'merge' as const },
            { label: 'Squash and Merge', description: 'Squash all commits into one staged change', value: 'squash' as const },
            { label: 'No Fast-Forward', description: 'Always create a merge commit (--no-ff)', value: 'no-ff' as const },
        ];
        const strategy = await vscode.window.showQuickPick(strategies, {
            placeHolder: `Merge "${item.ref.name}" into current branch — select strategy`,
        });
        if (!strategy) { return; }

        const ok = await confirm(`${strategy.label} "${item.ref.name}" into current branch?`, strategy.label);
        if (!ok) { return; }

        await withProgress(`Merging ${item.ref.name}...`, async () => {
            if (strategy.value === 'squash') {
                await runGit(item.repo, ['merge', '--squash', item.ref.name!]);
                vscode.window.showInformationMessage(
                    `"${item.ref.name}" squashed and staged. Commit to complete the merge.`
                );
            } else if (strategy.value === 'no-ff') {
                await runGit(item.repo, ['merge', '--no-ff', '--no-edit', item.ref.name!]);
            } else {
                await item.repo.merge(item.ref.name!);
            }
        });
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

    reg('gitBranches.checkoutAndRebase', async (item?) => {
        if (!item) { return; }
        const currentBranch = item.repo.state.HEAD?.name;
        if (!currentBranch) {
            vscode.window.showErrorMessage('No current branch.');
            return;
        }
        const ok = await confirm(
            `Checkout "${item.ref.name}" and rebase it onto "${currentBranch}"? This rewrites history.`,
            'Checkout and Rebase'
        );
        if (!ok) { return; }
        await withProgress(`Rebasing ${item.ref.name} onto ${currentBranch}...`, async () => {
            await item.repo.checkout(item.ref.name!);
            try {
                await runGit(item.repo, ['rebase', currentBranch]);
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    vscode.window.showWarningMessage(
                        'Rebase has conflicts. Resolve them, then run "git rebase --continue". To cancel: "git rebase --abort".'
                    );
                } else {
                    throw e;
                }
            }
        });
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
        let remoteName = (item.ref as Branch).upstream?.remote;
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
        // Try a normal delete; on "not fully merged" offer force delete outside the progress toast.
        let notFullyMerged = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting branch ${item.ref.name}...` },
            async () => {
                try {
                    await item.repo.deleteBranch(item.ref.name!, false);
                    await _refresh?.();
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('not fully merged')) {
                        notFullyMerged = true;
                    } else {
                        vscode.window.showErrorMessage(msg.trim());
                    }
                }
            }
        );
        if (notFullyMerged) {
            const force = await confirm(
                `"${item.ref.name}" is not fully merged. Force delete?`,
                'Force Delete'
            );
            if (!force) { return; }
            await withProgress(`Force deleting branch ${item.ref.name}...`, () =>
                item.repo.deleteBranch(item.ref.name!, true)
            );
        }
    });

    reg('gitBranches.compareWithCurrent', async (item?) => {
        if (!item) { return; }
        const head = item.repo.state.HEAD?.name;
        if (!head) {
            vscode.window.showErrorMessage('No current branch.');
            return;
        }

        let diffLines: string[];
        try {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['diff', `${head}...${item.ref.name}`, '--name-status'],
                { cwd: item.repo.rootUri.fsPath }
            );
            diffLines = stdout.trim().split('\n').filter(Boolean);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e.stderr ?? e.message ?? e).trim());
            return;
        }

        if (diffLines.length === 0) {
            vscode.window.showInformationMessage(`No differences between "${head}" and "${item.ref.name}".`);
            return;
        }

        const statusLabels: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied' };
        type FileEntry = { label: string; description: string; filePath: string; leftRef: string; rightRef: string };
        const entries: FileEntry[] = diffLines.map(line => {
            const parts = line.split('\t');
            const statusCode = parts[0][0];
            // Renames/copies: <STATUS>\t<old>\t<new> — use the new path for the right side, old path for left
            const isRenameOrCopy = statusCode === 'R' || statusCode === 'C';
            const leftPath = isRenameOrCopy ? parts[1] : parts[1];
            const rightPath = isRenameOrCopy ? parts[2] : parts[1];
            return {
                label: rightPath,
                description: statusLabels[statusCode] ?? parts[0],
                filePath: rightPath,
                leftRef: statusCode === 'A' ? '' : head,   // Added files don't exist in current
                rightRef: statusCode === 'D' ? '' : item.ref.name!, // Deleted files don't exist in target
            };
        });

        const picked = await vscode.window.showQuickPick(entries, {
            placeHolder: `${entries.length} file(s) changed  ·  ${head}  ↔  ${item.ref.name}`,
            matchOnDescription: true,
        });
        if (!picked) { return; }

        const absUri = vscode.Uri.joinPath(item.repo.rootUri, picked.filePath);
        // For added/deleted files use an empty git URI (shows empty editor on that side)
        const leftUri  = picked.leftRef  ? gitApi.toGitUri(absUri, picked.leftRef)  : absUri.with({ scheme: 'git', query: JSON.stringify({ path: absUri.fsPath, ref: '~' }) });
        const rightUri = picked.rightRef ? gitApi.toGitUri(absUri, picked.rightRef) : absUri.with({ scheme: 'git', query: JSON.stringify({ path: absUri.fsPath, ref: '~' }) });

        await vscode.commands.executeCommand(
            'vscode.diff',
            leftUri,
            rightUri,
            `${picked.filePath}  (${head} ↔ ${item.ref.name})`
        );
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

    reg('gitBranches.pullIntoCurrent', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const currentBranch = item.repo.state.HEAD?.name;
        if (!currentBranch) {
            vscode.window.showErrorMessage('No current branch.');
            return;
        }

        const strategies = [
            { label: 'Merge', description: `Fetch and merge ${remote}/${branch} into ${currentBranch}`, value: 'merge' as const },
            { label: 'Rebase', description: `Fetch then rebase ${currentBranch} onto ${remote}/${branch}`, value: 'rebase' as const },
        ];
        const strategy = await vscode.window.showQuickPick(strategies, {
            placeHolder: `Pull ${remote}/${branch} into "${currentBranch}"`,
        });
        if (!strategy) { return; }

        await withProgress(`Pulling ${branch} into ${currentBranch}...`, async () => {
            await runGit(item.repo, ['fetch', remote, branch]);
            if (strategy.value === 'merge') {
                await item.repo.merge(`${remote}/${branch}`);
            } else {
                try {
                    await runGit(item.repo, ['rebase', `${remote}/${branch}`]);
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                        vscode.window.showWarningMessage(
                            'Rebase has conflicts. Resolve them, then run "git rebase --continue". To cancel: "git rebase --abort".'
                        );
                    } else {
                        throw e;
                    }
                }
            }
        });
    });

    reg('gitBranches.deleteRemote', async (item?) => {
        if (!item) { return; }
        const { remote, branch } = parseRemoteBranch(item.repo, item.ref);
        const ok = await confirm(
            `Delete remote branch "${branch}" on "${remote}"?`,
            'Delete'
        );
        if (!ok) { return; }
        // If the branch is already gone on the remote, offer to prune the stale tracking ref.
        // The prune dialog must be shown outside withProgress to avoid overlapping UI.
        let alreadyGone = false;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Deleting remote branch ${branch}...` },
            async () => {
                try {
                    await runGit(item.repo, ['push', remote, '--delete', branch]);
                    await _refresh?.();
                } catch (e: any) {
                    const msg = String(e.stderr ?? e.message ?? e);
                    if (msg.includes('remote ref does not exist')) {
                        alreadyGone = true;
                    } else {
                        vscode.window.showErrorMessage(msg.trim());
                    }
                }
            }
        );
        if (alreadyGone) {
            const action = await vscode.window.showWarningMessage(
                `"${branch}" no longer exists on "${remote}". Prune stale local tracking ref?`,
                'Prune', 'Cancel'
            );
            if (action === 'Prune') {
                await withProgress(`Pruning ${remote}...`, () =>
                    runGit(item.repo, ['fetch', remote, '--prune'])
                );
            }
        }
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
            results.forEach((r, i) => {
                if (r.status === 'rejected') {
                    const name = repos[i].rootUri.path.split('/').pop() ?? 'unknown';
                    const msg = String(r.reason?.stderr ?? r.reason?.message ?? r.reason).trim();
                    vscode.window.showErrorMessage(`Fetch failed (${name}): ${msg}`);
                }
            });
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

    // ---- Multi-repo visibility ----

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.hideRepository', async (item?: RepoItem) => {
        if (!item) {
            const visible = gitApi.repositories.filter(r => !hiddenRepos.isHidden(r));
            if (visible.length === 0) { return; }
            const picked = await vscode.window.showQuickPick(
                visible.map(r => ({ label: r.rootUri.path.split('/').pop() ?? r.rootUri.fsPath, description: r.rootUri.fsPath, repo: r })),
                { placeHolder: 'Hide repository from Git Branches view' }
            );
            if (!picked) { return; }
            await hiddenRepos.hide(picked.repo);
            return;
        }
        await hiddenRepos.hide(item.repo);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.showInBranchesView', async (uri?: vscode.Uri) => {
        if (!uri) {
            vscode.window.showErrorMessage('No folder selected.');
            return;
        }
        const target = uri.fsPath;
        const findRepo = () => gitApi.repositories
            .filter(r => target === r.rootUri.fsPath || target.startsWith(r.rootUri.fsPath + '/'))
            .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length)[0];

        let repo = findRepo();

        // Not currently tracked by vscode.git — ask it to open the folder as a repo.
        // Required for sub-folders of a workspace that contain their own .git directory.
        if (!repo && gitApi.openRepository) {
            try {
                await gitApi.openRepository(uri);
            } catch {
                // Will surface below as "no repo"
            }
            repo = findRepo();
        }

        if (!repo) {
            vscode.window.showWarningMessage(`No git repository at "${target}".`);
            return;
        }
        const name = repo.rootUri.path.split('/').pop() ?? repo.rootUri.fsPath;
        if (!hiddenRepos.isHidden(repo)) {
            vscode.window.showInformationMessage(`"${name}" is already visible in Git Branches.`);
            return;
        }
        await hiddenRepos.show(repo.rootUri.fsPath);
        vscode.window.showInformationMessage(`"${name}" added to Git Branches.`);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.showHiddenRepository', async () => {
        const paths = hiddenRepos.paths();
        if (paths.length === 0) {
            vscode.window.showInformationMessage('No hidden repositories.');
            return;
        }
        const items = paths.map(p => ({ label: p.split('/').pop() ?? p, description: p, fsPath: p }));
        const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Show hidden repository', canPickMany: false });
        if (!picked) { return; }
        await hiddenRepos.show(picked.fsPath);
    }));

    // ---- Branch history ----

    reg('gitBranches.openHistory', async (item?) => {
        if (!item) { return; }
        const fullRef = item.ref.name ?? '';

        const panel = vscode.window.createWebviewPanel(
            'gitBranchHistory',
            `History: ${fullRef}`,
            vscode.ViewColumn.Active,
            { enableScripts: false, retainContextWhenHidden: true }
        );

        const SEP = '\x01';
        try {
            const { stdout } = await execFileAsync(getGitPath(), [
                'log', '--topo-order',
                `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%D${SEP}%s${SEP}%cr${SEP}%an`,
                fullRef,
            ], { cwd: item.repo.rootUri.fsPath });
            const commits: CommitData[] = stdout.trim().split('\n').filter(Boolean).map(line => {
                const parts = line.split(SEP);
                return {
                    hash:    parts[0] ?? '',
                    display: parts[1] ?? '',
                    parents: (parts[2] ?? '').trim().split(/\s+/).filter(Boolean),
                    refs:    parts[3] ?? '',
                    subject: parts[4] ?? '',
                    date:    parts[5] ?? '',
                    author:  parts[6] ?? '',
                };
            });
            panel.webview.html = buildHistoryHtml(commits, fullRef);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e.stderr ?? e.message ?? e).trim());
            panel.dispose();
        }
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

        // --include-untracked matches IntelliJ's default behaviour (new files are included)
        const args = message.trim()
            ? ['stash', 'push', '--include-untracked', '-m', message.trim()]
            : ['stash', 'push', '--include-untracked'];
        await withProgress('Stashing changes...', () => runGit(repo, args));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitBranches.stashPop', async () => {
        const repos = gitApi.repositories;
        if (repos.length === 0) { return; }
        const repo = repos.length === 1 ? repos[0] : await pickRepo(repos);
        if (!repo) { return; }
        await withProgress('Popping latest stash...', async () => {
            try {
                await runGit(repo, ['stash', 'pop']);
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    // Stash was applied but has conflicts — not a fatal error, refresh and warn
                    vscode.window.showWarningMessage('Stash applied with conflicts. Resolve conflicts before continuing.');
                } else {
                    throw e;
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
        await withProgress(`Applying stash@{${idx}}...`, async () => {
            try {
                await runGit(repo, ['stash', 'apply', `stash@{${idx}}`]);
            } catch (e: any) {
                const msg = String(e.stderr ?? e.message ?? e);
                if (msg.includes('conflict') || msg.includes('CONFLICT')) {
                    vscode.window.showWarningMessage('Stash applied with conflicts. Resolve conflicts before continuing.');
                } else {
                    throw e;
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
