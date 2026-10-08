import * as path from 'node:path';
import { TestGenerationContext } from '../types';
import { solveFlowScenarios } from '../analysis/controlFlowAnalyzer';
import { registeredStrategies } from './strategies/strategyRegistry';

export interface FrameworkSyntax {
  kind: 'jasmine' | 'jest' | 'vitest';
  globalsImport?: string;
  mock(name: string, methods: string[], observableMethods: string[]): string;
  configureObservableMock?(name: string, method: string): string;
  timers: { install: string; advance(milliseconds: number): string; uninstall: string };
}

export function generateAngularTest(context: TestGenerationContext, syntax: FrameworkSyntax): string {
  if (context.functional) return generateFunctionalTest(context, syntax);
  const relativeImport = `./${path.basename(context.sourceFile, '.ts')}`;
  const http = context.dependencies.some(item => item.type === 'HttpClient');
  const modernHttp = http && angularMajor(context) >= 15;
  const activeStrategies = registeredStrategies().filter(strategy => strategy.applies(context));
  const dependencies = context.dependencies.filter(item => item.type !== 'HttpClient' && item.type !== 'FormBuilder' && !item.optional);
  const lines: string[] = [];
  if (syntax.globalsImport) lines.push(syntax.globalsImport);
  if (context.dependencies.some(item => (item.type !== 'HttpClient' && item.observableMethods.length) || item.type === 'ActivatedRoute') || activeStrategies.some(strategy => strategy.requiresRxjsOf?.(context))) lines.push("import { of } from 'rxjs';");
  lines.push("import { TestBed } from '@angular/core/testing';");
  if (context.entityType === 'component') lines.push("import { ComponentFixture } from '@angular/core/testing';");
  if (http && modernHttp) lines.push("import { provideHttpClient } from '@angular/common/http';", "import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';");
  else if (http) lines.push("import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';");
  for (const dependency of dependencies.filter(item => item.importPath)) lines.push(`import { ${dependency.providerToken} } from '${dependency.importPath}';`);
  lines.push(`import { ${context.className} } from '${relativeImport}';`, '', `describe('${context.className}', () => {`);
  if (context.entityType === 'component') lines.push(`  let fixture: ComponentFixture<${context.className}>;`, `  let subject: ${context.className};`);
  else lines.push(`  let subject: ${context.className};`);
  if (http) lines.push('  let httpMock: HttpTestingController;');
  for (const dependency of dependencies) lines.push(`  let ${dependency.name}Mock: any;`);
  lines.push('', '  beforeEach(async () => {');
  for (const dependency of dependencies) {
    lines.push(`    ${dependency.name}Mock = ${syntax.mock(dependency.name, dependency.methods, dependency.observableMethods)};`);
    if (syntax.configureObservableMock) for (const method of dependency.observableMethods) lines.push(`    ${syntax.configureObservableMock(dependency.name, method)}`);
    if (dependency.type === 'ActivatedRoute') lines.push(`    ${dependency.name}Mock.snapshot = { paramMap: { get: () => null }, queryParamMap: { get: () => null }, params: {}, queryParams: {}, data: {} };`, `    ${dependency.name}Mock.params = of({});`, `    ${dependency.name}Mock.queryParams = of({});`, `    ${dependency.name}Mock.data = of({});`);
  }
  const httpProviders = modernHttp ? ['provideHttpClient()', 'provideHttpClientTesting()'] : [];
  const providers = [`${context.className}`, ...dependencies.map(item => `{ provide: ${item.providerToken}, useValue: ${item.name}Mock }`), ...httpProviders].join(', ');
  if (context.entityType === 'component') {
    const componentProviders = [...dependencies.map(item => `{ provide: ${item.providerToken}, useValue: ${item.name}Mock }`), ...httpProviders].join(', ');
    const setup = context.standalone ? `imports: [${context.className}${http && !modernHttp ? ', HttpClientTestingModule' : ''}], providers: [${componentProviders}]`
      : `declarations: [${context.className}], imports: [${http && !modernHttp ? 'HttpClientTestingModule' : ''}], providers: [${componentProviders}]`;
    lines.push(`    await TestBed.configureTestingModule({ ${setup} }).compileComponents();`, `    fixture = TestBed.createComponent(${context.className});`, '    subject = fixture.componentInstance;', '    fixture.detectChanges();');
  } else {
    lines.push(`    await TestBed.configureTestingModule({ imports: [${http && !modernHttp ? 'HttpClientTestingModule' : ''}], providers: [${providers}] }).compileComponents();`, `    subject = TestBed.inject(${context.className});`);
  }
  if (http) lines.push('    httpMock = TestBed.inject(HttpTestingController);');
  lines.push('  });');
  if (http || context.entityType === 'component') {
    lines.push('', '  afterEach(() => {');
    if (http) lines.push('    httpMock.verify();');
    if (context.entityType === 'component') lines.push('    fixture.destroy();');
    lines.push('  });');
  }

  lines.push('', "  it('should be available through the configured Angular testing environment', () => {", `    expect(subject.constructor).toBe(${context.className});`, '  });');
  for (const property of context.properties.filter(item => item.isPublic && isStableLiteral(item.initializer))) {
    lines.push('', `  it('should initialize ${property.name} with its declared value', () => {`, `    expect(subject.${property.name}).toEqual(${property.initializer});`, '  });');
  }
  for (const property of context.properties.filter(item => item.isPublic && isStableLiteral(item.signalInitialValue))) {
    lines.push('', `  it('should initialize ${property.name} signal with its declared value', () => {`, `    expect(subject.${property.name}()).toEqual(${property.signalInitialValue});`, '  });');
  }
  for (const usage of context.httpUsage) {
    const url = preferredUrl(usage.urls);
    if (!url) continue;
    lines.push('', `  it('should perform ${usage.httpMethod} ${url} when ${usage.methodName} succeeds', () => {`, `    subject.${usage.methodName}()${usage.subscribesInternally ? ';' : '.subscribe();'}`, `    const request = httpMock.expectOne('${escapeQuote(url)}');`, `    expect(request.request.method).toBe('${usage.httpMethod}');`, `    request.flush(${usage.mockResponse});`, '  });');
    if (!usage.subscribesInternally || usage.handlesError) lines.push('', `  it('should exercise the error path when ${usage.methodName} fails', () => {`, `    subject.${usage.methodName}()${usage.subscribesInternally ? ';' : '.subscribe({ error: () => undefined });'}`, `    const request = httpMock.expectOne('${escapeQuote(url)}');`, "    request.flush('Server Error', { status: 500, statusText: 'Internal Server Error' });", '  });');
  }
  const httpMethods = new Set(context.httpUsage.map(item => item.methodName));
  for (const method of context.methods.filter(item => item.isPublic && item.parameterCount === 0 && item.dependencyCalls.some(call => !call.deferred) && !httpMethods.has(item.name))) {
    lines.push('', `  it('should delegate dependencies when ${method.name} is called', () => {`);
    appendValidFormSetup(lines, context, method.name, '    ');
    lines.push(`    subject.${method.name}();`);
    for (const call of method.dependencyCalls.filter(call => !call.deferred && dependencies.some(dependency => dependency.name === call.dependency))) lines.push(`    expect(${call.dependency}Mock.${call.method}).toHaveBeenCalled();`);
    lines.push('  });');
  }
  appendSignalScenarios(lines, context);
  appendComputedScenarios(lines, context);
  appendEffectScenarios(lines, context);
  appendLifecycleScenarios(lines, context);
  appendTemplateEntryScenarios(lines, context);
  appendControlFlowScenarios(lines, context);
  for (const strategy of activeStrategies) strategy.append(lines, context, syntax);
  lines.push('});', '');
  return lines.join('\n');
}

function appendTemplateEntryScenarios(lines: string[], context: TestGenerationContext): void {
  if (!context.templateUsage) return;
  for (const name of context.templateUsage.invokedMethods) {
    const method = context.methods.find(item => item.name === name && item.isPublic && item.dependencyCalls.length);
    if (!method) continue;
    const flow = context.controlFlow.find(item => item.methodName === name);
    const argumentsList = flow?.parameters.map(parameter => parameter.candidates[0] ?? 'undefined') ?? method.parameterNames.map(() => 'undefined');
    lines.push('', `  it('should execute template event handler ${name}', () => {`, `    (subject as any).${name}(${argumentsList.join(', ')});`);
    for (const call of method.dependencyCalls.filter(item => context.dependencies.some(dependency => dependency.name === item.dependency))) lines.push(`    expect(${call.dependency}Mock.${call.method}).toHaveBeenCalled();`);
    lines.push('  });');
  }
}

function appendComputedScenarios(lines: string[], context: TestGenerationContext): void {
  for (const computed of context.properties.filter(property => property.isPublic && property.computedExpression && property.computedDependencies?.length)) {
    const dependencies = computed.computedDependencies!.map(name => context.properties.find(property => property.name === name && property.signalInitialValue !== undefined)).filter((property): property is NonNullable<typeof property> => Boolean(property));
    const mutable = dependencies.find(property => alternateLiteral(property.signalInitialValue!) !== undefined);
    if (!mutable) continue;
    const alternate = alternateLiteral(mutable.signalInitialValue!)!;
    const expected = computed.computedExpression!.replace(/\bthis\.([$\w]+)\s*\(\s*\)/g, 'subject.$1()');
    lines.push('', `  it('should recompute ${computed.name} when ${mutable.name} changes', () => {`, `    subject.${mutable.name}.set(${alternate});`);
    if (context.entityType === 'component') lines.push('    fixture.detectChanges();');
    lines.push(`    expect(subject.${computed.name}()).toEqual(${expected});`, '  });');
  }
}

function appendEffectScenarios(lines: string[], context: TestGenerationContext): void {
  for (const effect of context.properties.filter(property => property.effectDependencies?.length && property.effectWrites?.length)) {
    const mutable = effect.effectDependencies!
      .map(name => context.properties.find(property => property.name === name && property.signalInitialValue !== undefined))
      .find((property): property is NonNullable<typeof property> => Boolean(property && alternateLiteral(property.signalInitialValue!) !== undefined));
    if (!mutable) continue;
    const alternate = alternateLiteral(mutable.signalInitialValue!)!;
    lines.push('', `  it('should run ${effect.name} when ${mutable.name} changes', () => {`, `    subject.${mutable.name}.set(${alternate});`);
    if (context.entityType === 'component') lines.push('    fixture.detectChanges();');
    for (const write of effect.effectWrites!) {
      const expected = write.expression.replace(/\bthis\.([$\w]+)\s*\(\s*\)/g, 'subject.$1()');
      lines.push(`    expect((subject as any).${write.property}).toEqual(${expected});`);
    }
    lines.push('  });');
  }
}

function generateFunctionalTest(context: TestGenerationContext, syntax: FrameworkSyntax): string {
  const relativeImport = `./${path.basename(context.sourceFile, '.ts')}`;
  const lines: string[] = [];
  if (syntax.globalsImport) lines.push(syntax.globalsImport);
  const needsOf = context.entityType === 'functional-interceptor' || context.dependencies.some(dependency => dependency.observableMethods.length);
  if (needsOf) lines.push("import { of } from 'rxjs';");
  lines.push("import { TestBed } from '@angular/core/testing';");
  for (const dependency of context.dependencies.filter(item => item.importPath)) lines.push(`import { ${dependency.providerToken} } from '${dependency.importPath}';`);
  lines.push(`import { ${context.className} } from '${relativeImport}';`, '', `describe('${context.className}', () => {`);
  for (const dependency of context.dependencies) lines.push(`  let ${dependency.name}Mock: any;`);
  lines.push('', '  beforeEach(() => {');
  for (const dependency of context.dependencies) {
    lines.push(`    ${dependency.name}Mock = ${syntax.mock(dependency.name, dependency.methods, dependency.observableMethods)};`);
    if (syntax.configureObservableMock) for (const method of dependency.observableMethods) lines.push(`    ${syntax.configureObservableMock(dependency.name, method)}`);
  }
  lines.push(`    TestBed.configureTestingModule({ providers: [${context.dependencies.map(item => `{ provide: ${item.providerToken}, useValue: ${item.name}Mock }`).join(', ')}] });`, '  });');
  if (context.entityType === 'functional-interceptor') {
    const fn = mockFunction(syntax);
    const nextName = context.methods[0].parameterNames[1];
    const callsNext = Boolean(nextName && new RegExp(`\\b${escapeRegExp(nextName)}\\s*\\(`).test(context.sourceCode));
    lines.push('', "  it('should execute the functional interceptor in an injection context', () => {", '    const request = {} as any;', `    const next = ${fn};`, syntax.kind === 'jasmine' ? '    next.and.returnValue(of({} as any));' : '    next.mockReturnValue(of({} as any));', `    TestBed.runInInjectionContext(() => ${context.className}(request, next));`);
    if (callsNext) lines.push('    expect(next).toHaveBeenCalled();');
    for (const dependency of context.dependencies) for (const method of dependency.methods) lines.push(`    expect(${dependency.name}Mock.${method}).toHaveBeenCalled();`);
    lines.push('  });');
  } else {
    const argumentsList = context.methods[0].parameterNames.map(() => '{} as any').join(', ');
    lines.push('', "  it('should execute the functional Angular entrypoint in an injection context', () => {", `    TestBed.runInInjectionContext(() => ${context.className}(${argumentsList}));`);
    for (const dependency of context.dependencies) for (const method of dependency.methods) lines.push(`    expect(${dependency.name}Mock.${method}).toHaveBeenCalled();`);
    lines.push('  });');
  }
  lines.push('});', '');
  return lines.join('\n');
}

function angularMajor(context: TestGenerationContext): number { return Number.parseInt(context.diagnostic.project.angularVersion?.match(/\d+/)?.[0] ?? '0', 10); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function mockFunction(syntax: FrameworkSyntax): string { return syntax.kind === 'jasmine' ? "jasmine.createSpy('fn')" : syntax.kind === 'jest' ? 'jest.fn()' : 'vi.fn()'; }

function appendLifecycleScenarios(lines: string[], context: TestGenerationContext): void {
  for (const lifecycle of context.lifecycles) {
    const argumentsList = lifecycle === 'ngOnChanges' ? '{} as any' : '';
    lines.push('', `  it('should execute ${lifecycle} lifecycle hook', () => {`, `    subject.${lifecycle}(${argumentsList});`, '  });');
  }
}

function appendControlFlowScenarios(lines: string[], context: TestGenerationContext): void {
  const specialized = new Set([...context.xhrDownloadFlows.map(flow => flow.methodName), ...context.httpUsage.map(usage => usage.methodName)]);
  const publicMethods = new Set(context.methods.filter(method => method.isPublic).map(method => method.name));
  for (const flow of context.controlFlow.filter(method => method.decisions.length && method.effects.some(effect => effect.kind === 'property-write' || effect.kind === 'return') && publicMethods.has(method.methodName) && !specialized.has(method.methodName))) {
    lines.push('', `  describe('${flow.methodName} control-flow paths', () => {`);
    const scenarios = solveFlowScenarios(flow);
    scenarios.forEach((scenario, index) => {
      const argumentsList = scenario.arguments;
      const invocation = `(subject as any).${flow.methodName}(${argumentsList.join(', ')})`;
      const returns = scenario.effects.find(effect => effect.kind === 'return');
      lines.push('', `    it('should exercise resolved path ${index + 1} of ${scenarios.length}', ${flow.async ? 'async ' : ''}() => {`,
        `      const result = ${flow.async ? `await ${invocation}` : invocation};`);
      for (const effect of scenario.effects) {
        if (effect.kind !== 'property-write') continue;
        lines.push(`      expect(subject.${effect.property}).toEqual(${effect.values[0]});`);
      }
      if (returns?.kind === 'return') lines.push(`      expect(result).toEqual(${returns.values[0]});`);
      for (const effect of scenario.effects) if (effect.kind === 'dependency-call' && context.dependencies.some(dependency => dependency.name === effect.dependency)) lines.push(`      expect(${effect.dependency}Mock.${effect.method}).toHaveBeenCalled();`);
      lines.push('    });');
    });
    lines.push('  });');
  }
}

function appendValidFormSetup(lines: string[], context: TestGenerationContext, methodName: string, indentation: string): void {
  const method = context.methods.find(item => item.name === methodName);
  if (!method) return;
  const form = context.properties.find(property => property.formValues);
  if (!form?.formValues) return;
  const values = Object.entries(form.formValues).map(([name, value]) => `${name}: ${value}`).join(', ');
  lines.push(`${indentation}subject.${form.name}.setValue({ ${values} });`);
}

function appendSignalScenarios(lines: string[], context: TestGenerationContext): void {
  const publicSignals = new Set(context.properties.filter(property => property.isPublic && property.signalInitialValue !== undefined).map(property => property.name));
  for (const method of context.methods.filter(item => item.isPublic)) {
    const operations = method.signalOperations.filter(operation => publicSignals.has(operation.signal));
    const toggle = operations.find(operation => operation.operation === 'toggle');
    if (toggle && method.parameterCount === 0) {
      lines.push('', `  it('should toggle ${toggle.signal} when ${method.name} is called', () => {`, `    const previous = subject.${toggle.signal}();`, `    subject.${method.name}();`, `    expect(subject.${toggle.signal}()).toBe(!previous);`, '  });');
    }
    if (method.parameterCount === 1) {
      const parameter = method.parameterNames[0];
      const matching = operations.find(operation => operation.operation === 'set' && operation.value === parameter);
      if (matching) {
        lines.push('', `  it('should update ${matching.signal} when ${method.name} is called', () => {`, "    const value = 'test value';", `    subject.${method.name}(value);`, `    expect(subject.${matching.signal}()).toBe(value);`, '  });');
      }
    }
    if (method.parameterCount === 0) {
      const assignments = operations.filter(operation => operation.operation === 'set' && isStableLiteral(operation.value));
      if (assignments.length) {
        lines.push('', `  it('should update signal state when ${method.name} is called', () => {`);
        for (const assignment of assignments) {
          const differentValue = alternateLiteral(assignment.value!);
          if (differentValue) lines.push(`    subject.${assignment.signal}.set(${differentValue});`);
        }
        lines.push(`    subject.${method.name}();`);
        for (const assignment of assignments) lines.push(`    expect(subject.${assignment.signal}()).toEqual(${assignment.value});`);
        lines.push('  });');
      }
    }
  }
}

function alternateLiteral(value: string): string | undefined {
  if (value === "''" || value === '\"\"' || value === '``') return "'previous value'";
  if (value === 'true') return 'false';
  if (value === 'false') return 'true';
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return value === '0' ? '1' : '0';
  return undefined;
}

function isStableLiteral(value?: string): boolean { return Boolean(value && /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|['"`][^`'"]*['"`]|\[\]|\{\})$/.test(value)); }
function escapeQuote(value: string): string { return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function preferredUrl(urls: string[]): string | undefined { return [...urls].sort((left, right) => right.length - left.length)[0]; }

