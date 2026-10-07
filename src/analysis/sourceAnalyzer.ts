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
  const standaloneSetting = componentStandaloneSetting(decorator, file);
  const standalone = standaloneSetting ?? usesStandaloneByDefault(diagnostic);
  const constructor = declaration.members.find(ts.isConstructorDeclaration);
  const imports = new Map<string, string>();
  for (const statement of file.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.name) imports.set(clause.name.text, statement.moduleSpecifier.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) imports.set(element.name.text, statement.moduleSpecifier.text);
  }
  const constructorDependencies: DependencyInfo[] = (constructor?.parameters ?? []).map(parameter => ({
    name: ts.isIdentifier(parameter.name) ? parameter.name.text : 'dependency',
    type: parameter.type?.getText(file) ?? 'unknown',
    providerToken: injectedToken(parameter, file) ?? providerToken(parameter.type?.getText(file) ?? ''),
    importPath: imports.get(providerToken(parameter.type?.getText(file) ?? '')),
    optional: hasDecorator(parameter, 'Optional'), methods: [], observableMethods: []
  }));
  const injectedDependencies: DependencyInfo[] = declaration.members.filter(ts.isPropertyDeclaration).flatMap(member => {
    if (!ts.isIdentifier(member.name) || !member.initializer || !ts.isCallExpression(member.initializer) || member.initializer.expression.getText(file) !== 'inject') return [];
    const token = member.initializer.arguments[0];
    if (!token) return [];
    const provider = token.getText(file);
    return [{ name: member.name.text, type: provider, providerToken: provider, importPath: imports.get(provider), optional: false, methods: [], observableMethods: [] }];
  });
  const dependencies: DependencyInfo[] = [...constructorDependencies, ...injectedDependencies];
  const dependencyMap = new Map(dependencies.map(item => [item.name, item]));
  const methods: MethodInfo[] = []; const httpUsage: HttpUsageInfo[] = [];
  for (const member of declaration.members.filter(ts.isMethodDeclaration)) {
    if (!member.name || !ts.isIdentifier(member.name)) continue;
    const calls: Array<{ dependency: string; method: string; deferred: boolean }> = [];
    const signalOperations: MethodInfo['signalOperations'] = [];
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
        if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const signal = target.name.text;
          const operation = node.expression.name.text;
          if (operation === 'set' && node.arguments[0]) signalOperations.push({ signal, operation: 'set', value: node.arguments[0].getText(file) });
          if (operation === 'update' && node.arguments[0] && isBooleanToggle(node.arguments[0], file)) signalOperations.push({ signal, operation: 'toggle' });
        }
      }
      ts.forEachChild(node, visit);
    };
    if (member.body) visit(member.body);
    methods.push({ name: member.name.text, parameterCount: member.parameters.length, parameterNames: member.parameters.map(parameter => parameter.name.getText(file)), isPublic: !hasModifier(member, ts.SyntaxKind.PrivateKeyword) && !hasModifier(member, ts.SyntaxKind.ProtectedKeyword), dependencyCalls: uniqueCalls(calls), signalOperations });
  }
  const declaredProperties: PropertyInfo[] = declaration.members.filter(ts.isPropertyDeclaration).filter(member => ts.isIdentifier(member.name)).map(member => ({
    name: (member.name as ts.Identifier).text, initializer: member.initializer?.getText(file), isPublic: !hasModifier(member, ts.SyntaxKind.PrivateKeyword) && !hasModifier(member, ts.SyntaxKind.ProtectedKeyword),
    signalInitialValue: signalInitialValue(member.initializer, file), formValues: formInitialValues(member.initializer, file)
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

function componentStandaloneSetting(decorator: ts.CallExpression | undefined, file: ts.SourceFile): boolean | undefined {
  const metadata = decorator?.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return undefined;
  const property = metadata.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(file) === 'standalone');
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function usesStandaloneByDefault(diagnostic: ProjectDiagnostic): boolean {
  const major = Number.parseInt(diagnostic.project.angularVersion?.match(/\d+/)?.[0] ?? '', 10);
  return major >= 19 || diagnostic.project.primaryArchitecture === 'standalone';
}

function isBooleanToggle(expression: ts.Expression, file: ts.SourceFile): boolean {
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return false;
  const parameter = expression.parameters[0]?.name.getText(file);
  const body = ts.isBlock(expression.body) ? expression.body.statements.find(ts.isReturnStatement)?.expression : expression.body;
  return Boolean(parameter && body && ts.isPrefixUnaryExpression(body) && body.operator === ts.SyntaxKind.ExclamationToken && body.operand.getText(file) === parameter);
}

function signalInitialValue(initializer: ts.Expression | undefined, file: ts.SourceFile): string | undefined {
  if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(file) !== 'signal') return undefined;
  return initializer.arguments[0]?.getText(file);
}

function formInitialValues(initializer: ts.Expression | undefined, file: ts.SourceFile): Record<string, string> | undefined {
  if (!initializer || !ts.isCallExpression(initializer) || !/\.group$/.test(initializer.expression.getText(file))) return undefined;
  const config = initializer.arguments[0];
  if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
  const values: Record<string, string> = {};
  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText(file).replace(/^['"]|['"]$/g, '');
    const value = ts.isArrayLiteralExpression(property.initializer) ? property.initializer.elements[0] : property.initializer;
    if (!value) continue;
    const original = value.getText(file);
    values[name] = /email/i.test(name) ? "'user@example.com'" : /password/i.test(name) ? "'password'" : original;
  }
  return Object.keys(values).length ? values : undefined;
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
