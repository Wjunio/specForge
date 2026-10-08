import ts from 'typescript';
import { DependencyInfo, EntityType, HttpUsageInfo, MethodInfo, PropertyInfo, TestGenerationContext, ProjectDiagnostic, XhrDownloadFlowInfo } from '../types';
import { analyzeControlFlow } from './controlFlowAnalyzer';

export function analyzeSource(sourceFile: string, sourceCode: string, diagnostic: ProjectDiagnostic): TestGenerationContext {
  const file = ts.createSourceFile(sourceFile, sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(ts.isClassDeclaration);
  if (!declaration?.name) return analyzeFunctionalSource(sourceFile, sourceCode, file, diagnostic);
  const decorators = declaration.modifiers?.filter(ts.isDecorator) ?? [];
  const decorator = decorators.map(item => ts.isCallExpression(item.expression) ? item.expression : undefined).find(Boolean);
  const decoratorName = decorator?.expression.getText(file);
  const entityType: EntityType = decoratorName === 'Component' || /\.component\.ts$/i.test(sourceFile) ? 'component'
    : decoratorName === 'Pipe' || /\.pipe\.ts$/i.test(sourceFile) ? 'pipe'
      : /\.guard\.ts$/i.test(sourceFile) ? 'guard'
        : decoratorName === 'Injectable' || /\.service\.ts$/i.test(sourceFile) ? 'service'
          : (() => { throw new Error('O arquivo deve ser um Component, Service, Pipe ou Guard baseado em classe.'); })();
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
              subscribesInternally: isChainedTo(node, 'subscribe'),
              handlesError: /\b(?:catchError|error\s*:)/.test(member.getText(file)),
              mockResponse: inferHttpMockResponse(node, file)
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
    signalInitialValue: signalInitialValue(member.initializer, file), ...computedInfo(member.initializer, file), ...effectInfo(member.initializer, file), formValues: formInitialValues(member.initializer, file)
  }));
  const parameterProperties: PropertyInfo[] = (constructor?.parameters ?? []).filter(parameter => ts.isIdentifier(parameter.name) &&
    Boolean(ts.getModifiers(parameter)?.some(modifier => [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.ReadonlyKeyword].includes(modifier.kind)))).map(parameter => ({
      name: (parameter.name as ts.Identifier).text, initializer: parameter.initializer?.getText(file),
      isPublic: !hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) && !hasModifier(parameter, ts.SyntaxKind.ProtectedKeyword)
    }));
  const properties = [...declaredProperties, ...parameterProperties];
  for (const dependency of dependencies) { dependency.methods = [...new Set(dependency.methods)].sort(); dependency.observableMethods = [...new Set(dependency.observableMethods)].sort(); }
  const xhrDownloadFlows = analyzeXhrDownloadFlows(declaration, file, dependencies);
  const controlFlow = analyzeControlFlow(declaration, file);
  const lifecycleNames = new Set(['ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngAfterViewInit', 'ngAfterViewChecked', 'ngAfterContentInit', 'ngAfterContentChecked', 'ngDoCheck']);
  const lifecycles = methods.map(method => method.name).filter(name => lifecycleNames.has(name));
  return { diagnostic, sourceFile, sourceCode, entityType, className: declaration.name.text, functional: false, standalone, dependencies, methods, properties, httpUsage,
    browserUsage: {
      xmlHttpRequest: /new\s+XMLHttpRequest\s*\(/.test(sourceCode),
      objectUrl: /(?:window\.)?URL\.(?:createObjectURL|revokeObjectURL)\s*\(/.test(sourceCode),
      dynamicAnchor: /document\.createElement\s*\(\s*['"]a['"]\s*\)/.test(sourceCode),
      locationHref: /(?:window\.)?location\.href\s*=/.test(sourceCode),
      timers: /\bset(?:Timeout|Interval)\s*\(/.test(sourceCode)
    }, xhrDownloadFlows, controlFlow, lifecycles };
}

function analyzeFunctionalSource(sourceFile: string, sourceCode: string, file: ts.SourceFile, diagnostic: ProjectDiagnostic): TestGenerationContext {
  const imports = new Map<string, string>();
  for (const statement of file.statements.filter(ts.isImportDeclaration)) {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) imports.set(element.name.text, statement.moduleSpecifier.text);
  }
  const declarations = file.statements.filter(ts.isVariableStatement).flatMap(statement => statement.declarationList.declarations);
  const declaration = declarations.find(item => {
    const type = item.type?.getText(file) ?? '';
    return /^(?:CanActivateFn|CanMatchFn|CanDeactivateFn|ResolveFn(?:<.*>)?|HttpInterceptorFn)$/.test(type);
  });
  if (!declaration || !ts.isIdentifier(declaration.name) || !declaration.initializer || (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer))) {
    throw new Error('O arquivo deve conter Component, Service, Pipe, Guard ou função Angular suportada.');
  }
  const type = declaration.type?.getText(file) ?? '';
  const entityType: EntityType = type === 'HttpInterceptorFn' ? 'functional-interceptor' : /^ResolveFn/.test(type) ? 'functional-resolver' : 'functional-guard';
  const dependencies: DependencyInfo[] = [];
  const dependencyCalls = new Map<string, Array<{ dependency: string; method: string; deferred: boolean }>>();
  const injectVariables = new Map<string, DependencyInfo>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(file) === 'inject' && node.initializer.arguments[0]) {
      const token = node.initializer.arguments[0].getText(file);
      const dependency = { name: node.name.text, type: token, providerToken: token, importPath: imports.get(token), optional: false, methods: [], observableMethods: [] } satisfies DependencyInfo;
      dependencies.push(dependency); injectVariables.set(node.name.text, dependency);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
      const dependency = injectVariables.get(node.expression.expression.text);
      if (dependency) { dependency.methods.push(node.expression.name.text); dependencyCalls.set(dependency.name, [...(dependencyCalls.get(dependency.name) ?? []), { dependency: dependency.name, method: node.expression.name.text, deferred: false }]); }
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.initializer);
  for (const dependency of dependencies) dependency.methods = [...new Set(dependency.methods)].sort();
  const method: MethodInfo = { name: declaration.name.text, parameterCount: declaration.initializer.parameters.length, parameterNames: declaration.initializer.parameters.map(item => item.name.getText(file)), isPublic: true, dependencyCalls: [...dependencyCalls.values()].flat(), signalOperations: [] };
  return { diagnostic, sourceFile, sourceCode, entityType, className: declaration.name.text, functional: true, standalone: true, dependencies, methods: [method], properties: [], httpUsage: [], browserUsage: { xmlHttpRequest: false, objectUrl: false, dynamicAnchor: false, locationHref: false, timers: false }, xhrDownloadFlows: [], controlFlow: [], lifecycles: [] };
}

function inferHttpMockResponse(call: ts.CallExpression, file: ts.SourceFile): string {
  const typeArguments = call.typeArguments;
  if (!typeArguments?.length) return '[]';
  const type = typeArguments[0].getText(file);
  if (/\[\]$|Array<.+>/.test(type)) return '[]';
  if (type === 'boolean') return 'true';
  if (type === 'number') return '0';
  if (type === 'string') return "'response'";
  return '{} as any';
}

function analyzeXhrDownloadFlows(declaration: ts.ClassDeclaration, file: ts.SourceFile, dependencies: DependencyInfo[]): XhrDownloadFlowInfo[] {
  return declaration.members.filter(ts.isMethodDeclaration).flatMap(method => {
    if (!method.body || !method.name || !ts.isIdentifier(method.name)) return [];
    let hasXhr = false; let path: string | undefined; let httpMethod: string | undefined; let successStatus: number | undefined; let downloadName: string | undefined;
    let loadingProperty: string | undefined; let progressProperty: string | undefined;
    let timeoutMs: number | undefined; let redirectUrl: string | undefined; let errorPrefix: string | undefined;
    const stringVariables = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) stringVariables.set(node.name.text, node.initializer.text);
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'XMLHttpRequest') hasXhr = true;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callName = node.expression.name.text;
        if (callName === 'open' && node.arguments[1]) {
          if (node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) httpMethod = node.arguments[0].text;
          const argumentText = node.arguments[1].getText(file);
          path = collectStringLiterals(node.arguments[1]).find(value => value.startsWith('/')) ?? [...stringVariables].find(([name]) => argumentText.includes(name))?.[1] ?? path;
        }
        if (callName === 'setTimeout' || node.expression.getText(file) === 'setTimeout') {
          const delay = node.arguments[1]; if (delay && ts.isNumericLiteral(delay)) timeoutMs = Number(delay.text);
        }
        if (node.expression.getText(file) === 'console.error' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) errorPrefix = node.arguments[0].text;
      }
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'setTimeout') {
        const delay = node.arguments[1]; if (delay && ts.isNumericLiteral(delay)) timeoutMs = Number(delay.text);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left.getText(file); const right = node.right;
        const property = /^this\.([$\w]+)$/.exec(left)?.[1];
        if (property && right.kind === ts.SyntaxKind.TrueKeyword) loadingProperty ??= property;
        if (property && /Math\.round/.test(right.getText(file))) progressProperty ??= property;
        if (/\.download$/.test(left) && ts.isStringLiteralLike(right)) downloadName = right.text;
        if (/(?:window\.)?location\.href$/.test(left) && ts.isStringLiteralLike(right)) redirectUrl = right.text;
      }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(node.operatorToken.kind)) {
        const left = node.left.getText(file); const right = node.right;
        if (/\.status$/.test(left) && ts.isNumericLiteral(right)) successStatus = Number(right.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(method.body);
    if (!hasXhr) return [];
    const dialogDependency = dependencies.find(dependency => dependency.type === 'MatDialog' && method.getText(file).includes(`this.${dependency.name}.`))?.name;
    return [{ methodName: method.name.text, parameterName: method.parameters[0]?.name.getText(file), httpMethod, successStatus, path, downloadName, loadingProperty, progressProperty, timeoutMs, redirectUrl, errorPrefix, dialogDependency } satisfies XhrDownloadFlowInfo];
    function collectStringLiterals(node: ts.Node): string[] { const values: string[] = []; const collect = (child: ts.Node): void => { if (ts.isStringLiteralLike(child)) values.push(child.text); else ts.forEachChild(child, collect); }; collect(node); return values; }
  });
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

function computedInfo(initializer: ts.Expression | undefined, file: ts.SourceFile): Pick<PropertyInfo, 'computedExpression' | 'computedDependencies'> {
  if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(file) !== 'computed') return {};
  const callback = initializer.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return {};
  const returned = ts.isBlock(callback.body) ? callback.body.statements.find(ts.isReturnStatement)?.expression : callback.body;
  if (!returned) return {};
  const dependencies = new Set<string>();
  const visit = (node: ts.Node): void => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword) dependencies.add(node.expression.name.text); ts.forEachChild(node, visit); };
  visit(returned);
  return { computedExpression: returned.getText(file), computedDependencies: [...dependencies] };
}

function effectInfo(initializer: ts.Expression | undefined, file: ts.SourceFile): Pick<PropertyInfo, 'effectDependencies' | 'effectWrites' | 'effectHasCleanup'> {
  if (!initializer || !ts.isCallExpression(initializer) || initializer.expression.getText(file) !== 'effect') return {};
  const callback = initializer.arguments[0];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) return {};
  const dependencies = new Set<string>();
  const writes: Array<{ property: string; expression: string }> = [];
  let hasCleanup = false;
  const cleanupParameter = callback.parameters[0]?.name.getText(file);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.arguments.length === 0) dependencies.add(node.expression.name.text);
      if (cleanupParameter && node.expression.getText(file) === cleanupParameter) hasCleanup = true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const property = /^this\.([$\w]+)$/.exec(node.left.getText(file))?.[1];
      if (property) writes.push({ property, expression: node.right.getText(file) });
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return { effectDependencies: [...dependencies], effectWrites: writes, effectHasCleanup: hasCleanup };
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
