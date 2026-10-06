import * as vscode from 'vscode';
import { resolveTestCommand } from '../execution/commandResolver';
import { executeTest } from '../execution/processExecutor';
import { discoverProject } from '../projectDiscovery';
import ts from 'typescript';

export async function runTest(resource?: vscode.Uri, atCursor = false): Promise<void> {
  const selected = resource ?? vscode.window.activeTextEditor?.document.uri;
  if (!selected) throw new Error('Abra um arquivo de teste ou de produção.');
  const folder = vscode.workspace.getWorkspaceFolder(selected);
  if (!folder) throw new Error('O arquivo deve pertencer ao workspace.');
  const spec = /\.(?:spec|test)\.ts$/i.test(selected.fsPath) ? selected : vscode.Uri.file(selected.fsPath.replace(/\.ts$/i, '.spec.ts'));
  try { await vscode.workspace.fs.stat(spec); } catch { throw new Error('O arquivo de teste correspondente não existe.'); }
  const diagnostic = await discoverProject(folder); const active = diagnostic.testing.activeFramework;
  if (!active) throw new Error('O framework/runner ativo não pôde ser determinado com segurança.');
  const testName = atCursor && vscode.window.activeTextEditor?.document.uri.fsPath === spec.fsPath ? findTestAtCursor(vscode.window.activeTextEditor) : undefined;
  const command = resolveTestCommand(folder.uri.fsPath, active.runner, spec.fsPath, testName);
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SpecForge: running test', cancellable: false }, () => executeTest(command, folder.uri.fsPath));
  const document = await vscode.workspace.openTextDocument({ language: 'log', content: `SpecForge Test Result\nStatus: ${result.success ? 'PASS' : 'FAILED'}\nCommand: ${result.command}\nDuration: ${result.duration}ms\nPassed: ${result.passed}\nFailed: ${result.failed}\nSkipped: ${result.skipped}\n\n${result.output}` });
  await vscode.window.showTextDocument(document, { preview: true });
}

function findTestAtCursor(editor: vscode.TextEditor): string | undefined {
  const source = ts.createSourceFile(editor.document.fileName, editor.document.getText(), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const offset = editor.document.offsetAt(editor.selection.active); let found: { name: string; width: number } | undefined;
  const visit = (node: ts.Node): void => {
    if (node.pos <= offset && offset <= node.end && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['it', 'test'].includes(node.expression.text)) {
      const title = node.arguments[0];
      if (title && ts.isStringLiteralLike(title) && (!found || node.end - node.pos < found.width)) found = { name: title.text, width: node.end - node.pos };
    }
    ts.forEachChild(node, visit);
  };
  visit(source); return found?.name;
}
