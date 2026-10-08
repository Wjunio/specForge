import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { TemplateUsageInfo } from '../types';

export function componentTemplateReference(sourceFile: string, sourceCode: string): { inline?: string; external?: string } {
  const file = ts.createSourceFile(sourceFile, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(ts.isClassDeclaration);
  if (!declaration) return {};
  const decorator = (ts.getDecorators(declaration) ?? []).find(item => ts.isCallExpression(item.expression) && item.expression.expression.getText(file) === 'Component');
  if (!decorator || !ts.isCallExpression(decorator.expression)) return {};
  const metadata = decorator.expression.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return {};
  const value = (name: string): ts.Expression | undefined => {
    const property = metadata.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(file).replace(/['"]/g, '') === name);
    return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
  };
  const template = value('template'); const templateUrl = value('templateUrl');
  return { inline: template && ts.isStringLiteralLike(template) ? template.text : undefined, external: templateUrl && ts.isStringLiteralLike(templateUrl) ? path.resolve(path.dirname(sourceFile), templateUrl.text) : undefined };
}

export async function analyzeAngularTemplate(workspace: string, template: string, sourceUrl: string): Promise<TemplateUsageInfo> {
  const workspaceRequire = createRequire(path.join(workspace, 'package.json'));
  const compilerEntry = workspaceRequire.resolve('@angular/compiler');
  const compiler = await import(pathToFileURL(compilerEntry).href) as { parseTemplate(source: string, url: string): { nodes: unknown[]; errors?: unknown[] } };
  const parsed = compiler.parseTemplate(template, sourceUrl);
  if (parsed.errors?.length) throw new Error(`O template Angular contém ${parsed.errors.length} erro(s) de parsing.`);
  return inspectTemplateAst(parsed.nodes);
}

export function inspectTemplateAst(nodes: unknown[]): TemplateUsageInfo {
  const events = new Set<string>(); const invokedMethods = new Set<string>(); const inputs = new Set<string>(); const outputs = new Set<string>(); const formControls = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return; seen.add(value);
    const node = value as Record<string, unknown>; const kind = value.constructor?.name ?? '';
    if (kind === 'BoundEvent' && typeof node.name === 'string') { events.add(node.name); outputs.add(node.name); }
    if (kind === 'BoundAttribute' && typeof node.name === 'string') inputs.add(node.name);
    if (kind === 'TextAttribute' && node.name === 'formControlName' && typeof node.value === 'string') formControls.add(node.value);
    if (kind === 'Call') {
      const receiver = node.receiver as Record<string, unknown> | undefined;
      if (receiver?.constructor?.name === 'PropertyRead' && typeof receiver.name === 'string') invokedMethods.add(receiver.name);
    }
    for (const [key, child] of Object.entries(node)) {
      if (['sourceSpan', 'nameSpan', 'keySpan', 'valueSpan'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  nodes.forEach(visit);
  return { events: [...events].sort(), invokedMethods: [...invokedMethods].sort(), inputs: [...inputs].sort(), outputs: [...outputs].sort(), formControls: [...formControls].sort() };
}
