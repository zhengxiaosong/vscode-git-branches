import * as vscode from 'vscode';
import { GitApi, Ref, Repository } from './gitApi';

// ---- Tree node types ----

export class BranchItem extends vscode.TreeItem {
    constructor(
        public readonly ref: Ref,
        public readonly repo: Repository,
        itemContextValue: 'localBranch' | 'remoteBranch' | 'tag',
        displayLabel?: string,
    ) {
        const label = displayLabel ?? ref.name ?? '(unknown)';
        super(label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = ref.commit ? `${ref.name} @ ${ref.commit.substring(0, 8)}` : (ref.name ?? label);

        const isHead = itemContextValue === 'localBranch' && repo.state.HEAD?.name === ref.name;
        this.contextValue = isHead ? 'localBranchCurrent' : itemContextValue;

        if (isHead) {
            this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
            this.description = 'current';
        } else if (itemContextValue === 'tag') {
            this.iconPath = new vscode.ThemeIcon('tag');
        } else {
            this.iconPath = new vscode.ThemeIcon('git-branch');
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

// ---- Abstract base with repo lifecycle ----

abstract class AbstractProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
    readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private repoListeners = new Map<Repository, vscode.Disposable>();
    private subscriptions: vscode.Disposable[] = [];

    constructor(protected gitApi: GitApi) {
        this.subscriptions.push(
            gitApi.onDidOpenRepository(repo => this.attachRepo(repo)),
            gitApi.onDidCloseRepository(repo => this.detachRepo(repo)),
        );
        for (const repo of gitApi.repositories) {
            this.attachRepo(repo);
        }
    }

    private attachRepo(repo: Repository): void {
        const d = repo.state.onDidChange(() => this._onDidChangeTreeData.fire());
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

    clearCache(): void { this.remoteCache.clear(); }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        const repos = this.gitApi.repositories;

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
        const head = repo.state.HEAD?.name;
        const branches = await repo.getBranches({ remote: false });
        return branches
            .sort((a, b) => {
                if (a.name === head) { return -1; }
                if (b.name === head) { return 1; }
                return (a.name ?? '').localeCompare(b.name ?? '');
            })
            .map(r => new BranchItem(r, repo, 'localBranch'));
    }

    private async getRemoteGroups(repo: Repository): Promise<RemoteGroupItem[]> {
        const branches = await repo.getBranches({ remote: true });
        const filtered = branches.filter(b => !isHeadRef(b));
        this.remoteCache.set(repo, filtered);

        const remoteNames = repo.state.remotes.map(r => r.name);
        for (const b of filtered) {
            const r = inferRemote(b, remoteNames);
            if (r && !remoteNames.includes(r)) { remoteNames.push(r); }
        }
        return remoteNames
            .filter(name => filtered.some(b => inferRemote(b, remoteNames) === name))
            .map(name => new RemoteGroupItem(name, repo));
    }

    private async getRemoteBranches(repo: Repository, remoteName: string): Promise<BranchItem[]> {
        const cached = this.remoteCache.get(repo)
            ?? (await repo.getBranches({ remote: true })).filter(b => !isHeadRef(b));
        const allRemotes = repo.state.remotes.map(r => r.name);
        return cached
            .filter(b => inferRemote(b, allRemotes) === remoteName)
            .sort((a, b) => shortName(a, remoteName).localeCompare(shortName(b, remoteName)))
            .map(b => new BranchItem(b, repo, 'remoteBranch', shortName(b, remoteName)));
    }
}

// ---- Tags provider (unchanged) ----

export class TagProvider extends AbstractProvider {
    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        const repos = this.gitApi.repositories;
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
        return refs
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
            .map(r => new BranchItem(r, repo, 'tag'));
    }
}

// ---- Helpers ----

function isHeadRef(ref: Ref): boolean {
    const name = ref.name ?? '';
    return name === 'HEAD' || name.endsWith('/HEAD');
}

function inferRemote(ref: Ref, knownRemotes: string[]): string | undefined {
    if (ref.remote) { return ref.remote; }
    const name = ref.name ?? '';
    const sorted = [...knownRemotes].sort((a, b) => b.length - a.length);
    for (const r of sorted) {
        if (name.startsWith(r + '/') || name === r) { return r; }
    }
    const idx = name.indexOf('/');
    return idx !== -1 ? name.slice(0, idx) : undefined;
}

function shortName(ref: Ref, remoteName: string): string {
    const name = ref.name ?? '';
    return name.startsWith(remoteName + '/') ? name.slice(remoteName.length + 1) : name;
}
