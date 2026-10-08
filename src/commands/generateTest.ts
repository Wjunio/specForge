import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeSource } from '../analysis/sourceAnalyzer';
import { analyzeAngularTemplate, componentTemplateReference } from '../analysis/templateAnalyzer';
import { adapterFor } from '../testing/adapterRegistry';
import { executeTest } from '../execution/processExecutor';
import { resolveTestCommand } from '../execution/commandResolver';
import { readCoverageSummary } from '../execution/coverageReader';
import { discoverProject } from '../projectDiscovery';
import { EntityType, ProjectDiagnostic, TestFramework, TestRunner } from '../types';
import { repairGeneratedTest } from '../generation/repairPlanner';
import { augmentTestForCoverage } from '../generation/coverageFeedback';

export async function generateTest(resource?: vscode.Uri, requiredType?: EntityType): Promise<void> {
  const source = resolveSource(resource);
  const folder = vscode.workspace.getWorkspaceFolder(source);
  if (!folder) throw new Error('O arquivo deve pertencer ao workspace aberto.');
  const original = decode(await vscode.workspace.fs.readFile(source));
  const diagnostic = await selectFramework(await discoverProject(folder));
  const context = analyzeSource(source.fsPath, original, diagnostic);
  if (context.entityType === 'component' && vscode.workspace.getConfiguration('specForge').get<boolean>('analyzeTemplates', false)) {
    const reference = componentTemplateReference(source.fsPath, original);
    let template = reference.inline;
    let templateSource = source.fsPath;
    if (!template && reference.external) {
      assertInside(folder.uri.fsPath, reference.external);
      template = decode(await vscode.workspace.fs.readFile(vscode.Uri.file(reference.external)));
      templateSource = reference.external;
    }
    if (template !== undefined) context.templateUsage = await analyzeAngularTemplate(folder.uri.fsPath, template, templateSource);
  }
  if (requiredType && context.entityType !== requiredType) throw new Error(`O arquivo selecionado não é um ${requiredType}.`);
  const framework = diagnostic.testing.activeFramework;
  if (!framework) throw new Error('Selecione um framework de testes antes de gerar.');
  if (framework.runner === TestRunner.Unknown) throw new Error('O framework foi detectado, mas o runner ativo não. Nenhum arquivo foi criado.');
  const adapter = adapterFor(framework.framework);
  let generated = context.entityType === 'component' ? adapter.generateComponentTest(context) : adapter.generateServiceTest(context);
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
  const analyzeCoverage = vscode.workspace.getConfiguration('specForge').get<boolean>('analyzeCoverage', false);
  const command = resolveTestCommand(folder.uri.fsPath, framework.runner, spec.fsPath, undefined, { coverage: analyzeCoverage, sourceFile: source.fsPath });
  let result = await executeTest(command, folder.uri.fsPath);
  const maxRepairAttempts = vscode.workspace.getConfiguration('specForge').get<number>('maxRepairAttempts', 3);
  for (let attempt = 0; !result.success && attempt < maxRepairAttempts; attempt++) {
    const repair = repairGeneratedTest(generated, result.output, framework.framework);
    if (!repair) break;
    generated = repair.content;
    const document = await vscode.workspace.openTextDocument(spec);
    const repairEdit = new vscode.WorkspaceEdit();
    repairEdit.replace(spec, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), generated);
    if (!await vscode.workspace.applyEdit(repairEdit)) break;
    await document.save();
    result = await executeTest(command, folder.uri.fsPath);
  }
  const target = vscode.workspace.getConfiguration('specForge').get<number>('targetCoverage', 100);
  if (analyzeCoverage && result.success) {
    result.coverage = await readCoverageSummary(folder.uri.fsPath, source.fsPath);
    for (let attempt = 0; result.coverage && !meetsCoverage(result.coverage, target) && attempt < maxRepairAttempts; attempt++) {
      const feedback = augmentTestForCoverage(generated, context, result.coverage);
      if (!feedback) break;
      generated = feedback.content;
      if (!await replaceDocument(spec, generated)) break;
      result = await executeTest(command, folder.uri.fsPath);
      if (!result.success) break;
      result.coverage = await readCoverageSummary(folder.uri.fsPath, source.fsPath);
    }
  }
  const uncovered = result.coverage ? [
    result.coverage.uncoveredLines?.length ? `Uncovered lines: ${result.coverage.uncoveredLines.join(', ')}.` : '',
    result.coverage.uncoveredFunctions?.length ? `Uncovered functions: ${result.coverage.uncoveredFunctions.map(item => `${item.name}:${item.line}`).join(', ')}.` : '',
    result.coverage.uncoveredBranches?.length ? `Uncovered branches: ${result.coverage.uncoveredBranches.map(item => `${item.line}[${item.indexes.join(',')}]`).join(', ')}.` : ''
  ].filter(Boolean).join('\n') : '';
  const coverageOutput = result.coverage ? `\n\nCoverage for ${result.coverage.sourceFile}: statements ${result.coverage.statements}%, branches ${result.coverage.branches}%, functions ${result.coverage.functions}%, lines ${result.coverage.lines}%.${uncovered ? `\n${uncovered}` : ''}` : analyzeCoverage ? '\n\nCoverage summary was not produced by the runner.' : '';
  await showResult(result.success ? 'PASS' : 'FAILED', result.command, `${result.output}${coverageOutput}`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(spec));
  if (result.success && result.coverage) {
    if (![result.coverage.statements, result.coverage.branches, result.coverage.functions, result.coverage.lines].every(value => value >= target)) void vscode.window.showWarningMessage(`SpecForge: testes passaram, mas a cobertura ficou abaixo da meta de ${target}%.`);
  }
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
async function replaceDocument(uri: vscode.Uri, content: string): Promise<boolean> { const document = await vscode.workspace.openTextDocument(uri); const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content); const applied = await vscode.workspace.applyEdit(edit); if (applied) await document.save(); return applied; }
function meetsCoverage(coverage: NonNullable<import('../types').TestResult['coverage']>, target: number): boolean { return [coverage.statements, coverage.branches, coverage.functions, coverage.lines].every(value => value >= target); }
function decode(value: Uint8Array): string { return new TextDecoder().decode(value); }
async function showResult(status: string, command: string, output: string): Promise<void> { const document = await vscode.workspace.openTextDocument({ language: 'log', content: `SpecForge Test Result\nStatus: ${status}\nCommand: ${command}\n\n${output}` }); await vscode.window.showTextDocument(document, { preview: true }); }
