import * as path from 'node:path';
import { TestGenerationContext } from '../types';

export interface FrameworkSyntax {
  globalsImport?: string;
  mock(name: string, methods: string[], observableMethods: string[]): string;
  configureObservableMock?(name: string, method: string): string;
  timers: { install: string; advance(milliseconds: number): string; uninstall: string };
}

export function generateAngularTest(context: TestGenerationContext, syntax: FrameworkSyntax): string {
  const relativeImport = `./${path.basename(context.sourceFile, '.ts')}`;
  const http = context.dependencies.some(item => item.type === 'HttpClient');
  const dependencies = context.dependencies.filter(item => item.type !== 'HttpClient' && item.type !== 'FormBuilder' && !item.optional);
  const lines: string[] = [];
  if (syntax.globalsImport) lines.push(syntax.globalsImport);
  if (context.dependencies.some(item => item.type !== 'HttpClient' && item.observableMethods.length)) lines.push("import { of } from 'rxjs';");
  lines.push("import { TestBed } from '@angular/core/testing';");
  if (context.entityType === 'component') lines.push("import { ComponentFixture } from '@angular/core/testing';");
  if (http) lines.push("import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';");
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
    if (dependency.type === 'ActivatedRoute') lines.push(`    ${dependency.name}Mock.snapshot = { queryParamMap: { get: () => null } };`);
  }
  const providers = [`${context.className}`, ...dependencies.map(item => `{ provide: ${item.providerToken}, useValue: ${item.name}Mock }`)].join(', ');
  if (context.entityType === 'component') {
    const setup = context.standalone ? `imports: [${context.className}${http ? ', HttpClientTestingModule' : ''}], providers: [${dependencies.map(item => `{ provide: ${item.providerToken}, useValue: ${item.name}Mock }`).join(', ')}]`
      : `declarations: [${context.className}], imports: [${http ? 'HttpClientTestingModule' : ''}], providers: [${dependencies.map(item => `{ provide: ${item.providerToken}, useValue: ${item.name}Mock }`).join(', ')}]`;
    lines.push(`    await TestBed.configureTestingModule({ ${setup} }).compileComponents();`, `    fixture = TestBed.createComponent(${context.className});`, '    subject = fixture.componentInstance;');
  } else {
    lines.push(`    await TestBed.configureTestingModule({ imports: [${http ? 'HttpClientTestingModule' : ''}], providers: [${providers}] }).compileComponents();`, `    subject = TestBed.inject(${context.className});`);
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
    lines.push('', `  it('should perform ${usage.httpMethod} ${url} when ${usage.methodName} is called', () => {`, `    subject.${usage.methodName}()${usage.subscribesInternally ? ';' : '.subscribe();'}`, `    const request = httpMock.expectOne('${escapeQuote(url)}');`, `    expect(request.request.method).toBe('${usage.httpMethod}');`, '    request.flush([]);', '  });');
    if (usage.subscribesInternally && context.properties.some(property => property.name === 'status')) {
      lines.push('', `  it('should expose the error state when ${usage.methodName} fails', () => {`, `    subject.${usage.methodName}();`, `    const request = httpMock.expectOne('${escapeQuote(url)}');`, "    request.flush('failure', { status: 500, statusText: 'Server Error' });", "    expect(subject.status).toBe('error');", '  });');
    }
    if (usage.subscribesInternally && context.properties.some(property => property.name === 'apiUrl') && usage.urls.some(candidate => candidate !== url)) {
      const suffix = [...usage.urls].sort((left, right) => left.length - right.length)[0];
      lines.push('', `  it('should use the configured API URL when ${usage.methodName} is called', () => {`, "    subject.apiUrl = 'https://example.test';", `    subject.${usage.methodName}();`, `    const request = httpMock.expectOne('https://example.test${escapeQuote(suffix)}');`, `    expect(request.request.method).toBe('${usage.httpMethod}');`, '    request.flush([]);', '  });');
    }
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
  appendKnownBehaviorScenarios(lines, context, syntax);
  lines.push('});', '');
  return lines.join('\n');
}

function appendValidFormSetup(lines: string[], context: TestGenerationContext, methodName: string, indentation: string): void {
  const method = context.methods.find(item => item.name === methodName);
  if (!method || !/login|submit|save/i.test(methodName)) return;
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

function appendKnownBehaviorScenarios(lines: string[], context: TestGenerationContext, syntax: FrameworkSyntax): void {
  const methods = new Set(context.methods.map(method => method.name));
  const properties = new Set(context.properties.map(property => property.name));
  if (methods.has('evaluateStatus') && properties.has('status')) {
    lines.push('', "  it('should evaluate every item-count status boundary', () => {", "    const scenarios = [[0, 'idle'], [1, 'loading'], [4, 'loading'], [5, 'success'], [-1, 'error']] as const;", '    for (const [count, expected] of scenarios) {', '      subject.evaluateStatus(count);', '      expect(subject.status).toBe(expected);', '    }', '  });');
  }
  if (methods.has('recalculateSummary') && properties.has('items') && properties.has('summary')) {
    lines.push('', "  it('should recalculate active values, count, and category totals', () => {", "    subject.items = [", "      { id: 1, name: 'A', value: 10, category: 'one', active: true },", "      { id: 2, name: 'B', value: 5, category: 'one', active: false },", "      { id: 3, name: 'C', value: 7, category: '', active: true }", '    ];', '    subject.recalculateSummary();', "    expect(subject.summary).toEqual({ totalValue: 17, activeCount: 2, categoryTotals: { one: 15, uncategorized: 7 } });", '  });');
  }
  if (methods.has('processBatchUpdate') && properties.has('items') && properties.has('summary')) {
    lines.push('', "  it('should activate, toggle, or deactivate items around the batch threshold', () => {", "    subject.items = [", "      { id: 1, name: 'above', value: 11, category: 'x', active: false },", "      { id: 2, name: 'equal', value: 10, category: 'x', active: true },", "      { id: 3, name: 'below', value: 9, category: 'x', active: true }", '    ];', '    subject.processBatchUpdate(10);', '    expect(subject.items.map(item => item.active)).toEqual([true, false, false]);', '    expect(subject.summary.activeCount).toBe(1);', '  });');
  }
  if (methods.has('initTimer') && properties.has('counter') && properties.has('status')) {
    lines.push('', "  it('should update the counter only after a successful timer tick', () => {", `    ${syntax.timers.install}`, "    subject.status = 'success';", '    subject.initTimer();', `    ${syntax.timers.advance(1000)}`, '    expect(subject.counter).toBe(10);', `    ${syntax.timers.uninstall}`, '  });');
  }
}
