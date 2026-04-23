import * as vscode from 'vscode';

export const enum RefType {
    Head = 0,
    RemoteHead = 1,
    Tag = 2,
}

export interface Ref {
    readonly type: RefType;
    readonly name?: string;
    readonly commit?: string;
    readonly remote?: string;
}

export interface Branch extends Ref {
    readonly upstream?: { name: string; remote: string };
    readonly ahead?: number;
    readonly behind?: number;
}

export interface Remote {
    readonly name: string;
    readonly fetchUrl?: string;
    readonly pushUrl?: string;
    readonly isReadOnly: boolean;
}

export interface RepositoryState {
    readonly HEAD?: Branch;
    readonly refs: Ref[];
    readonly remotes: Remote[];
    readonly onDidChange: vscode.Event<void>;
}

export interface Repository {
    readonly rootUri: vscode.Uri;
    readonly state: RepositoryState;
    checkout(treeish: string): Promise<void>;
    merge(ref: string): Promise<void>;
    deleteBranch(name: string, force?: boolean): Promise<void>;
    push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
    fetch(remote?: string, ref?: string, depth?: number): Promise<void>;
    pull(rebase?: boolean, remote?: string, refspec?: string, opts?: { tags?: boolean }): Promise<void>;
    createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
    getBranches(query: { remote?: boolean; pattern?: string }): Promise<Branch[]>;
    getRefs(query: { pattern?: string; contains?: string; count?: number }): Promise<Ref[]>;
    // Methods available via cast to any (exist in implementation but not official typed surface)
    // renameBranch(name: string, newName: string): Promise<void>
    // tag(name: string, upstream?: string, message?: string): Promise<void>
    // deleteTag(name: string): Promise<void>
    // setTrackingBranch(name: string, upstream: string): Promise<void>
}

export interface GitExtension {
    getAPI(version: 1): GitApi;
}

export interface GitApi {
    readonly repositories: Repository[];
    readonly onDidOpenRepository: vscode.Event<Repository>;
    readonly onDidCloseRepository: vscode.Event<Repository>;
}

export function getGitApi(): GitApi | undefined {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext?.isActive) {
        return undefined;
    }
    return ext.exports.getAPI(1);
}
