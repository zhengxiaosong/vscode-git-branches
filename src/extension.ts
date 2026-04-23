import * as vscode from 'vscode';
import { getGitApi } from './gitApi';
import { BranchesProvider, TagProvider } from './branchTreeProvider';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
    const gitApi = getGitApi();
    if (!gitApi) {
        vscode.window.showErrorMessage(
            'Git Branches: Could not access the built-in git extension. Ensure git is installed and the git extension is enabled.'
        );
        return;
    }

    const branchesProvider = new BranchesProvider(gitApi);
    const tagProvider = new TagProvider(gitApi);

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
        await new Promise(r => setTimeout(r, 500));
        branchesProvider.clearCache();
        branchesProvider._onDidChangeTreeData.fire();
        tagProvider._onDidChangeTreeData.fire();
    };

    registerCommands(context, gitApi, refresh);

    context.subscriptions.push(
        branchesView,
        tagView,
        branchesProvider,
        tagProvider,
    );
}

export function deactivate(): void {}
