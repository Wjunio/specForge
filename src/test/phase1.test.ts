import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSource } from '../analysis/sourceAnalyzer';
import { resolveTestCommand } from '../execution/commandResolver';
import { JasmineKarmaAdapter } from '../testing/jasmineKarmaAdapter';
import { JestAdapter } from '../testing/jestAdapter';
import { parseTestResult } from '../testing/testResultParser';
import { VitestAdapter } from '../testing/vitestAdapter';
import { AngularArchitecture, ProjectDiagnostic, TestFramework, TestRunner } from '../types';

function diagnostic(framework: TestFramework, runner: TestRunner): ProjectDiagnostic {
  const active = { framework, runner, confidence: 'high' as const, configFiles: [], detectedPackages: [], evidence: [] };
  return { project: { isAngular: true, workspace: 'C:/workspace', architecture: AngularArchitecture.Standalone, primaryArchitecture: AngularArchitecture.Standalone, componentsAnalyzed: 1, ngModulesAnalyzed: 0, evidence: [] }, testing: { frameworks: [active], activeFramework: active } };
}

test('analyzes a standalone component without modifying its source', () => {
  const source = `import { UserService } from './user.service'; @Component({ standalone: true }) export class UserComponent {
    count = 0;
    constructor(private users: UserService) {}
    load(): void { this.users.load(); }
  }`;
  const context = analyzeSource('C:/workspace/user.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  assert.equal(context.entityType, 'component'); assert.equal(context.standalone, true);
  assert.deepEqual(context.dependencies[0].methods, ['load']);
  assert.equal(context.methods[0].dependencyCalls[0].dependency, 'users');
  assert.equal(context.sourceCode, source);
});

test('generates framework-specific standalone component tests with behavioral assertions', () => {
  const source = `import { UserService } from './user.service'; @Component({ standalone: true }) export class UserComponent { count = 0; constructor(private users: UserService) {} load() { this.users.load(); } }`;
  const context = analyzeSource('C:/workspace/user.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const jest = new JestAdapter().generateComponentTest(context);
  assert.match(jest, /imports: \[UserComponent\]/); assert.match(jest, /load: jest\.fn\(\)/);
  assert.match(jest, /import \{ UserService \} from '\.\/user\.service'/);
  assert.match(jest, /expect\(subject\.count\)\.toEqual\(0\)/); assert.match(jest, /toHaveBeenCalled/);
  const vitest = new VitestAdapter().generateComponentTest(context);
  assert.match(vitest, /from 'vitest'/); assert.match(vitest, /load: vi\.fn\(\)/);
  const jasmine = new JasmineKarmaAdapter().generateComponentTest(context);
  assert.match(jasmine, /jasmine\.createSpyObj/); assert.doesNotMatch(jasmine, /jest\.|vi\./);
});

test('generates an Angular HTTP service test from actual AST usage', () => {
  const source = `@Injectable() export class UserService { constructor(private http: HttpClient) {} getUsers() { return this.http.get('/api/users'); } }`;
  const context = analyzeSource('C:/workspace/user.service.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const spec = new JestAdapter().generateServiceTest(context);
  assert.equal(context.entityType, 'service'); assert.deepEqual(context.httpUsage[0], { methodName: 'getUsers', httpMethod: 'GET', urls: ['/api/users'], subscribesInternally: false });
  assert.match(spec, /HttpClientTestingModule/); assert.match(spec, /httpMock\.expectOne\('\/api\/users'\)/); assert.match(spec, /request\.request\.method/);
});

test('configures observable dependency mocks for subscribe-based component behavior', () => {
  const source = `import { UserService } from './user.service'; @Component({ standalone: true }) export class UsersComponent {
    users: unknown[] = []; constructor(private service: UserService) {}
    load() { this.service.getUsers().subscribe(value => this.users = value); }
  }`;
  const context = analyzeSource('C:/workspace/users.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  assert.deepEqual(context.dependencies[0].observableMethods, ['getUsers']);
  const jest = new JestAdapter().generateComponentTest(context);
  assert.match(jest, /import \{ of \} from 'rxjs'/); assert.match(jest, /jest\.fn\(\)\.mockReturnValue\(of\(\[\]\)\)/);
  const jasmine = new JasmineKarmaAdapter().generateComponentTest(context);
  assert.match(jasmine, /getUsers\.and\.returnValue\(of\(\[\]\)\)/);
});

test('rejects unsupported entity types', () => {
  assert.throws(() => analyzeSource('thing.pipe.ts', 'export class ThingPipe {}', diagnostic(TestFramework.Jest, TestRunner.Jest)), /somente Component e Service/);
});

test('resolves only local runner entrypoints and rejects paths outside workspace', () => {
  const command = resolveTestCommand('C:/workspace', TestRunner.Jest, 'C:/workspace/src/user.spec.ts');
  assert.match(command.args[0], /node_modules[\\/]jest[\\/]bin[\\/]jest\.js$/); assert.equal(command.args[1], 'src/user.spec.ts');
  assert.throws(() => resolveTestCommand('C:/workspace', TestRunner.Vitest, 'C:/outside/user.spec.ts'), /fora do workspace/);
  assert.throws(() => resolveTestCommand('C:/workspace', TestRunner.Unknown, 'C:/workspace/user.spec.ts'), /não foi determinado/);
  const vitest = resolveTestCommand('C:/workspace', TestRunner.Vitest, 'C:/workspace/src/user.spec.ts', 'emits user');
  assert.match(vitest.args[0], /vitest\.mjs$/); assert.deepEqual(vitest.args.slice(-2), ['-t', 'emits user']);
  const karma = resolveTestCommand('C:/workspace', TestRunner.Karma, 'C:/workspace/src/user.spec.ts');
  assert.match(karma.args[0], /@angular[\\/]cli[\\/]bin[\\/]ng\.js$/); assert.ok(karma.args.includes('--include'));
});

test('generates NgModule service setup and exercises adapter service entrypoints', () => {
  const source = `@Injectable() export class CounterService { value = 1; }`;
  const context = analyzeSource('C:/workspace/counter.service.ts', source, diagnostic(TestFramework.Jasmine, TestRunner.Karma));
  const jasmine = new JasmineKarmaAdapter().generateServiceTest(context);
  assert.match(jasmine, /providers: \[CounterService\]/); assert.match(jasmine, /subject\.value/);
  assert.doesNotMatch(jasmine, /jasmine\.createSpyObj/);
  assert.match(new VitestAdapter().generateServiceTest(context), /from 'vitest'/);
});

test('classifies compilation, runtime, assertion, and environment failures', () => {
  const compilation = parseTestResult('error TS2304: Cannot find name X', 1, 'node jest', 10);
  assert.equal(compilation.compilationErrors[0].kind, 'compilation');
  const runtime = parseTestResult('NullInjectorError: No provider\nExpected one request Received none', 1, 'node jest', 10);
  assert.equal(runtime.runtimeErrors[0].kind, 'runtime'); assert.equal(runtime.runtimeErrors[1].kind, 'assertion');
  const environment = parseTestResult('browser executable unavailable', 1, 'node ng', 10);
  assert.equal(environment.runtimeErrors[0].kind, 'environment');
  const passed = parseTestResult('Tests: 2 passed, 1 skipped', 0, 'node jest', 10);
  assert.equal(passed.success, true); assert.equal(passed.passed, 2);
});

test('covers complex component branches consistently in every framework', () => {
  const source = `import { Component, ChangeDetectorRef, Inject, Optional } from '@angular/core';
    import { HttpClient } from '@angular/common/http';
    import { Subject, interval } from 'rxjs';
    @Component({ selector: 'app-complex', template: '' }) export class ComplexComponent {
      items: any[] = []; status: 'idle' | 'loading' | 'success' | 'error' = 'idle'; counter = 0;
      summary = { totalValue: 0, activeCount: 0, categoryTotals: {} as Record<string, number> };
      private destroy$ = new Subject<void>();
      constructor(@Optional() private http: HttpClient, private cdr: ChangeDetectorRef, @Inject('API_URL') @Optional() public apiUrl?: string) {}
      initTimer() { interval(1000).subscribe(() => { let current = this.counter; let increment = 1; while (current < 10) { current += increment++; } this.counter = current; this.cdr.markForCheck(); }); }
      fetchData() { if (!this.http) { this.status = 'error'; return; } const endpoint = this.apiUrl ? \`${'${this.apiUrl}'}/items\` : '/api/items'; this.http.get<any[]>(endpoint).subscribe({ next: data => { this.items = data; }, error: () => { this.status = 'error'; } }); }
      evaluateStatus(count: number) { if (count === 0) this.status = 'idle'; else if (count > 0 && count < 5) this.status = 'loading'; else if (count >= 5) this.status = 'success'; else this.status = 'error'; }
      recalculateSummary() {}
      processBatchUpdate(threshold: number) {}
    }`;
  for (const [framework, runner, adapter] of [
    [TestFramework.Jasmine, TestRunner.Karma, new JasmineKarmaAdapter()],
    [TestFramework.Jest, TestRunner.Jest, new JestAdapter()],
    [TestFramework.Vitest, TestRunner.Vitest, new VitestAdapter()]
  ] as const) {
    const context = analyzeSource('C:/workspace/complex.component.ts', source, diagnostic(framework, runner));
    const spec = adapter.generateComponentTest(context);
    assert.equal(context.dependencies[2].providerToken, "'API_URL'");
    assert.equal(context.dependencies[2].optional, true);
    assert.deepEqual(context.httpUsage[0].urls.sort(), ['/api/items', '/items']);
    assert.match(spec, /HttpClientTestingModule/);
    assert.match(spec, /should expose the error state/);
    assert.match(spec, /https:\/\/example\.test\/items/);
    assert.match(spec, /every item-count status boundary/);
    assert.match(spec, /recalculate active values/);
    assert.match(spec, /batch threshold/);
    assert.match(spec, /successful timer tick/);
    assert.doesNotMatch(spec, /provide: string/);
    assert.doesNotMatch(spec, /subject\.fetchData\(\)\.subscribe/);
  }
});
