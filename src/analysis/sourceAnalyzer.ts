import ts from 'typescript';
import { DependencyInfo, EntityType, HttpUsageInfo, MethodInfo, PropertyInfo, TestGenerationContext, ProjectDiagnostic } from '../types';

export function analyzeSource(sourceFile: string, sourceCode: string, diagnostic: ProjectDiagnostic): TestGenerationContext {
  const file = ts.createSourceFile(sourceFile, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(ts.isClassDeclaration);
  if (!declaration?.name) throw new Error('Nenhuma classe nomeada foi encontrada.');
  const decorators = declaration.modifiers?.filter(ts.isDecorator) ?? [];
  const decorator = decorators.map(item => ts.isCallExpression(item.expression) ? item.expression : undefined).find(Boolean);
  const decoratorName = decorator?.expression.getText(file);
  const entityType: EntityType = decoratorName === 'Component' || /\.component\.ts$/i.test(sourceFile) ? 'component'
    : decoratorName === 'Injectable' || /\.service\.ts$/i.test(sourceFile) ? 'service'
      : (() => { throw new Error('A Fase 1 suporta somente Component e Service.'); })();
  const standalone = Boolean(decorator?.arguments[0] && ts.isObjectLiteralExpression(decorator.arguments[0]) && decorator.arguments[0].properties.some(property =>
    ts.isPropertyAssignment(property) && property.name.getText(file) === 'standalone' && property.initializer.kind === ts.SyntaxKind.TrueKeyword));
  const constructor = declaration.members.find(ts.isConstructorDeclaration);
  const imports = new Map<string, string>();
  for (const statement of file.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.name) imports.set(clause.name.text, statement.moduleSpecifier.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) imports.set(element.name.text, statement.moduleSpecifier.text);
  }
  const dependencies: DependencyInfo[] = (constructor?.parameters ?? []).map(parameter => ({
    name: ts.isIdentifier(parameter.name) ? parameter.name.text : 'dependency',
    type: parameter.type?.getText(file) ?? 'unknown',
    providerToken: injectedToken(parameter, file) ?? providerToken(parameter.type?.getText(file) ?? ''),
    importPath: imports.get(providerToken(parameter.type?.getText(file) ?? '')),
    optional: hasDecorator(parameter, 'Optional'), methods: [], observableMethods: []
  }));
  const dependencyMap = new Map(dependencies.map(item => [item.name, item]));
  const methods: MethodInfo[] = []; const httpUsage: HttpUsageInfo[] = [];
  for (const member of declaration.members.filter(ts.isMethodDeclaration)) {
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    const calls: Array<{ dependency: string; method: string; deferred: boolean }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const target = node.expression.expression;
        if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const dependency = dependencyMap.get(target.name.text); const calledMethod = node.expression.name.text;
          if (dependency) {
            dependency.methods.push(calledMethod); calls.push({ dependency: dependency.name, method: calledMethod, deferred: isDeferred(node, member) });
            if (ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'subscribe') dependency.observableMethods.push(calledMethod);
          }
          if (dependency?.type === 'HttpClient' && ['get', 'post', 'put', 'patch', 'delete'].includes(calledMethod)) {
            const argument = node.arguments[0];
            if (argument) httpUsage.push({
              methodName: member.name.getText(file), httpMethod: calledMethod.toUpperCase(),
              urls: resolvePossibleStrings(argument, member, file),
              subscribesInternally: isChainedTo(node, 'subscribe')
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (member.body) visit(member.body);
    methods.push({ name: member.name.text, parameterCount: member.parameters.length, isPublic: !hasModifier(member, ts.SyntaxKind.PrivateKeyword) && !hasModifier(member, ts.SyntaxKind.ProtectedKeyword), dependencyCalls: uniqueCalls(calls) });
  }
  const declaredProperties: PropertyInfo[] = declaration.members.filter(ts.isPropertyDeclaration).filter(member => ts.isIdentifier(member.name)).map(member => ({
    name: (member.name as ts.Identifier).text, initializer: member.initializer?.getText(file), isPublic: !hasModifier(member, ts.SyntaxKind.PrivateKeyword) && !hasModifier(member, ts.SyntaxKind.ProtectedKeyword)
  }));
  const parameterProperties: PropertyInfo[] = (constructor?.parameters ?? []).filter(parameter => ts.isIdentifier(parameter.name) &&
    Boolean(ts.getModifiers(parameter)?.some(modifier => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(modifier.kind)))).map(parameter => ({
      name: (parameter.name as ts.Identifier).text, initializer: parameter.initializer?.getText(file),
      isPublic: !hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) && !hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword)
    }));
  const properties = [...declaredProperties, ...parameterProperties];
  for (const dependency of dependencies) { dependency.methods = [...new Set(dependency.methods)].sort(); dependency.observableMethods = [...new Set(dependency.observableMethods)].sort(); }
  return { diagnostic, sourceFile, sourceCode, entityType, className: declaration.name.text, standalone, dependencies, methods, properties, httpUsage };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean { return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind)); }
function uniqueCalls(values: Array<{ dependency: string; method: string; deferred: boolean }>): Array<{ dependency: string; method: string; deferred: boolean }> { return [...new Map(values.map(value => [`${value.dependency}.${value.method}.${value.deferred}`, value])).values()]; }
function providerToken(type: string): string { return type.match(/[$A-Z_a-z][$\w]*/)?.[0] ?? 'unknown'; }

function hasDecorator(node: ts.Node, name: string): boolean {
  return Boolean(ts.canHaveDecorators(node) && ts.getDecorators(node)?.some(decorator =>
    ((ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression).getText() === name)));
}

function injectedToken(parameter: ts.ParameterDeclaration, file: ts.SourceFile): string | undefined {
  for (const decorator of ts.getDecorators(parameter) ?? []) {
    if (!ts.isCallExpression(decorator.expression) || decorator.expression.expression.getText(file) !== 'Inject') continue;
    const token = decorator.expression.arguments[0];
    if (token) return token.getText(file);
  }
  return undefined;
}

function isDeferred(node: ts.Node, method: ts.MethodDeclaration): boolean {
  for (let current = node.parent; current && current !== method; current = current.parent) {
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) return true;
  }
  return false;
}

function isChainedTo(node: ts.CallExpression, method: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && (ts.isPropertyAccessExpression(current) || ts.isCallExpression(current))) {
    if (ts.isPropertyAccessExpression(current) && current.name.text === method) return true;
    current = current.parent;
  }
  return false;
}

function resolvePossibleStrings(expression: ts.Expression, method: ts.MethodDeclaration, file: ts.SourceFile): string[] {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (!ts.isIdentifier(expression) || !method.body) return [];
  const values: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === expression.text && node.initializer) collectStrings(node.initializer, values);
    ts.forEachChild(node, visit);
  };
  visit(method.body);
  return [...new Set(values)];
  function collectStrings(node: ts.Node, output: string[]): void {
    if (ts.isStringLiteralLike(node)) output.push(node.text);
    else if (ts.isNoSubstitutionTemplateLiteral(node)) output.push(node.text);
    else if (ts.isTemplateExpression(node)) output.push(node.head.text + node.templateSpans.map(span => span.literal.text).join(''));
    else ts.forEachChild(node, child => collectStrings(child, output));
  }
}
