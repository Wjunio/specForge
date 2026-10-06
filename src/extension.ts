import * as vscode from 'vscode';
import { generateTest } from './commands/generateTest';
import { runTest } from './commands/runTest';
import { formatDiagnostic } from './diagnosticFormatter';
import { discoverProject } from './projectDiscovery';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('specForge.projectTestConfiguration', (resource?: vscode.Uri) => guarded(() => showProjectConfiguration(resource))),
    vscode.commands.registerCommand('specForge.generateTest', (resource?: vscode.Uri) => guarded(() => generateTest(resource))),
    vscode.commands.registerCommand('specForge.generateComponentTest', (resource?: vscode.Uri) => guarded(() => generateTest(resource, 'component'))),
    vscode.commands.registerCommand('specForge.generateServiceTest', (resource?: vscode.Uri) => guarded(() => generateTest(resource, 'service'))),
    vscode.commands.registerCommand('specForge.runTest', (resource?: vscode.Uri) => guarded(() => runTest(resource))),
    vscode.commands.registerCommand('specForge.runTestFile', (resource?: vscode.Uri) => guarded(() => runTest(resource))),
    vscode.commands.registerCommand('specForge.runTestAtCursor', () => guarded(() => runTest(undefined, true)))
  );
}

async function showProjectConfiguration(resource?: vscode.Uri): Promise<void> {
  const folder = await selectWorkspace(resource);
  if (!folder) return;
  const diagnostic = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SpecForge: discovering project configuration', cancellable: false }, () => discoverProject(folder));
  const document = await vscode.workspace.openTextDocument({ language: 'yaml', content: formatDiagnostic(diagnostic) });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function selectWorkspace(resource?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  if (resource) return vscode.workspace.getWorkspaceFolder(resource);
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error('Nenhum workspace aberto.');
  if (folders.length === 1) return folders[0];
  const selected = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: 'Select the Angular workspace' });
  return selected?.folder;
}

async function guarded(action: () => Promise<void>): Promise<void> { try { await action(); } catch (error) { void vscode.window.showErrorMessage(`SpecForge: ${error instanceof Error ? error.message : String(error)}`); } }
export function deactivate(): void { /* Every test process is bounded and awaited by its command. */ }
