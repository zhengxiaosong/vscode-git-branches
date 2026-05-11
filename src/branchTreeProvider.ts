import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Branch, GitApi, Ref, Repository } from './gitApi';

const execFileAsync = promisify(execFile);

function getGitPath(): string {
    return vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
}

// ---- Tree node types ----

type TagSyncStatus = 'synced' | 'unpublished' | 'conflict';

export class BranchItem extends vscode.TreeItem {
    constructor(
        public readonly ref: Ref,
        public readonly repo: Repository,
        itemContextValue: 'localBranch' | 'remoteBranch' | 'tag',
        displayLabel?: string,
        tagSyncStatus?: TagSyncStatus,
    ) {
        const label = displayLabel ?? ref.name ?? '(unknown)';
        super(label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = ref.commit ? `${ref.name} @ ${ref.commit.substring(0, 8)}` : (ref.name ?? label);

        const isHead = itemContextValue === 'localBranch' && repo.state.HEAD?.name === ref.name;
        this.contextValue = isHead ? 'localBranchCurrent' : itemContextValue;

        // Build ahead/behind indicator for local branches that have an upstream
        let syncDesc = '';
        if (itemContextValue === 'localBranch') {
            const branch = ref as Branch;
            const ahead  = branch.ahead  ?? 0;
            const behind = branch.behind ?? 0;
            if (ahead > 0 && behind > 0) { syncDesc = `↑${ahead} ↓${behind}`; }
            else if (ahead > 0)          { syncDesc = `↑${ahead}`; }
            else if (behind > 0)         { syncDesc = `↓${behind}`; }
        }

        if (isHead) {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
            this.description = syncDesc ? `current ${syncDesc}` : 'current';
        } else if (itemContextValue === 'tag') {
            if (tagSyncStatus === 'unpublished') {
                this.iconPath = new vscode.ThemeIcon('tag', new vscode.ThemeColor('charts.yellow'));
                this.description = '↑ not pushed';
                this.tooltip = `${ref.name} — local only, not pushed to remote`;
            } else if (tagSyncStatus === 'conflict') {
                this.iconPath = new vscode.ThemeIcon('tag', new vscode.ThemeColor('errorForeground'));
                this.description = '⚠ conflict';
                this.tooltip = `${ref.name} — conflicts with remote (different commits)`;
            } else {
                this.iconPath = new vscode.ThemeIcon('tag');
            }
        } else {
            this.iconPath = new vscode.ThemeIcon('git-branch');
            if (syncDesc) { this.description = syncDesc; }
        }
    }
}

export class LocalGroupItem extends vscode.TreeItem {
    constructor(public readonly repo: Repository) {
        super('Local', vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'localGroup';
        this.iconPath = new vscode.ThemeIcon('folder-opened');
    }
}

export class RemoteSectionItem extends vscode.TreeItem {
    constructor(public readonly repo: Repository) {
        super('Remote', vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'remoteSection';
        this.iconPath = new vscode.ThemeIcon('folder-opened');
    }
}

export class RemoteGroupItem extends vscode.TreeItem {
    constructor(
        public readonly remoteName: string,
        public readonly repo: Repository,
    ) {
        super(remoteName, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('cloud');
        this.contextValue = 'remoteGroup';
    }
}

export class RepoItem extends vscode.TreeItem {
    constructor(public readonly repo: Repository) {
        const name = repo.rootUri.path.split('/').pop() ?? repo.rootUri.path;
        super(name, vscode.TreeItemCollapsibleState.Expanded);
        this.iconPath = new vscode.ThemeIcon('repo');
        this.contextValue = 'repository';
    }
}

type TreeNode = BranchItem | LocalGroupItem | RemoteSectionItem | RemoteGroupItem | RepoItem;

// ---- Hidden-repos store (per-workspace) ----

export class HiddenRepos {
    private static readonly KEY = 'gitBranches.hiddenRepos';
    private hidden: Set<string>;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private memento: vscode.Memento) {
        this.hidden = new Set(memento.get<string[]>(HiddenRepos.KEY, []));
    }

    isHidden(repo: Repository): boolean { return this.hidden.has(repo.rootUri.fsPath); }
    hasAny(): boolean { return this.hidden.size > 0; }
    paths(): string[] { return [...this.hidden]; }

    async hide(repo: Repository): Promise<void> {
        this.hidden.add(repo.rootUri.fsPath);
        await this.persist();
    }

    async show(fsPath: string): Promise<void> {
        this.hidden.delete(fsPath);
        await this.persist();
    }

    private async persist(): Promise<void> {
        await this.memento.update(HiddenRepos.KEY, [...this.hidden]);
        this._onDidChange.fire();
    }
}

// ---- Abstract base with repo lifecycle ----

abstract class AbstractProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    invalidate(): void { this._onDidChangeTreeData.fire(); }

    // Used by subclasses to trigger a re-render without recursively triggering their invalidate logic
    protected fireChange(): void { this._onDidChangeTreeData.fire(); }

    protected visibleRepos(): Repository[] {
        return this.gitApi.repositories.filter(r => !this.hidden.isHidden(r));
    }

    private repoListeners = new Map<Repository, vscode.Disposable>();
    private subscriptions: vscode.Disposable[] = [];

    constructor(protected gitApi: GitApi, protected hidden: HiddenRepos) {
        this.subscriptions.push(
            gitApi.onDidOpenRepository(repo => this.attachRepo(repo)),
            gitApi.onDidCloseRepository(repo => this.detachRepo(repo)),
            hidden.onDidChange(() => this._onDidChangeTreeData.fire()),
        );
        for (const repo of gitApi.repositories) {
            this.attachRepo(repo);
        }
    }

    private attachRepo(repo: Repository): void {
        let debounce: ReturnType<typeof setTimeout> | undefined;
        const d = repo.state.onDidChange(() => {
            clearTimeout(debounce);
            debounce = setTimeout(() => this._onDidChangeTreeData.fire(), 50);
        });
        this.repoListeners.set(repo, d);
        this._onDidChangeTreeData.fire();
    }

    private detachRepo(repo: Repository): void {
        this.repoListeners.get(repo)?.dispose();
        this.repoListeners.delete(repo);
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.repoListeners.forEach(d => d.dispose());
        this._onDidChangeTreeData.dispose();
        this.subscriptions.forEach(d => d.dispose());
    }

    getTreeItem(element: TreeNode): vscode.TreeItem { return element; }

    abstract getChildren(element?: TreeNode): Promise<TreeNode[]>;
}

// ---- Merged Branches provider (Local + Remote) ----

export class BranchesProvider extends AbstractProvider {
    private remoteCache = new Map<Repository, Ref[]>();

    override invalidate(): void {
        this.remoteCache.clear();
        super.invalidate();
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        const repos = this.visibleRepos();

        if (!element) {
            if (repos.length === 0) { return []; }
            if (repos.length === 1) { return this.getRepoChildren(repos[0]); }
            return repos.map(r => new RepoItem(r));
        }
        if (element instanceof RepoItem) {
            return this.getRepoChildren(element.repo);
        }
        if (element instanceof LocalGroupItem) {
            return this.getLocalBranches(element.repo);
        }
        if (element instanceof RemoteSectionItem) {
            return this.getRemoteGroups(element.repo);
        }
        if (element instanceof RemoteGroupItem) {
            return this.getRemoteBranches(element.repo, element.remoteName);
        }
        return [];
    }

    private getRepoChildren(repo: Repository): TreeNode[] {
        return [new LocalGroupItem(repo), new RemoteSectionItem(repo)];
    }

    private async getLocalBranches(repo: Repository): Promise<BranchItem[]> {
        const head = repo.state.HEAD;
        const headName = head?.name;
        const branches = await repo.getBranches({ remote: false });
        return branches
            .sort((a, b) => {
                if (a.name === headName) { return -1; }
                if (b.name === headName) { return 1; }
                return (a.name ?? '').localeCompare(b.name ?? '');
            })
            .map(r => {
                // repo.state.HEAD has reliable ahead/behind (used by the status bar);
                // getBranches() may return undefined for these fields on the HEAD branch.
                if (r.name === headName && head) {
                    const enriched: Branch = { ...r, ahead: head.ahead, behind: head.behind };
                    return new BranchItem(enriched, repo, 'localBranch');
                }
                return new BranchItem(r, repo, 'localBranch');
            });
    }

    private async getRemoteGroups(repo: Repository): Promise<RemoteGroupItem[]> {
        const branches = await repo.getBranches({ remote: true });
        const knownRemotes = repo.state.remotes.map(r => r.name);

        // Only keep branches attributable to a known remote — prevents branch name
        // prefixes (e.g. "feature/") from being misidentified as phantom remotes.
        const filtered = branches.filter(b => {
            if (isHeadRef(b)) { return false; }
            if (b.remote) { return true; }
            return knownRemotes.some(r => (b.name ?? '').startsWith(r + '/'));
        });
        this.remoteCache.set(repo, filtered);

        const seen = new Set<string>();
        for (const b of filtered) {
            const remote = b.remote ?? knownRemotes.find(r => (b.name ?? '').startsWith(r + '/'));
            if (remote) { seen.add(remote); }
        }
        return knownRemotes
            .filter(r => seen.has(r))
            .map(name => new RemoteGroupItem(name, repo));
    }

    private async getRemoteBranches(repo: Repository, remoteName: string): Promise<BranchItem[]> {
        const cached = this.remoteCache.get(repo)
            ?? (await repo.getBranches({ remote: true })).filter(b => !isHeadRef(b));
        return cached
            .filter(b => {
                if (b.remote) { return b.remote === remoteName; }
                return (b.name ?? '').startsWith(remoteName + '/');
            })
            .sort((a, b) => shortName(a, remoteName).localeCompare(shortName(b, remoteName)))
            .map(b => new BranchItem(b, repo, 'remoteBranch', shortName(b, remoteName)));
    }
}

// ---- Tags provider with remote sync status ----

type RemoteSyncData = {
    // tag name → peeled commit hash (annotated tags resolve to their underlying commit)
    localCommits: Map<string, string>;
    // null = ls-remote failed (no network / no remote); key missing = tag not on remote
    remoteCommits: Map<string, string> | null;
};

export class TagProvider extends AbstractProvider {
    private syncCache = new Map<Repository, RemoteSyncData>();
    private fetching = new Set<Repository>();

    override invalidate(): void {
        this.syncCache.clear();
        super.invalidate();
        // Kick off background sync-status refresh; fireChange() re-renders when done
        for (const repo of this.visibleRepos()) {
            this.refreshTagSync(repo);
        }
    }

    private async refreshTagSync(repo: Repository): Promise<void> {
        if (this.fetching.has(repo)) { return; }
        this.fetching.add(repo);
        try {
            // Resolve local tag → peeled commit. %(*objectname) is the dereferenced commit for
            // annotated tags (empty for lightweight tags); %(objectname) is the tag object itself.
            const localCommits = new Map<string, string>();
            try {
                const { stdout } = await execFileAsync(
                    getGitPath(),
                    ['for-each-ref', '--format=%(refname:short)|%(*objectname)|%(objectname)', 'refs/tags/'],
                    { cwd: repo.rootUri.fsPath }
                );
                for (const line of stdout.trim().split('\n').filter(Boolean)) {
                    const [name, peeled, obj] = line.split('|');
                    localCommits.set(name, peeled || obj); // peeled wins for annotated tags
                }
            } catch { /* no tags or git unavailable */ }

            // Fetch remote tag commits via ls-remote (network call; may fail).
            let remoteCommits: Map<string, string> | null = null;
            const remoteName = repo.state.remotes[0]?.name;
            if (remoteName) {
                try {
                    const { stdout } = await execFileAsync(
                        getGitPath(),
                        ['ls-remote', '--tags', remoteName],
                        { cwd: repo.rootUri.fsPath }
                    );
                    remoteCommits = new Map<string, string>();
                    for (const line of stdout.trim().split('\n').filter(Boolean)) {
                        const [commit, ref] = line.split('\t');
                        if (!ref) { continue; }
                        if (ref.endsWith('^{}')) {
                            // Peeled annotated tag — use as the authoritative commit
                            remoteCommits.set(ref.slice('refs/tags/'.length, -3), commit);
                        } else {
                            const name = ref.slice('refs/tags/'.length);
                            if (!remoteCommits.has(name)) { remoteCommits.set(name, commit); }
                        }
                    }
                } catch { /* network unavailable — remoteCommits stays null */ }
            }

            this.syncCache.set(repo, { localCommits, remoteCommits });
            this.fireChange(); // re-render with sync status, without re-triggering invalidate
        } finally {
            this.fetching.delete(repo);
        }
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        const repos = this.visibleRepos();
        if (!element) {
            if (repos.length === 0) { return []; }
            if (repos.length === 1) { return this.getTagsForRepo(repos[0]); }
            return repos.map(r => new RepoItem(r));
        }
        if (element instanceof RepoItem) {
            return this.getTagsForRepo(element.repo);
        }
        return [];
    }

    private async getTagsForRepo(repo: Repository): Promise<BranchItem[]> {
        const refs = await repo.getRefs({ pattern: 'refs/tags/*' });
        const sync = this.syncCache.get(repo);

        return refs
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
            .map(r => {
                let syncStatus: TagSyncStatus | undefined;
                if (sync) {
                    const localCommit  = sync.localCommits.get(r.name ?? '');
                    const remoteCommit = sync.remoteCommits?.get(r.name ?? '');

                    if (sync.remoteCommits === null) {
                        syncStatus = undefined; // remote unreachable — no indicator
                    } else if (remoteCommit === undefined) {
                        syncStatus = 'unpublished';
                    } else if (localCommit === remoteCommit) {
                        syncStatus = 'synced';
                    } else {
                        syncStatus = 'conflict';
                    }
                }
                return new BranchItem(r, repo, 'tag', undefined, syncStatus);
            });
    }
}

// ---- Helpers ----

function isHeadRef(ref: Ref): boolean {
    const name = ref.name ?? '';
    return name === 'HEAD' || name.endsWith('/HEAD');
}

function shortName(ref: Ref, remoteName: string): string {
    const name = ref.name ?? '';
    return name.startsWith(remoteName + '/') ? name.slice(remoteName.length + 1) : name;
}
