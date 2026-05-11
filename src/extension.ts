import * as vscode from 'vscode';
import { getGitApi } from './gitApi';
import { BranchesProvider, HiddenRepos, TagProvider } from './branchTreeProvider';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    const gitApi = getGitApi();
    if (!gitApi) {
        vscode.window.showErrorMessage(
            'Git Branches: Could not access the built-in git extension. Ensure git is installed and the git extension is enabled.'
        );
        return;
    }

    const hiddenRepos = new HiddenRepos(context.workspaceState);
    const branchesProvider = new BranchesProvider(gitApi, hiddenRepos);
    const tagProvider = new TagProvider(gitApi, hiddenRepos);

    const branchesView = vscode.window.createTreeView('gitBranches.branches', {
        treeDataProvider: branchesProvider,
        showCollapseAll: false,
    });
    const tagView = vscode.window.createTreeView('gitBranches.tags', {
        treeDataProvider: tagProvider,
        showCollapseAll: false,
    });

    const refresh = async () => {
        await vscode.commands.executeCommand('git.refresh');
        // git.refresh is fire-and-forget internally; wait for the built-in extension
        // to finish updating its state before we re-query branches/refs.
        await new Promise(r => setTimeout(r, 500));
        branchesProvider.invalidate();
        tagProvider.invalidate();
    };

    registerCommands(context, gitApi, refresh, hiddenRepos);

    context.subscriptions.push(
        branchesView,
        tagView,
        branchesProvider,
        tagProvider,
    );
}

export function deactivate(): void {}
