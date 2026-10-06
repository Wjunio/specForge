import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeSource } from '../analysis/sourceAnalyzer';
import { adapterFor } from '../testing/adapterRegistry';
import { executeTest } from '../execution/processExecutor';
import { resolveTestCommand } from '../execution/commandResolver';
import { discoverProject } from '../projectDiscovery';
import { EntityType, ProjectDiagnostic, TestFramework, TestRunner } from '../types';

export async function generateTest(resource?: vscode.Uri, requiredType?: EntityType): Promise<void> {
  const source = resolveSource(resource);
  const folder = vscode.workspace.getWorkspaceFolder(source);
  if (!folder) throw new Error('O arquivo deve pertencer ao workspace aberto.');
  const original = decode(await vscode.workspace.fs.readFile(source));
  const diagnostic = await selectFramework(await discoverProject(folder));
  const context = analyzeSource(source.fsPath, original, diagnostic);
  if (requiredType && context.entityType !== requiredType) throw new Error(`O arquivo selecionado não é um ${requiredType}.`);
  const framework = diagnostic.testing.activeFramework;
  if (!framework) throw new Error('Selecione um framework de testes antes de gerar.');
  if (framework.runner === TestRunner.Unknown) throw new Error('O framework foi detectado, mas o runner ativo não. Nenhum arquivo foi criado.');
  const adapter = adapterFor(framework.framework);
  const generated = context.entityType === 'component' ? adapter.generateComponentTest(context) : adapter.generateServiceTest(context);
  const spec = vscode.Uri.file(source.fsPath.replace(/\.ts$/i, vscode.workspace.getConfiguration('specForge').get('testFileSuffix', '.spec.ts')));
  assertInside(folder.uri.fsPath, spec.fsPath);
  const existing = await readOptional(spec);
  const preview = await vscode.workspace.openTextDocument({ language: 'typescript', content: generated });
  await vscode.window.showTextDocument(preview, { preview: true });
  const relative = vscode.workspace.asRelativePath(spec, false);
  if (existing !== undefined) {
    const overwrite = vscode.workspace.getConfiguration('specForge').get<boolean>('overwriteTests', false);
    if (!overwrite) throw new Error(`O teste ${relative} já existe e overwriteTests está desativado.`);
    const choice = await vscode.window.showWarningMessage(`Existing test detected. The following file will be replaced:\n${relative}`, { modal: true }, 'Replace test');
    if (choice !== 'Replace test') return;
  } else {
    const choice = await vscode.window.showInformationMessage(`SpecForge is about to create:\n${relative}`, { modal: true }, 'Create test');
    if (choice !== 'Create test') return;
  }
  const edit = new vscode.WorkspaceEdit();
  if (existing === undefined) edit.createFile(spec, { ignoreIfExists: false });
  else {
    const document = await vscode.workspace.openTextDocument(spec);
    edit.delete(spec, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)));
  }
  edit.insert(spec, new vscode.Position(0, 0), generated);
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('O VS Code recusou a gravação do arquivo de teste.');
  const sourceAfter = decode(await vscode.workspace.fs.readFile(source));
  if (sourceAfter !== original) throw new Error('A verificação de integridade detectou alteração inesperada no arquivo-fonte.');
  await vscode.workspace.saveAll(false);
  const command = resolveTestCommand(folder.uri.fsPath, framework.runner, spec.fsPath);
  const result = await executeTest(command, folder.uri.fsPath);
  await showResult(result.success ? 'PASS' : 'FAILED', result.command, result.output);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spec));
  if (result.success) void vscode.window.showInformationMessage(`SpecForge: PASS — ${relative} compilou, executou e passou.`);
  else void vscode.window.showErrorMessage(`SpecForge: o teste foi criado, mas não foi considerado concluído porque compilação ou execução falhou.`);
}

function resolveSource(resource?: vscode.Uri): vscode.Uri {
  const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || !/\.ts$/i.test(uri.fsPath) || /\.(?:spec|test)\.ts$/i.test(uri.fsPath)) throw new Error('Abra um Component ou Service TypeScript de produção.');
  return uri;
}
async function selectFramework(diagnostic: ProjectDiagnostic): Promise<ProjectDiagnostic> {
  const configured = vscode.workspace.getConfiguration('specForge').get<string>('framework', 'auto');
  if (configured !== 'auto') {
    const selected = diagnostic.testing.frameworks.find(item => item.framework === configured);
    if (!selected) throw new Error(`O framework configurado (${configured}) não foi detectado no projeto.`);
    return { ...diagnostic, testing: { ...diagnostic.testing, activeFramework: selected } };
  }
  if (diagnostic.testing.activeFramework) return diagnostic;
  if (!diagnostic.testing.frameworks.length) throw new Error('Nenhuma infraestrutura de testes foi detectada.');
  const selection = await vscode.window.showQuickPick(diagnostic.testing.frameworks.map(item => ({ label: frameworkLabel(item.framework), description: `${item.runner} · ${item.confidence}`, item })), { title: 'Detected multiple test configurations. Select the framework for this test.' });
  if (!selection) throw new Error('Geração cancelada: framework não selecionado.');
  return { ...diagnostic, testing: { ...diagnostic.testing, activeFramework: selection.item } };
}
function frameworkLabel(value: TestFramework): string { return value === TestFramework.Jasmine ? 'Jasmine' : value === TestFramework.Jest ? 'Jest' : 'Vitest'; }
function assertInside(root: string, file: string): void { const relative = path.relative(path.resolve(root), path.resolve(file)); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('O destino do teste está fora do workspace.'); }
async function readOptional(uri: vscode.Uri): Promise<string | undefined> { try { return decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; } }
function decode(value: Uint8Array): string { return new TextDecoder().decode(value); }
async function showResult(status: string, command: string, output: string): Promise<void> { const document = await vscode.workspace.openTextDocument({ language: 'log', content: `SpecForge Test Result\nStatus: ${status}\nCommand: ${command}\n\n${output}` }); await vscode.window.showTextDocument(document, { preview: true }); }
