import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSource } from '../analysis/sourceAnalyzer';
import { componentTemplateReference, inspectTemplateAst } from '../analysis/templateAnalyzer';
import { resolveTestCommand } from '../execution/commandResolver';
import { parseCoverageDetail, parseCoverageSummary } from '../execution/coverageReader';
import { repairGeneratedTest } from '../generation/repairPlanner';
import { augmentTestForCoverage } from '../generation/coverageFeedback';
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
  assert.equal(context.entityType, 'service'); assert.deepEqual(context.httpUsage[0], { methodName: 'getUsers', httpMethod: 'GET', urls: ['/api/users'], subscribesInternally: false, handlesError: false, mockResponse: '[]' });
  assert.match(spec, /HttpClientTestingModule/); assert.match(spec, /httpMock\.expectOne\('\/api\/users'\)/); assert.match(spec, /request\.request\.method/); assert.match(spec, /exercise the error path/);
});

test('uses provider-based HTTP testing for modern Angular versions', () => {
  const project = diagnostic(TestFramework.Jest, TestRunner.Jest);
  project.project.angularVersion = '19.2.0';
  const context = analyzeSource('C:/workspace/user.service.ts', `@Injectable() export class UserService { constructor(private http: HttpClient) {} load() { return this.http.get<boolean>('/ready'); } }`, project);
  const spec = new JestAdapter().generateServiceTest(context);
  assert.match(spec, /provideHttpClient\(\)/);
  assert.match(spec, /provideHttpClientTesting\(\)/);
  assert.doesNotMatch(spec, /HttpClientTestingModule/);
  assert.match(spec, /request\.flush\(true\)/);
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

test('supports inject fields, implicit standalone components, signals, and reactive forms additively', () => {
  const source = `import { Component, inject, signal } from '@angular/core';
    import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
    import { ActivatedRoute, Router } from '@angular/router';
    import { AuthService } from './auth.service';
    @Component({ selector: 'app-login', imports: [ReactiveFormsModule], template: '' })
    export class LoginComponent {
      private readonly formBuilder = inject(FormBuilder);
      private readonly authService = inject(AuthService);
      private readonly router = inject(Router);
      private readonly route = inject(ActivatedRoute);
      readonly showPassword = signal(false);
      readonly errorMessage = signal('');
      readonly form = this.formBuilder.nonNullable.group({ email: ['', [Validators.required, Validators.email]], password: ['', Validators.required], remember: [false] });
      handleSocialLogin() { const target = this.route.snapshot.queryParamMap.get('redirectTo') || '/app'; void this.router.navigateByUrl(target); }
      handleSocialLoginError(message: string) { this.errorMessage.set(message); }
      login() { if (this.form.invalid) return; this.authService.login(this.form.getRawValue()).subscribe(() => this.router.navigateByUrl('/app')); }
      togglePasswordVisibility() { this.showPassword.update(current => !current); }
      dismissErrorMessage() { this.errorMessage.set(''); }
    }`;
  const context = analyzeSource('C:/workspace/body-login.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const spec = new JestAdapter().generateComponentTest(context);
  assert.equal(context.standalone, true);
  assert.deepEqual(context.dependencies.map(item => item.type), ['FormBuilder', 'AuthService', 'Router', 'ActivatedRoute']);
  assert.deepEqual(context.dependencies.find(item => item.type === 'AuthService')?.observableMethods, ['login']);
  assert.match(spec, /imports: \[LoginComponent\]/);
  assert.doesNotMatch(spec, /provide: FormBuilder/);
  assert.match(spec, /provide: AuthService/);
  assert.match(spec, /routeMock\.snapshot/);
  assert.match(spec, /subject\.form\.setValue\(\{ email: 'user@example\.com', password: 'password', remember: false \}\)/);
  assert.match(spec, /should initialize showPassword signal/);
  assert.match(spec, /should toggle showPassword/);
  assert.match(spec, /should update errorMessage/);
  assert.match(spec, /should update signal state when dismissErrorMessage is called/);
});

test('extracts computed signal dependencies and generates a reactive assertion', () => {
  const source = `@Component({ standalone: true, template: '' }) export class PriceComponent { quantity = signal(2); unitPrice = signal(5); total = computed(() => this.quantity() * this.unitPrice()); }`;
  const context = analyzeSource('C:/workspace/price.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const total = context.properties.find(item => item.name === 'total')!;
  assert.equal(total.computedExpression, 'this.quantity() * this.unitPrice()');
  assert.deepEqual(total.computedDependencies, ['quantity', 'unitPrice']);
  const spec = new JestAdapter().generateComponentTest(context);
  assert.match(spec, /subject\.quantity\.set\(0\)/);
  assert.match(spec, /fixture\.detectChanges\(\)/);
  assert.match(spec, /expect\(subject\.total\(\)\)\.toEqual\(subject\.quantity\(\) \* subject\.unitPrice\(\)\)/);
});

test('extracts signal effects, observable writes, and cleanup registration', () => {
  const source = `@Component({ standalone: true, template: '' }) export class CounterComponent { count = signal(0); visible = 0; sync = effect((onCleanup) => { this.visible = this.count(); onCleanup(() => this.visible = -1); }); }`;
  const context = analyzeSource('C:/workspace/counter.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const effect = context.properties.find(property => property.name === 'sync')!;
  assert.deepEqual(effect.effectDependencies, ['count']);
  assert.equal(effect.effectHasCleanup, true);
  assert.ok(effect.effectWrites?.some(write => write.property === 'visible' && write.expression === 'this.count()'));
  const generated = new JestAdapter().generateComponentTest(context);
  assert.match(generated, /should run sync when count changes/);
  assert.match(generated, /expect\(\(subject as any\)\.visible\)\.toEqual\(subject\.count\(\)\)/);
});

test('extracts inline and external templates and inspects Angular template AST metadata', () => {
  const inline = componentTemplateReference('C:/workspace/card.component.ts', `@Component({ template: '<button (click)="save()">Save</button>' }) export class CardComponent {}`);
  assert.equal(inline.inline, '<button (click)="save()">Save</button>');
  const external = componentTemplateReference('C:/workspace/card.component.ts', `@Component({ templateUrl: './card.component.html' }) export class CardComponent {}`);
  assert.match(external.external!, /card\.component\.html$/);
  class PropertyRead { constructor(public name: string) {} }
  class Call { constructor(public receiver: unknown) {} }
  class BoundEvent { constructor(public name: string, public handler: unknown) {} }
  class BoundAttribute { constructor(public name: string) {} }
  class TextAttribute { constructor(public name: string, public value: string) {} }
  const usage = inspectTemplateAst([new BoundEvent('click', new Call(new PropertyRead('save'))), new BoundAttribute('disabled'), new TextAttribute('formControlName', 'email')]);
  assert.deepEqual(usage, { events: ['click'], invokedMethods: ['save'], inputs: ['disabled'], outputs: ['click'], formControls: ['email'] });
  const source = `import { SaveService } from './save.service'; @Component({ standalone: true, template: '' }) export class FormComponent { constructor(private saver: SaveService) {} submit() { this.saver.save(); } }`;
  const context = analyzeSource('C:/workspace/form.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  context.templateUsage = { events: ['submit'], invokedMethods: ['submit'], inputs: [], outputs: ['submit'], formControls: [] };
  assert.match(new JestAdapter().generateComponentTest(context), /should execute template event handler submit/);
});

test('respects an explicit standalone false setting', () => {
  const source = `@Component({ standalone: false, template: '' }) export class LegacyComponent {}`;
  const context = analyzeSource('C:/workspace/legacy.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  assert.equal(context.standalone, false);
  assert.match(new JestAdapter().generateComponentTest(context), /declarations: \[LegacyComponent\]/);
});

test('extracts and generates lifecycle hook scenarios', () => {
  const source = `@Component({ standalone: true, template: '' }) export class LifecycleComponent { ngOnInit() {} ngOnChanges(_changes: any) {} ngOnDestroy() {} }`;
  const context = analyzeSource('C:/workspace/lifecycle.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const spec = new JestAdapter().generateComponentTest(context);
  assert.deepEqual(context.lifecycles, ['ngOnInit', 'ngOnChanges', 'ngOnDestroy']);
  assert.match(spec, /subject\.ngOnInit\(\)/);
  assert.match(spec, /subject\.ngOnChanges\(\{\} as any\)/);
  assert.match(spec, /subject\.ngOnDestroy\(\)/);
});

test('rejects unsupported entity types', () => {
  assert.throws(() => analyzeSource('thing.directive.ts', 'export class ThingDirective {}', diagnostic(TestFramework.Jest, TestRunner.Jest)), /Component, Service, Pipe ou Guard/);
});

test('supports class-based pipes and guards', () => {
  const pipe = analyzeSource('label.pipe.ts', `@Pipe({ name: 'label' }) export class LabelPipe { transform(value: string) { return value ? value.trim() : ''; } }`, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const guard = analyzeSource('auth.guard.ts', `@Injectable() export class AuthGuard { canActivate(enabled: boolean) { return enabled ? true : false; } }`, diagnostic(TestFramework.Jest, TestRunner.Jest));
  assert.equal(pipe.entityType, 'pipe'); assert.equal(guard.entityType, 'guard');
  assert.equal(pipe.controlFlow[0].decisions[0].kind, 'ternary');
  assert.equal(guard.controlFlow[0].decisions[0].kind, 'ternary');
});

test('supports functional guards, resolvers, and interceptors through injection context', () => {
  const project = diagnostic(TestFramework.Jest, TestRunner.Jest);
  const guardSource = `import { inject } from '@angular/core'; import { CanActivateFn } from '@angular/router'; import { AuthService } from './auth.service'; export const authGuard: CanActivateFn = () => { const auth = inject(AuthService); return auth.allowed(); };`;
  const guard = analyzeSource('C:/workspace/auth.guard.ts', guardSource, project);
  const guardSpec = new JestAdapter().generateServiceTest(guard);
  assert.equal(guard.entityType, 'functional-guard'); assert.equal(guard.functional, true);
  assert.match(guardSpec, /TestBed\.runInInjectionContext\(\(\) => authGuard\(\)\)/);
  assert.match(guardSpec, /expect\(authMock\.allowed\)\.toHaveBeenCalled\(\)/);

  const interceptorSource = `import { HttpInterceptorFn } from '@angular/common/http'; export const traceInterceptor: HttpInterceptorFn = (request, next) => next(request);`;
  const interceptor = analyzeSource('C:/workspace/trace.interceptor.ts', interceptorSource, project);
  const interceptorSpec = new JestAdapter().generateServiceTest(interceptor);
  assert.equal(interceptor.entityType, 'functional-interceptor');
  assert.match(interceptorSpec, /traceInterceptor\(request, next\)/);
  assert.match(interceptorSpec, /expect\(next\)\.toHaveBeenCalled\(\)/);

  const resolverSource = `import { ResolveFn } from '@angular/router'; export const itemResolver: ResolveFn<string> = () => 'item';`;
  const resolver = analyzeSource('C:/workspace/item.resolver.ts', resolverSource, project);
  assert.equal(resolver.entityType, 'functional-resolver');

  for (const adapter of [new JasmineKarmaAdapter(), new JestAdapter(), new VitestAdapter()]) {
    const generatedGuard = adapter.generateServiceTest(guard);
    const generatedInterceptor = adapter.generateServiceTest(interceptor);
    const generatedResolver = adapter.generateServiceTest(resolver);
    assert.match(generatedGuard, /TestBed\.runInInjectionContext/);
    assert.match(generatedInterceptor, /traceInterceptor\(request, next\)/);
    assert.match(generatedInterceptor, /import \{ of \} from 'rxjs'/);
    assert.match(generatedInterceptor, /returnValue\(of|mockReturnValue\(of/);
    assert.match(generatedResolver, /itemResolver\(\)/);
  }
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

test('adds runner coverage flags and parses source-specific coverage summaries', () => {
  const jest = resolveTestCommand('C:/workspace', TestRunner.Jest, 'C:/workspace/src/user.spec.ts', undefined, { coverage: true, sourceFile: 'C:/workspace/src/user.ts' });
  assert.ok(jest.args.includes('--coverage')); assert.ok(jest.args.includes('--coverageReporters=json-summary')); assert.ok(jest.args.includes('--collectCoverageFrom=src/user.ts'));
  const vitest = resolveTestCommand('C:/workspace', TestRunner.Vitest, 'C:/workspace/src/user.spec.ts', undefined, { coverage: true });
  assert.ok(vitest.args.includes('--coverage')); assert.ok(vitest.args.includes('--coverage.reporter=json-summary'));
  const karma = resolveTestCommand('C:/workspace', TestRunner.Karma, 'C:/workspace/src/user.spec.ts', undefined, { coverage: true });
  assert.ok(karma.args.includes('--code-coverage'));
  const summary = parseCoverageSummary(JSON.stringify({ total: {}, 'C:/workspace/src/user.ts': { statements: { pct: 100 }, branches: { pct: 75 }, functions: { pct: 80 }, lines: { pct: 90 } } }), 'C:/workspace/src/user.ts');
  assert.deepEqual(summary, { statements: 100, branches: 75, functions: 80, lines: 90, sourceFile: 'C:/workspace/src/user.ts' });
  const detail = parseCoverageDetail(JSON.stringify({ 'C:/workspace/src/user.ts': { statementMap: { '0': { start: { line: 2 } }, '1': { start: { line: 5 } } }, s: { '0': 1, '1': 0 }, fnMap: { '0': { name: 'load', loc: { start: { line: 4 } } } }, f: { '0': 0 }, branchMap: { '0': { loc: { start: { line: 7 } } } }, b: { '0': [1, 0] } } }), 'C:/workspace/src/user.ts');
  assert.deepEqual(detail?.uncoveredLines, [5]);
  assert.deepEqual(detail?.uncoveredFunctions, [{ name: 'load', line: 4 }]);
  assert.deepEqual(detail?.uncoveredBranches, [{ line: 7, indexes: [1] }]);
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

test('plans deterministic repairs for missing mock methods and imported providers', () => {
  const jestSource = `import { ExtraService } from './extra';\nserviceMock = { load: jest.fn() };\nTestBed.configureTestingModule({ providers: [] });`;
  const repaired = repairGeneratedTest(jestSource, `TypeError: serviceMock.save is not a function\nNullInjectorError: No provider for ExtraService!`, TestFramework.Jest)!;
  assert.match(repaired.content, /serviceMock = \{ save: jest\.fn\(\), load:/);
  assert.match(repaired.content, /providers: \[\{ provide: ExtraService, useValue: \{\} \}/);
  assert.deepEqual(repaired.reasons, ['added serviceMock.save', 'added provider ExtraService']);
  const jasmineSource = `serviceMock = jasmine.createSpyObj('service', ['load']);`;
  assert.match(repairGeneratedTest(jasmineSource, 'serviceMock.save is not a function', TestFramework.Jasmine)!.content, /\['load', 'save'\]/);
});

test('feeds uncovered Istanbul locations back into CFG scenarios without application-name rules', () => {
  const source = `@Injectable() export class RatingService { classify(score: number) { if (score >= 10) return 'high'; return 'low'; } }`;
  const context = analyzeSource('C:/workspace/rating.service.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const initial = new JestAdapter().generateServiceTest(context).replace(/\n  describe\('classify control-flow paths'[\s\S]*?\n  \}\);\n/, '\n');
  const line = context.controlFlow.find(flow => flow.methodName === 'classify')!.startLine;
  const feedback = augmentTestForCoverage(initial, context, { statements: 80, branches: 50, functions: 50, lines: 80, sourceFile: context.sourceFile, uncoveredBranches: [{ line, indexes: [1] }], uncoveredFunctions: [{ name: 'classify', line }] });
  assert.ok(feedback);
  assert.ok(feedback!.addedScenarios >= 2);
  assert.match(feedback!.content, /coverage feedback for classify/);
  assert.match(feedback!.content, /expect\(result\)\.toEqual\('high'\)/);
  assert.match(feedback!.content, /expect\(result\)\.toEqual\('low'\)/);
  assert.equal(augmentTestForCoverage(feedback!.content, context, { statements: 80, branches: 50, functions: 50, lines: 80, sourceFile: context.sourceFile, uncoveredFunctions: [{ name: 'classify', line }] }), undefined);
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
    assert.match(spec, /evaluateStatus control-flow paths/);
    assert.match(spec, /evaluateStatus\(-1\)[\s\S]*expect\(subject\.status\)\.toEqual\('error'\)/);
    assert.match(spec, /evaluateStatus\(0\)[\s\S]*expect\(subject\.status\)\.toEqual\('idle'\)/);
    assert.match(spec, /evaluateStatus\(5\)[\s\S]*expect\(subject\.status\)\.toEqual\('success'\)/);
    assert.doesNotMatch(spec, /recalculate active values|batch threshold|successful timer tick/);
    assert.doesNotMatch(spec, /provide: string/);
    assert.doesNotMatch(spec, /subject\.fetchData\(\)\.subscribe/);
  }
});

test('generates exhaustive dialog and XMLHttpRequest download scenarios', () => {
  const source = `import { Component } from '@angular/core';
    import { MatDialog } from '@angular/material/dialog';
    @Component({ standalone: true, template: '' }) export class AplicativoComponent {
      busy = false; percent = 0;
      constructor(private dialog: MatDialog) {}
      ngOnInit() {}
      async transferPackage(primary: boolean) {
        const resourcePath = '/files/mobile.bin';
        const dialogRef = this.dialog.open(Object, { data: primary ? 'Primary' : 'Alternate' });
        dialogRef.afterClosed().subscribe(async result => { if (result) { if (primary) {
          this.busy = true; this.percent = 0;
          try { const xhr = new XMLHttpRequest(); xhr.open('GET', window.location.origin + resourcePath, true); xhr.responseType = 'blob';
            xhr.onprogress = event => { if (event.lengthComputable) this.percent = Math.round((event.loaded / event.total) * 100); };
            xhr.onload = () => { if (xhr.status === 200) { const url = window.URL.createObjectURL(xhr.response); const a = document.createElement('a'); a.href = url; a.download = 'client.bin'; document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); document.body.removeChild(a); } else console.error('Transfer failed:', xhr.statusText); setTimeout(() => this.busy = false, 4321); };
            xhr.onerror = () => { this.busy = false; console.error('Transfer failed:', xhr.statusText); }; xhr.send();
          } catch (error) { this.busy = false; console.error('Transfer failed:', error); }
        } else window.location.href = 'https://fallback.test/app'; } });
      }
    }`;
  for (const [framework, runner, adapter, marker] of [
    [TestFramework.Jasmine, TestRunner.Karma, new JasmineKarmaAdapter(), "jasmine.createSpy('fn')"],
    [TestFramework.Jest, TestRunner.Jest, new JestAdapter(), 'jest.fn()'],
    [TestFramework.Vitest, TestRunner.Vitest, new VitestAdapter(), 'vi.fn()']
  ] as const) {
    const context = analyzeSource('C:/workspace/aplicativo.component.ts', source, diagnostic(framework, runner));
    const spec = adapter.generateComponentTest(context);
    assert.deepEqual(context.browserUsage, { xmlHttpRequest: true, objectUrl: true, dynamicAnchor: true, locationHref: true, timers: true });
    assert.match(spec, /fixture\.detectChanges\(\)/);
    assert.match(spec, /confirmation is cancelled/);
    assert.match(spec, /both progress branches/);
    assert.match(spec, /downloaded link for the success status/);
    assert.match(spec, /non-success and network failures/);
    assert.match(spec, /synchronous XMLHttpRequest failure/);
    assert.match(spec, /alternate redirect branch/);
    assert.match(spec, /subject\.transferPackage/);
    assert.match(spec, /\/files\/mobile\.bin/);
    assert.match(spec, /client\.bin/);
    assert.match(spec, /subject\.percent/);
    assert.match(spec, /subject\.busy/);
    assert.match(spec, /4321/);
    assert.match(spec, /https:\/\/fallback\.test\/app/);
    assert.ok(spec.includes(marker));
  }
});

test('builds generic control-flow metadata and boundary-value scenarios without method-name rules', () => {
  const source = `@Component({ standalone: true, template: '' }) export class ArbitraryComponent {
    result = '';
    async classify(amount: number, label?: string) {
      const normalized = label ?? 'fallback';
      if (amount < 0) this.result = 'negative'; else if (amount === 10) this.result = 'ten'; else this.result = amount > 10 ? 'high' : 'low';
      switch (normalized) { case 'x': this.result += 'x'; break; default: this.result += 'other'; }
      try { return normalized?.trim(); } catch (error) { this.result = 'error'; return error; }
    }
  }`;
  const context = analyzeSource('C:/workspace/arbitrary.component.ts', source, diagnostic(TestFramework.Jest, TestRunner.Jest));
  const flow = context.controlFlow.find(item => item.methodName === 'classify')!;
  assert.ok(flow);
  assert.deepEqual(new Set(flow.decisions.map(item => item.kind)), new Set(['nullish', 'if', 'ternary', 'switch', 'optional-chain', 'catch']));
  assert.ok(flow.parameters[0].candidates.includes('-1'));
  assert.ok(flow.parameters[0].candidates.includes('10'));
  assert.ok(flow.parameters[0].candidates.includes('11'));
  assert.ok(flow.parameters[1].candidates.includes('undefined'));
  const spec = new JestAdapter().generateComponentTest(context);
  assert.match(spec, /classify control-flow paths/);
  assert.match(spec, /\(subject as any\)\.classify\(/);
  assert.doesNotMatch(spec, /expect\(subject\)\.toBeDefined/);
  assert.match(spec, /classify\(-1,[^)]+\)[\s\S]*expect\(subject\.result\)\.toEqual\('negative'\)/);
  assert.match(spec, /classify\(10,[^)]+\)[\s\S]*expect\(subject\.result\)\.toEqual\('ten'\)/);
  assert.match(spec, /classify\(11,[^)]+\)[\s\S]*expect\(subject\.result\)\.toEqual\('high'\)/);
  assert.doesNotMatch(spec, /toContain\(subject\.result\)/);
});
