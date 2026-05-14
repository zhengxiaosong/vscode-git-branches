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

interface LayoutState {
    lanes: (string | null)[];
    laneColors: string[];
    nextColor: number;
}

function createLayoutState(): LayoutState {
    return { lanes: [], laneColors: [], nextColor: 0 };
}

function computeLayout(commits: CommitData[], state: LayoutState = createLayoutState()): RowLayout[] {
    const lanes = state.lanes;
    const laneColors = state.laneColors;

    return commits.map(commit => {
        // Find or allocate a lane for this commit
        let col = lanes.indexOf(commit.hash);
        if (col === -1) {
            const free = lanes.indexOf(null);
            if (free !== -1) {
                col = free;
                laneColors[col] = GRAPH_COLORS[state.nextColor++ % GRAPH_COLORS.length];
            } else {
                col = lanes.length;
                lanes.push(null);
                laneColors.push(GRAPH_COLORS[state.nextColor++ % GRAPH_COLORS.length]);
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
                    if (!laneColors[newCol]) { laneColors[newCol] = GRAPH_COLORS[state.nextColor++ % GRAPH_COLORS.length]; }
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

// Empty tree SHA — used as the "parent" when a commit has none (root commit).
// Diffing against this gives the full content of the commit's tree.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface ChangedFile {
    status: string; // 'A' | 'M' | 'D' | 'R' | 'C' | 'T' (single letter from git)
    path: string;   // new path (or only path for non-renames)
    oldPath?: string; // original path for renames/copies
}

function parseNameStatusOutput(stdout: string): ChangedFile[] {
    const out: ChangedFile[] = [];
    for (const line of stdout.split('\n')) {
        if (!line) { continue; }
        const parts = line.split('\t');
        const rawStatus = parts[0] ?? '';
        const status = rawStatus[0] ?? '';
        if (status === 'R' || status === 'C') {
            out.push({ status, oldPath: parts[1] ?? '', path: parts[2] ?? '' });
        } else {
            out.push({ status, path: parts[1] ?? '' });
        }
    }
    return out;
}

async function getChangedFiles(repo: Repository, hash: string, parent: string | undefined): Promise<ChangedFile[]> {
    const left = parent && parent.length > 0 ? parent : EMPTY_TREE_SHA;
    const { stdout } = await execFileAsync(
        getGitPath(),
        ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', left, hash],
        { cwd: repo.rootUri.fsPath }
    );
    return parseNameStatusOutput(stdout);
}

// Files differing between two arbitrary refs (used for range comparison: cmd+click in history).
async function getChangedFilesBetween(repo: Repository, leftRef: string, rightRef: string): Promise<ChangedFile[]> {
    const { stdout } = await execFileAsync(
        getGitPath(),
        ['diff', '--name-status', '-r', '-M', leftRef, rightRef],
        { cwd: repo.rootUri.fsPath }
    );
    return parseNameStatusOutput(stdout);
}

// Custom scheme so we have full control over content resolution.
// Built-in `git:` scheme's behavior for refs that don't contain the file is
// inconsistent across VS Code versions (sometimes returns empty, sometimes
// "file not found"). We run `git show <ref>:<path>` ourselves and return ''
// on failure so the diff side renders cleanly empty.
const COMMIT_FILE_SCHEME = 'gitbranches-show';
const SHOW_MAX_BUFFER = 64 * 1024 * 1024;

export class CommitFileContentProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const params = new URLSearchParams(uri.query);
        const repoRoot = params.get('repo') ?? '';
        const filePath = params.get('path') ?? '';
        const ref      = params.get('ref')  ?? '';
        console.log('[gitBranches] provideTextDocumentContent', { repoRoot, filePath, ref });
        if (!repoRoot || !filePath || !ref) { return ''; }
        try {
            const { stdout } = await execFileAsync(
                getGitPath(),
                ['show', `${ref}:${filePath}`],
                { cwd: repoRoot, maxBuffer: SHOW_MAX_BUFFER }
            );
            return stdout;
        } catch (e: any) {
            console.log('[gitBranches] git show failed for', `${ref}:${filePath}`, e?.message ?? e);
            return ''; // file doesn't exist at this ref → empty side
        }
    }
}

function buildCommitFileUri(repoRoot: string, filePath: string, ref: string, hash: string): vscode.Uri {
    // Embed the relative path in the URI's path so VS Code picks up the right
    // language for syntax highlighting; ref/repo go in the query.
    const shortHash = ref === EMPTY_TREE_SHA ? '∅' : ref.substring(0, 8);
    const query = new URLSearchParams({ repo: repoRoot, path: filePath, ref }).toString();
    return vscode.Uri.from({
        scheme: COMMIT_FILE_SCHEME,
        path: '/' + filePath,
        query,
        fragment: `${shortHash}|${hash.substring(0, 8)}`,
    });
}

async function openRangeFileDiff(
    repo: Repository,
    leftRef: string,
    rightRef: string,
    status: string,
    path: string,
    oldPath?: string,
): Promise<void> {
    const leftPath  = (status === 'R' || status === 'C') ? (oldPath ?? path) : path;
    const rightPath = path;
    const repoRoot = repo.rootUri.fsPath;

    // Use rightRef as the "hash" for the URI fragment (it's only display metadata).
    const leftUri  = buildCommitFileUri(repoRoot, leftPath,  leftRef,  rightRef);
    const rightUri = buildCommitFileUri(repoRoot, rightPath, rightRef, rightRef);

    const shortL = leftRef === EMPTY_TREE_SHA ? '∅' : leftRef.substring(0, 8);
    const shortR = rightRef.substring(0, 8);
    const label = (status === 'R' || status === 'C') && oldPath
        ? `${oldPath} → ${path} (${shortL}..${shortR})`
        : `${path} (${shortL}..${shortR})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, label, { preview: true });
}

async function openCommitFileDiff(
    _gitApi: GitApi,
    repo: Repository,
    hash: string,
    parent: string | undefined,
    status: string,
    path: string,
    oldPath?: string,
): Promise<void> {
    const leftRef = parent && parent.length > 0 ? parent : EMPTY_TREE_SHA;
    // For a single-commit view we still want the title to read "(shortHash)" not "(∅..shortHash)",
    // so go through a dedicated label path here while reusing the URI builder.
    const leftPath  = (status === 'R' || status === 'C') ? (oldPath ?? path) : path;
    const rightPath = path;
    const repoRoot = repo.rootUri.fsPath;

    const leftUri  = buildCommitFileUri(repoRoot, leftPath,  leftRef, hash);
    const rightUri = buildCommitFileUri(repoRoot, rightPath, hash,    hash);

    const shortHash = hash.substring(0, 8);
    const label = (status === 'R' || status === 'C') && oldPath
        ? `${oldPath} → ${path} (${shortHash})`
        : `${path} (${shortHash})`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, label, { preview: true });
}

function renderCommitRows(commits: CommitData[], layouts: RowLayout[], svgWidth: number): string {
    return commits.map((c, i) => {
        const row = layouts[i];
        const parent = c.parents[0] ?? '';
        return `<tr class="commit-row" data-hash="${escapeHtml(c.hash)}" data-parent="${escapeHtml(parent)}" data-display="${escapeHtml(c.display)}" data-subject="${escapeHtml(c.subject)}" data-author="${escapeHtml(c.author)}">
  <td class="col-graph">${renderRowSvg(row, svgWidth)}</td>
  <td class="col-hash">${escapeHtml(c.display)}</td>
  <td class="col-refs"${c.refs.trim() ? ` title="${escapeHtml(c.refs)}"` : ''}><div class="refs-inner">${renderRefs(c.refs)}</div></td>
  <td class="col-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</td>
  <td class="col-date">${escapeHtml(c.date)}</td>
  <td class="col-author">${escapeHtml(c.author)}</td>
</tr>`;
    }).join('');
}

type GraphPos = 'left' | 'right' | 'off';
interface HistoryUiState {
    graphPos?: GraphPos;
    bottomFlex?: string; // CSS flex-basis value e.g. "240px"
}

const HISTORY_UI_STATE_KEY = 'gitBranches.historyUiState';
function readHistoryUiState(context: vscode.ExtensionContext): HistoryUiState {
    return context.workspaceState.get<HistoryUiState>(HISTORY_UI_STATE_KEY, {});
}
function writeHistoryUiState(context: vscode.ExtensionContext, patch: Partial<HistoryUiState>): Thenable<void> {
    const current = readHistoryUiState(context);
    return context.workspaceState.update(HISTORY_UI_STATE_KEY, { ...current, ...patch });
}

function buildHistoryHtml(
    commits: CommitData[], layouts: RowLayout[], ref: string, cspSource: string,
    svgWidth: number, hasMore: boolean, scope: string, branches: string[],
    allSentinel: string, ui: HistoryUiState, filePath?: string,
): string {
    const rows = renderCommitRows(commits, layouts, svgWidth);

    const csp = `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data:;`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; padding: 0;
    font-family: var(--vscode-editor-font-family, 'SF Mono', Menlo, Consolas, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column;
  }
  .top { flex: 1 1 60%; overflow: auto; min-height: 120px; }
  .splitter {
    flex: 0 0 5px; cursor: row-resize;
    background: var(--vscode-panel-border);
    user-select: none;
  }
  .splitter:hover { background: var(--vscode-focusBorder, #007fd4); }
  .bottom {
    flex: 0 0 40%; min-height: 80px; max-height: 80%;
    overflow: auto;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-top: 1px solid var(--vscode-panel-border);
  }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 6px 14px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 12px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.03em;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .control-group { display: inline-flex; align-items: center; gap: 8px; }
  .control-group-right { margin-left: auto; }
  .branch-select {
    background: var(--vscode-input-background, var(--vscode-editor-background));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    font-family: inherit; font-size: 12px; font-weight: 600;
    padding: 2px 6px;
    max-width: 360px;
    cursor: pointer;
  }
  .branch-select:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 0;
  }
  .history-search {
    background: var(--vscode-input-background, var(--vscode-editor-background));
    color: var(--vscode-input-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px;
    font-family: inherit; font-size: 12px; font-weight: 400;
    padding: 2px 8px;
    width: 240px; min-width: 120px;
    letter-spacing: 0;
  }
  .history-search:focus {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 0;
  }
  tr.commit-row.filtered-out { display: none; }

  /* Right-click context menu (custom — VS Code's webview default is minimal) */
  .ctx-menu {
    position: fixed; display: none; z-index: 100;
    min-width: 220px; padding: 4px 0;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0,0,0,.3);
    font-size: 12px;
    user-select: none;
  }
  .ctx-menu .item {
    padding: 4px 16px; cursor: pointer; white-space: nowrap;
  }
  .ctx-menu .item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
  }
  .ctx-menu .item.danger { color: var(--vscode-errorForeground, #cb2431); }
  .ctx-menu .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); }

  .toolbar-title { color: var(--vscode-descriptionForeground); }
  .toolbar-title > span { color: var(--vscode-foreground); }
  .control-label {
    color: var(--vscode-descriptionForeground);
    font-weight: 500; font-size: 11px;
    letter-spacing: 0.02em;
  }
  .pill-switch {
    display: inline-flex;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 999px;
    overflow: hidden;
    background: var(--vscode-editor-background);
  }
  .pill-switch button {
    background: transparent; color: var(--vscode-foreground);
    border: 0; border-left: 1px solid var(--vscode-panel-border);
    padding: 2px 14px; font-size: 11px; line-height: 18px; font-weight: 500;
    cursor: pointer; font-family: inherit; letter-spacing: 0;
  }
  .pill-switch button:first-child { border-left: 0; }
  .pill-switch button:hover:not(.active):not(:disabled) { background: var(--vscode-list-hoverBackground); }
  .pill-switch button.active {
    background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-button-foreground, var(--vscode-list-activeSelectionForeground));
    cursor: default;
  }
  .pill-switch button:disabled { opacity: 0.6; cursor: wait; }
  table { border-collapse: collapse; width: max-content; min-width: 100%; }
  thead th {
    position: sticky; top: 38px; z-index: 9;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    text-align: left; font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.06em; text-transform: uppercase;
    white-space: nowrap;
  }
  td { padding: 2px 10px; white-space: nowrap; vertical-align: middle; }
  tr.commit-row { cursor: pointer; }
  tr.commit-row:hover td { background: var(--vscode-list-hoverBackground); }
  tr.commit-row.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  tr.commit-row.selected-secondary td {
    background: var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-list-inactiveSelectionForeground, inherit);
    outline: 1px dashed var(--vscode-focusBorder, #007fd4);
    outline-offset: -1px;
  }
  /* Graph column: cap width so very-wide lane diagrams don't push subject/date off-screen;
     SVG inside scrolls horizontally if it exceeds the cap. */
  .col-graph {
    padding-left: 6px; padding-right: 4px;
    max-width: 200px; overflow-x: auto; overflow-y: hidden;
  }
  .col-graph::-webkit-scrollbar { height: 4px; }
  .col-graph::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,.3)); }
  #graph-th { max-width: 200px; }

  /* Graph "off" — column hidden entirely */
  table.graph-off .col-graph,
  table.graph-off #graph-th { display: none; }

  /* Graph "right" — push the graph cell to the end via flex/order trick.
     Implemented in JS by moving the <td>/<th> DOM nodes, no CSS needed. */
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

  .files-toolbar {
    position: sticky; top: 0; z-index: 5;
    padding: 6px 14px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    letter-spacing: 0.05em; text-transform: uppercase;
    display: flex; align-items: center; gap: 8px;
  }
  .files-toolbar .commit-info {
    text-transform: none; letter-spacing: 0;
    font-weight: normal; color: var(--vscode-foreground);
  }
  .files-toolbar .commit-info .hash { color: #e5c07b; font-weight: bold; margin-right: 6px; }
  .files-empty {
    padding: 14px; color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .file-row {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 14px; cursor: pointer;
    white-space: nowrap;
  }
  .file-row:hover { background: var(--vscode-list-hoverBackground); }
  .file-row .status {
    flex: 0 0 16px;
    text-align: center;
    font-weight: bold;
    font-size: 11px;
    border-radius: 3px;
    padding: 0 4px;
    line-height: 16px;
    color: #fff;
  }
  .file-row .status.A { background: #28a745; }
  .file-row .status.M { background: #d29922; }
  .file-row .status.D { background: #cb2431; }
  .file-row .status.R { background: #6f42c1; }
  .file-row .status.C { background: #6f42c1; }
  .file-row .status.T { background: #586069; }
  .file-row .path { overflow: hidden; text-overflow: ellipsis; }
  .file-row .dir  { color: var(--vscode-descriptionForeground); }
  .file-row .rename-from { color: var(--vscode-descriptionForeground); margin-right: 4px; }

  .load-more {
    padding: 10px 14px 24px;
    text-align: center;
  }
  .load-more button {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border);
    padding: 5px 18px;
    border-radius: 3px;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .load-more button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .load-more button:disabled {
    opacity: 0.5; cursor: default;
  }
  .load-more .end-marker {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
</style>
</head>
<body>
<div class="top">
  <div class="toolbar">
    <span class="toolbar-title">History ·</span>
    <select class="branch-select" id="branch-select" title="Choose which branch's history to show">
      ${(() => {
        // Top entry: the ref the user opened from (always shown, even if remote)
        const opts: string[] = [];
        const seen = new Set<string>();
        opts.push(`<option value="${escapeHtml(ref)}"${scope === ref ? ' selected' : ''}>${escapeHtml(ref)}</option>`);
        seen.add(ref);
        for (const b of branches) {
          if (seen.has(b)) { continue; }
          seen.add(b);
          opts.push(`<option value="${escapeHtml(b)}"${scope === b ? ' selected' : ''}>${escapeHtml(b)}</option>`);
        }
        opts.push(`<option value="${escapeHtml(allSentinel)}"${scope === allSentinel ? ' selected' : ''}>-- ALL --</option>`);
        return opts.join('\n      ');
      })()}
    </select>
    <input type="search" class="history-search" id="history-search" placeholder="Filter: subject / author / hash" autocomplete="off" spellcheck="false" />
    <div class="control-group control-group-right">
      <span class="control-label">Graph:</span>
      <div class="pill-switch" id="graph-switch">
        <button type="button" data-graph="left"${(ui.graphPos ?? 'left') === 'left' ? ' class="active"' : ''}>Left</button>
        <button type="button" data-graph="right"${ui.graphPos === 'right' ? ' class="active"' : ''}>Right</button>
        <button type="button" data-graph="off"${ui.graphPos === 'off' ? ' class="active"' : ''}>Off</button>
      </div>
    </div>
  </div>
  <table${ui.graphPos === 'off' ? ' class="graph-off"' : ''}>
    <thead>
      <tr>
        <th id="graph-th" style="min-width:${svgWidth + 16}px"></th>
        <th>Hash</th>
        <th>Refs</th>
        <th>Message</th>
        <th style="text-align:right;padding-right:14px">Date</th>
        <th>Author</th>
      </tr>
    </thead>
    <tbody id="commits">${rows}</tbody>
  </table>
  <div class="load-more" id="load-more">
    ${hasMore
      ? `<button id="load-more-btn">Load more (${commits.length} loaded)</button>`
      : `<span class="end-marker">— end of history (${commits.length} commits) —</span>`}
  </div>
</div>
<div class="splitter" id="splitter"></div>
<div class="bottom"${ui.bottomFlex ? ` style="flex-basis:${escapeHtml(ui.bottomFlex)};"` : ''}>
  <div class="files-toolbar">
    <span>Files Changed</span>
    <span class="commit-info" id="commit-info"></span>
  </div>
  <div id="files"><div class="files-empty">Select a commit to view its changed files.</div></div>
</div>

<div class="ctx-menu" id="commit-ctx-menu">
  <div class="item" data-action="copyHash">Copy hash</div>
  <div class="item" data-action="copyShortHash">Copy short hash</div>
  <div class="item" data-action="copySubject">Copy subject</div>
  <div class="sep"></div>
  <div class="item" data-action="checkout">Checkout this commit</div>
  <div class="item" data-action="createBranch">Create branch from here…</div>
  <div class="item" data-action="cherryPick">Cherry-pick</div>
  <div class="item" data-action="revert">Revert</div>
  <div class="sep"></div>
  <div class="item" data-action="resetSoft">Reset (soft) to here</div>
  <div class="item danger" data-action="resetHard">Reset (hard) to here</div>
  <div class="sep"></div>
  <div class="item" data-action="openInBrowser">Open commit in browser</div>
</div>

<div class="ctx-menu" id="file-ctx-menu">
  <div class="item" data-action="fileHistory">Show file history</div>
</div>

<script>
window.__initialGraphPos = ${JSON.stringify(ui.graphPos ?? 'left')};
</script>
<script>
(function () {
  const vscode = acquireVsCodeApi();
  const commitsEl = document.getElementById('commits');
  const filesEl = document.getElementById('files');
  const infoEl = document.getElementById('commit-info');
  let selectedRow = null;
  let currentHash = null;
  let currentParent = null;

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function splitPath(p) {
    const i = p.lastIndexOf('/');
    if (i === -1) { return { dir: '', name: p }; }
    return { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
  }

  function renderFiles(files) {
    if (!files.length) {
      filesEl.innerHTML = '<div class="files-empty">No files changed.</div>';
      return;
    }
    filesEl.innerHTML = files.map(f => {
      const sp = splitPath(f.path);
      const rename = (f.status === 'R' || f.status === 'C') && f.oldPath
        ? '<span class="rename-from">' + escapeHtml(f.oldPath) + ' →</span>'
        : '';
      return '<div class="file-row" data-path="' + escapeHtml(f.path) + '" data-old="' + escapeHtml(f.oldPath || '') + '" data-status="' + escapeHtml(f.status) + '">' +
        '<span class="status ' + escapeHtml(f.status) + '">' + escapeHtml(f.status) + '</span>' +
        rename +
        '<span class="path"><span class="dir">' + escapeHtml(sp.dir) + '</span>' + escapeHtml(sp.name) + '</span>' +
      '</div>';
    }).join('');
  }

  // Selection state — supports either single commit (vs its parent) or range (two commits).
  let secondaryRow = null;
  let rangeMode = false;
  let rangeFrom = null; // older hash (left side of diff)
  let rangeTo = null;   // newer hash (right side of diff)

  function clearSecondary() {
    if (secondaryRow) { secondaryRow.classList.remove('selected-secondary'); }
    secondaryRow = null;
    rangeMode = false;
    rangeFrom = null;
    rangeTo = null;
  }

  commitsEl.addEventListener('click', (e) => {
    const row = e.target.closest('tr.commit-row');
    if (!row) { return; }
    const modifier = e.metaKey || e.ctrlKey;

    if (modifier && selectedRow && row !== selectedRow) {
      // Range mode: keep primary, set secondary, compare the two.
      if (secondaryRow && secondaryRow !== row) { secondaryRow.classList.remove('selected-secondary'); }
      secondaryRow = row;
      row.classList.add('selected-secondary');
      rangeMode = true;

      // Determine older vs newer by DOM order (topo-order: lower index = newer).
      const rows = Array.from(commitsEl.querySelectorAll('tr.commit-row'));
      const primaryIdx = rows.indexOf(selectedRow);
      const secondaryIdx = rows.indexOf(secondaryRow);
      const newerRow = primaryIdx < secondaryIdx ? selectedRow : secondaryRow;
      const olderRow = primaryIdx < secondaryIdx ? secondaryRow : selectedRow;
      rangeFrom = olderRow.dataset.hash;
      rangeTo   = newerRow.dataset.hash;

      const shortFrom = (olderRow.dataset.display || rangeFrom.slice(0, 8));
      const shortTo   = (newerRow.dataset.display || rangeTo.slice(0, 8));
      infoEl.innerHTML =
        '<span class="hash">' + escapeHtml(shortFrom) + '..' + escapeHtml(shortTo) + '</span>' +
        'Range — diff between two commits';
      filesEl.innerHTML = '<div class="files-empty">Loading…</div>';
      vscode.postMessage({ type: 'selectRange', fromHash: rangeFrom, toHash: rangeTo });
      return;
    }

    // Plain click — clear any range, set single primary.
    clearSecondary();
    if (selectedRow) { selectedRow.classList.remove('selected'); }
    selectedRow = row;
    row.classList.add('selected');
    currentHash = row.dataset.hash;
    currentParent = row.dataset.parent || '';
    infoEl.innerHTML = '<span class="hash">' + escapeHtml(row.dataset.display) + '</span>' + escapeHtml(row.dataset.subject);
    filesEl.innerHTML = '<div class="files-empty">Loading…</div>';
    vscode.postMessage({ type: 'selectCommit', hash: currentHash, parent: currentParent });
  });

  filesEl.addEventListener('click', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) { return; }
    if (rangeMode && rangeFrom && rangeTo) {
      vscode.postMessage({
        type: 'openFile',
        fromHash: rangeFrom,
        toHash: rangeTo,
        status: row.dataset.status,
        path: row.dataset.path,
        oldPath: row.dataset.old || undefined,
      });
    } else if (currentHash) {
      vscode.postMessage({
        type: 'openFile',
        hash: currentHash,
        parent: currentParent,
        status: row.dataset.status,
        path: row.dataset.path,
        oldPath: row.dataset.old || undefined,
      });
    }
  });

  const loadMoreEl = document.getElementById('load-more');
  const graphTh = document.getElementById('graph-th');
  let loadedCount = commitsEl.querySelectorAll('tr.commit-row').length;

  function attachLoadMoreHandler() {
    const btn = document.getElementById('load-more-btn');
    if (!btn) { return; }
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      vscode.postMessage({ type: 'loadMore', skip: loadedCount });
    });
  }
  attachLoadMoreHandler();

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type === 'files' && m.hash === currentHash && !rangeMode) {
      if (m.error) {
        filesEl.innerHTML = '<div class="files-empty">' + escapeHtml(m.error) + '</div>';
      } else {
        renderFiles(m.files);
      }
    } else if (m?.type === 'rangeFiles' && rangeMode && m.fromHash === rangeFrom && m.toHash === rangeTo) {
      if (m.error) {
        filesEl.innerHTML = '<div class="files-empty">' + escapeHtml(m.error) + '</div>';
      } else {
        renderFiles(m.files);
      }
    } else if (m?.type === 'moreCommits') {
      // Append new rows
      const tmp = document.createElement('tbody');
      tmp.innerHTML = m.rowsHtml;
      while (tmp.firstChild) {
        commitsEl.appendChild(tmp.firstChild);
      }
      loadedCount += m.added;
      if (m.svgWidth && graphTh) {
        graphTh.style.minWidth = (m.svgWidth + 16) + 'px';
      }
      // Re-apply graph position so newly-appended rows match current setting
      applyGraphPosition(graphPos);
      applySearchFilter();
      // Replace load-more area content
      if (m.hasMore) {
        loadMoreEl.innerHTML = '<button id="load-more-btn">Load more (' + loadedCount + ' loaded)</button>';
        attachLoadMoreHandler();
      } else {
        loadMoreEl.innerHTML = '<span class="end-marker">— end of history (' + loadedCount + ' commits) —</span>';
      }
    } else if (m?.type === 'loadMoreError') {
      const btn = document.getElementById('load-more-btn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Load more — retry (error: ' + (m.error || 'unknown') + ')';
      }
      if (branchSelect) { branchSelect.disabled = false; }
    } else if (m?.type === 'resetCommits') {
      // Scope changed — replace all rows, reset selection & file panel
      commitsEl.innerHTML = m.rowsHtml;
      loadedCount = m.loadedCount;
      selectedRow = null;
      currentHash = null;
      currentParent = null;
      clearSecondary();
      infoEl.textContent = '';
      filesEl.innerHTML = '<div class="files-empty">Select a commit to view its changed files.</div>';
      if (m.svgWidth && graphTh) {
        graphTh.style.minWidth = (m.svgWidth + 16) + 'px';
      }
      // Sync dropdown to confirmed scope, re-enable it
      if (branchSelect) {
        if (branchSelect.value !== m.scope) { branchSelect.value = m.scope; }
        branchSelect.disabled = false;
      }
      // Reset load-more area
      if (m.hasMore) {
        loadMoreEl.innerHTML = '<button id="load-more-btn">Load more (' + loadedCount + ' loaded)</button>';
        attachLoadMoreHandler();
      } else {
        loadMoreEl.innerHTML = '<span class="end-marker">— end of history (' + loadedCount + ' commits) —</span>';
      }
      // Re-apply graph position for the freshly-rendered rows
      applyGraphPosition(graphPos);
      applySearchFilter();
      // Scroll to top of the table for the new scope
      const topPane = document.querySelector('.top');
      if (topPane) { topPane.scrollTop = 0; }
    }
  });

  // Branch dropdown — picks a local branch ref or the "-- ALL --" sentinel.
  const branchSelect = document.getElementById('branch-select');
  if (branchSelect) {
    branchSelect.addEventListener('change', () => {
      const newScope = branchSelect.value;
      branchSelect.disabled = true;
      vscode.postMessage({ type: 'setScope', scope: newScope });
    });
  }

  // Search box — client-side filter over already-loaded commits.
  const searchInput = document.getElementById('history-search');
  let searchQuery = '';
  function applySearchFilter(rows) {
    const q = searchQuery.trim().toLowerCase();
    const targets = rows || commitsEl.querySelectorAll('tr.commit-row');
    if (!q) {
      targets.forEach(tr => tr.classList.remove('filtered-out'));
      return;
    }
    targets.forEach(tr => {
      const hash    = (tr.dataset.hash    || '').toLowerCase();
      const display = (tr.dataset.display || '').toLowerCase();
      const subject = (tr.dataset.subject || '').toLowerCase();
      const author  = (tr.dataset.author  || '').toLowerCase();
      const match = hash.includes(q) || display.includes(q) || subject.includes(q) || author.includes(q);
      tr.classList.toggle('filtered-out', !match);
    });
  }
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value;
      applySearchFilter();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchInput.value = ''; searchQuery = ''; applySearchFilter(); }
    });
  }

  // Graph position switcher (left | right | off) — purely client-side DOM mutation.
  let graphPos = window.__initialGraphPos || 'left';
  function applyGraphPosition(pos) {
    graphPos = pos;
    const table = document.querySelector('.top table');
    if (!table) { return; }
    table.classList.toggle('graph-off', pos === 'off');

    const moveToLast = (pos === 'right');
    const moveCell = (row, cell) => {
      if (!cell) { return; }
      if (moveToLast && cell !== row.lastElementChild) {
        row.appendChild(cell);
      } else if (!moveToLast && cell !== row.firstElementChild) {
        row.insertBefore(cell, row.firstElementChild);
      }
    };

    // Header
    const theadRow = table.querySelector('thead tr');
    if (theadRow) { moveCell(theadRow, theadRow.querySelector('#graph-th')); }
    // Body rows
    commitsEl.querySelectorAll('tr.commit-row').forEach(tr => {
      moveCell(tr, tr.querySelector('.col-graph'));
    });

    // Update active button highlighting
    document.querySelectorAll('#graph-switch button').forEach(b => {
      b.classList.toggle('active', b.dataset.graph === pos);
    });
  }

  const graphSwitch = document.getElementById('graph-switch');
  if (graphSwitch) {
    graphSwitch.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-graph]');
      if (!btn || btn.classList.contains('active')) { return; }
      applyGraphPosition(btn.dataset.graph);
      vscode.postMessage({ type: 'saveUiState', patch: { graphPos: btn.dataset.graph } });
    });
  }

  // Right-click context menus (commit rows + file rows)
  const commitCtxMenu = document.getElementById('commit-ctx-menu');
  const fileCtxMenu = document.getElementById('file-ctx-menu');
  let ctxTarget = null; // { kind: 'commit'|'file', ... }

  function showCtxMenu(menu, x, y) {
    menu.style.display = 'block';
    // Position; clamp to viewport
    const w = menu.offsetWidth, h = menu.offsetHeight;
    const px = Math.min(x, window.innerWidth - w - 4);
    const py = Math.min(y, window.innerHeight - h - 4);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
  }
  function hideCtxMenus() {
    commitCtxMenu.style.display = 'none';
    fileCtxMenu.style.display = 'none';
    ctxTarget = null;
  }
  document.addEventListener('click', hideCtxMenus);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideCtxMenus(); } });
  window.addEventListener('blur', hideCtxMenus);

  commitsEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('tr.commit-row');
    if (!row) { return; }
    e.preventDefault();
    ctxTarget = {
      kind: 'commit',
      hash: row.dataset.hash,
      parent: row.dataset.parent || '',
      subject: row.dataset.subject || '',
      display: row.dataset.display || '',
    };
    showCtxMenu(commitCtxMenu, e.clientX, e.clientY);
  });

  commitCtxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item || !ctxTarget || ctxTarget.kind !== 'commit') { return; }
    vscode.postMessage({
      type: 'commitAction',
      action: item.dataset.action,
      hash: ctxTarget.hash,
      parent: ctxTarget.parent,
      subject: ctxTarget.subject,
    });
    hideCtxMenus();
  });

  filesEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.file-row');
    if (!row) { return; }
    e.preventDefault();
    ctxTarget = { kind: 'file', path: row.dataset.path };
    showCtxMenu(fileCtxMenu, e.clientX, e.clientY);
  });

  fileCtxMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item || !ctxTarget || ctxTarget.kind !== 'file') { return; }
    if (item.dataset.action === 'fileHistory') {
      vscode.postMessage({ type: 'openFileHistory', path: ctxTarget.path });
    }
    hideCtxMenus();
  });

  // Resizable splitter
  const splitter = document.getElementById('splitter');
  const topEl = document.querySelector('.top');
  const bottomEl = document.querySelector('.bottom');
  let dragging = false;
  splitter.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'row-resize'; });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false; document.body.style.cursor = '';
      // Persist final splitter position
      const flex = bottomEl.style.flexBasis;
      if (flex) { vscode.postMessage({ type: 'saveUiState', patch: { bottomFlex: flex } }); }
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) { return; }
    const total = window.innerHeight;
    const bottomH = Math.max(80, Math.min(total - 120, total - e.clientY));
    bottomEl.style.flexBasis = bottomH + 'px';
    topEl.style.flexBasis = (total - bottomH - 5) + 'px';
    e.preventDefault();
  });

})();
</script>
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

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(
            COMMIT_FILE_SCHEME,
            new CommitFileContentProvider()
        )
    );

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
        await openHistoryPanel(item.repo, item.ref.name ?? '', undefined);
    });

    async function openHistoryPanel(repo: Repository, fullRef: string, filePath?: string): Promise<void> {
        const PAGE_SIZE = 200;
        const SEP = '\x01';
        const ALL_SENTINEL = '__ALL__';

        async function listLocalBranches(): Promise<string[]> {
            try {
                const branches = await repo.getBranches({ remote: false });
                return branches.map(b => b.name).filter((n): n is string => !!n).sort();
            } catch {
                return [];
            }
        }

        async function fetchCommits(scope: string, skip: number, count: number): Promise<CommitData[]> {
            const args = [
                'log', '--topo-order',
                `--skip=${skip}`,
                `--max-count=${count}`,
                `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%D${SEP}%s${SEP}%cr${SEP}%an`,
            ];
            if (scope === ALL_SENTINEL) {
                args.push('--all');
            } else {
                args.push(scope);
            }
            if (filePath) { args.push('--', filePath); }
            const { stdout } = await execFileAsync(getGitPath(), args, { cwd: repo.rootUri.fsPath, maxBuffer: 64 * 1024 * 1024 });
            return stdout.trim().split('\n').filter(Boolean).map(line => {
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
        }

        const panel = vscode.window.createWebviewPanel(
            'gitBranchHistory',
            `History: ${fullRef}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        let layoutState = createLayoutState();
        let loadedCount = 0;
        let currentSvgWidth = LANE_W;
        let scope: string = fullRef;

        function bumpSvgWidth(layouts: RowLayout[]): void {
            const cols = Math.max(1, ...layouts.map(r => Math.max(r.topLanes.length, r.botLanes.length)));
            currentSvgWidth = Math.max(currentSvgWidth, cols * LANE_W);
        }

        try {
            const [first, branches] = await Promise.all([
                fetchCommits(scope, 0, PAGE_SIZE),
                listLocalBranches(),
            ]);
            const firstLayouts = computeLayout(first, layoutState);
            bumpSvgWidth(firstLayouts);
            loadedCount = first.length;
            const hasMore = first.length === PAGE_SIZE;

            const initialUi = readHistoryUiState(context);
            panel.webview.html = buildHistoryHtml(
                first, firstLayouts, fullRef, panel.webview.cspSource,
                currentSvgWidth, hasMore, scope, branches, ALL_SENTINEL, initialUi
            );

            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg?.type === 'selectCommit') {
                    try {
                        const files = await getChangedFiles(repo, msg.hash, msg.parent);
                        panel.webview.postMessage({ type: 'files', hash: msg.hash, files });
                    } catch (e: any) {
                        panel.webview.postMessage({ type: 'files', hash: msg.hash, files: [], error: String(e.stderr ?? e.message ?? e).trim() });
                    }
                } else if (msg?.type === 'selectRange') {
                    try {
                        const files = await getChangedFilesBetween(repo, msg.fromHash, msg.toHash);
                        panel.webview.postMessage({ type: 'rangeFiles', fromHash: msg.fromHash, toHash: msg.toHash, files });
                    } catch (e: any) {
                        panel.webview.postMessage({ type: 'rangeFiles', fromHash: msg.fromHash, toHash: msg.toHash, files: [], error: String(e.stderr ?? e.message ?? e).trim() });
                    }
                } else if (msg?.type === 'openFile') {
                    if (msg.fromHash && msg.toHash) {
                        await openRangeFileDiff(repo, msg.fromHash, msg.toHash, msg.status, msg.path, msg.oldPath);
                    } else {
                        await openCommitFileDiff(gitApi, repo, msg.hash, msg.parent, msg.status, msg.path, msg.oldPath);
                    }
                } else if (msg?.type === 'loadMore') {
                    try {
                        const next = await fetchCommits(scope, loadedCount, PAGE_SIZE);
                        const nextLayouts = computeLayout(next, layoutState);
                        bumpSvgWidth(nextLayouts);
                        loadedCount += next.length;
                        panel.webview.postMessage({
                            type: 'moreCommits',
                            rowsHtml: renderCommitRows(next, nextLayouts, currentSvgWidth),
                            svgWidth: currentSvgWidth,
                            added: next.length,
                            hasMore: next.length === PAGE_SIZE,
                        });
                    } catch (e: any) {
                        panel.webview.postMessage({
                            type: 'loadMoreError',
                            error: String(e.stderr ?? e.message ?? e).trim(),
                        });
                    }
                } else if (msg?.type === 'setScope') {
                    const newScope = String(msg.scope ?? '');
                    if (!newScope || newScope === scope) { return; }
                    try {
                        scope = newScope;
                        layoutState = createLayoutState();
                        currentSvgWidth = LANE_W;
                        loadedCount = 0;
                        const page = await fetchCommits(scope, 0, PAGE_SIZE);
                        const pageLayouts = computeLayout(page, layoutState);
                        bumpSvgWidth(pageLayouts);
                        loadedCount = page.length;
                        panel.webview.postMessage({
                            type: 'resetCommits',
                            scope,
                            rowsHtml: renderCommitRows(page, pageLayouts, currentSvgWidth),
                            svgWidth: currentSvgWidth,
                            loadedCount,
                            hasMore: page.length === PAGE_SIZE,
                        });
                    } catch (e: any) {
                        panel.webview.postMessage({
                            type: 'loadMoreError',
                            error: String(e.stderr ?? e.message ?? e).trim(),
                        });
                    }
                } else if (msg?.type === 'saveUiState') {
                    const patch = msg.patch ?? {};
                    const sanitized: Partial<HistoryUiState> = {};
                    if (patch.graphPos === 'left' || patch.graphPos === 'right' || patch.graphPos === 'off') {
                        sanitized.graphPos = patch.graphPos;
                    }
                    if (typeof patch.bottomFlex === 'string') {
                        sanitized.bottomFlex = patch.bottomFlex;
                    }
                    if (Object.keys(sanitized).length > 0) {
                        await writeHistoryUiState(context, sanitized);
                    }
                } else if (msg?.type === 'openFileHistory') {
                    // Recursively open a new panel scoped to a single file.
                    const ref = (scope === ALL_SENTINEL ? fullRef : scope) || fullRef;
                    const fp = msg.filePath ?? msg.path;
                    if (fp) { await openHistoryPanel(repo, ref, String(fp)); }
                } else if (msg?.type === 'commitAction') {
                    await handleCommitAction(repo, msg);
                }
            }, undefined, context.subscriptions);
        } catch (e: any) {
            vscode.window.showErrorMessage(String(e.stderr ?? e.message ?? e).trim());
            panel.dispose();
        }
    }

    async function handleCommitAction(repo: Repository, msg: any): Promise<void> {
        const hash = String(msg.hash ?? '');
        if (!hash) { return; }
        const shortHash = hash.substring(0, 8);
        const subject = String(msg.subject ?? '');

        switch (msg.action) {
            case 'copyHash':
                await vscode.env.clipboard.writeText(hash);
                vscode.window.showInformationMessage(`Copied: ${hash}`);
                return;
            case 'copyShortHash':
                await vscode.env.clipboard.writeText(shortHash);
                vscode.window.showInformationMessage(`Copied: ${shortHash}`);
                return;
            case 'copySubject':
                await vscode.env.clipboard.writeText(subject);
                vscode.window.showInformationMessage('Copied commit subject.');
                return;
            case 'checkout': {
                const ok = await confirm(`Checkout ${shortHash}? This puts the repo in detached HEAD.`, 'Checkout');
                if (!ok) { return; }
                await withProgress(`Checking out ${shortHash}...`, () => repo.checkout(hash));
                return;
            }
            case 'createBranch': {
                const name = await vscode.window.showInputBox({
                    prompt: `New branch name (from ${shortHash})`,
                    validateInput: v => v.trim() ? undefined : 'Branch name cannot be empty',
                });
                if (!name) { return; }
                await withProgress(`Creating branch ${name.trim()}...`, () => repo.createBranch(name.trim(), true, hash));
                return;
            }
            case 'cherryPick': {
                const ok = await confirm(`Cherry-pick ${shortHash} onto current branch?`, 'Cherry-pick');
                if (!ok) { return; }
                await withProgress(`Cherry-picking ${shortHash}...`, () => runGit(repo, ['cherry-pick', hash]));
                return;
            }
            case 'revert': {
                const ok = await confirm(`Revert ${shortHash}? This creates a new commit that undoes it.`, 'Revert');
                if (!ok) { return; }
                await withProgress(`Reverting ${shortHash}...`, () => runGit(repo, ['revert', '--no-edit', hash]));
                return;
            }
            case 'resetSoft': {
                const ok = await confirm(`Reset --soft to ${shortHash}? Your working tree and index are kept.`, 'Reset Soft');
                if (!ok) { return; }
                await withProgress(`Resetting (soft) to ${shortHash}...`, () => runGit(repo, ['reset', '--soft', hash]));
                return;
            }
            case 'resetHard': {
                const ok = await confirm(`Reset --hard to ${shortHash}? ⚠ Discards ALL uncommitted changes.`, 'Reset Hard');
                if (!ok) { return; }
                await withProgress(`Resetting (hard) to ${shortHash}...`, () => runGit(repo, ['reset', '--hard', hash]));
                return;
            }
            case 'openInBrowser': {
                const url = await transformRemoteToWebCommitUrl(repo, hash);
                if (!url) {
                    vscode.window.showInformationMessage('No web URL could be derived from this repo’s remote.');
                    return;
                }
                await vscode.env.openExternal(vscode.Uri.parse(url));
                return;
            }
        }
    }

    async function transformRemoteToWebCommitUrl(repo: Repository, hash: string): Promise<string | undefined> {
        try {
            const remoteName = repo.state.remotes.find(r => r.name === 'origin')?.name ?? repo.state.remotes[0]?.name;
            if (!remoteName) { return undefined; }
            const { stdout } = await execFileAsync(getGitPath(), ['remote', 'get-url', remoteName], { cwd: repo.rootUri.fsPath });
            let url = stdout.trim();
            const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
            if (sshMatch) {
                url = `https://${sshMatch[1]}/${sshMatch[2]}`;
            } else if (url.startsWith('ssh://')) {
                url = url.replace(/^ssh:\/\/(?:[^@]+@)?/, 'https://');
            }
            if (url.endsWith('.git')) { url = url.slice(0, -4); }
            if (/bitbucket\.org/.test(url)) { return `${url}/commits/${hash}`; }
            return `${url}/commit/${hash}`;
        } catch {
            return undefined;
        }
    }

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
