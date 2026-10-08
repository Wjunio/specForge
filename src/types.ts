export enum AngularArchitecture { NgModule = 'ng-module', Standalone = 'standalone', Mixed = 'mixed', Unknown = 'unknown' }
export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';
export enum TestFramework { Jasmine = 'jasmine', Jest = 'jest', Vitest = 'vitest', Unknown = 'unknown' }
export enum TestRunner { Karma = 'karma', Jest = 'jest', Vitest = 'vitest', Unknown = 'unknown' }
export type DetectionConfidence = 'high' | 'medium' | 'low';

export interface AngularProjectInfo {
  isAngular: boolean;
  name?: string;
  workspace: string;
  angularVersion?: string;
  cliVersion?: string;
  typescriptVersion?: string;
  architecture: AngularArchitecture;
  primaryArchitecture: AngularArchitecture;
  componentsAnalyzed: number;
  ngModulesAnalyzed: number;
  packageManager?: PackageManager;
  evidence: string[];
}

export interface TestFrameworkInfo {
  framework: TestFramework;
  runner: TestRunner;
  version?: string;
  confidence: DetectionConfidence;
  configFiles: string[];
  detectedPackages: string[];
  evidence: string[];
}

export interface TestEnvironmentInfo { frameworks: TestFrameworkInfo[]; activeFramework?: TestFrameworkInfo }
export interface ProjectDiagnostic { project: AngularProjectInfo; testing: TestEnvironmentInfo }

export type EntityType = 'component' | 'service' | 'pipe' | 'guard' | 'functional-guard' | 'functional-resolver' | 'functional-interceptor';
export interface DependencyInfo {
  name: string;
  type: string;
  providerToken: string;
  importPath?: string;
  optional: boolean;
  methods: string[];
  observableMethods: string[];
}
export interface MethodInfo {
  name: string;
  parameterCount: number;
  parameterNames: string[];
  isPublic: boolean;
  dependencyCalls: Array<{ dependency: string; method: string; deferred: boolean }>;
  signalOperations: Array<{ signal: string; operation: 'set' | 'toggle'; value?: string }>;
}
export interface PropertyInfo {
  name: string;
  initializer?: string;
  isPublic: boolean;
  signalInitialValue?: string;
  computedExpression?: string;
  computedDependencies?: string[];
  effectDependencies?: string[];
  effectWrites?: Array<{ property: string; expression: string }>;
  effectHasCleanup?: boolean;
  formValues?: Record<string, string>;
}
export interface HttpUsageInfo {
  methodName: string;
  httpMethod: string;
  urls: string[];
  subscribesInternally: boolean;
  handlesError: boolean;
  mockResponse: string;
}
export interface XhrDownloadFlowInfo {
  methodName: string;
  parameterName?: string;
  httpMethod?: string;
  successStatus?: number;
  path?: string;
  downloadName?: string;
  loadingProperty?: string;
  progressProperty?: string;
  timeoutMs?: number;
  redirectUrl?: string;
  errorPrefix?: string;
  dialogDependency?: string;
}
export interface FlowDecisionInfo { expression: string; kind: 'if' | 'switch' | 'ternary' | 'nullish' | 'optional-chain' | 'catch'; outcomes: string[] }
export interface FlowConstraintInfo { expression: string; outcome: boolean }
export type FlowEffectInfo =
  | { kind: 'property-write'; property: string; values: string[]; constraints: FlowConstraintInfo[] }
  | { kind: 'return'; values: string[]; constraints: FlowConstraintInfo[] }
  | { kind: 'throw'; values: string[]; constraints: FlowConstraintInfo[] }
  | { kind: 'dependency-call'; dependency: string; method: string; arguments: string[]; constraints: FlowConstraintInfo[] };
export interface FlowScenarioInfo { arguments: string[]; effects: FlowEffectInfo[]; constraints: FlowConstraintInfo[] }
export interface TemplateUsageInfo { events: string[]; invokedMethods: string[]; inputs: string[]; outputs: string[]; formControls: string[] }
export interface MethodFlowInfo {
  methodName: string;
  startLine: number;
  endLine: number;
  parameters: Array<{ name: string; type?: string; optional: boolean; candidates: string[] }>;
  decisions: FlowDecisionInfo[];
  effects: FlowEffectInfo[];
  async: boolean;
  leafCount: number;
}
export interface TestGenerationContext {
  diagnostic: ProjectDiagnostic;
  sourceFile: string;
  sourceCode: string;
  entityType: EntityType;
  className: string;
  functional: boolean;
  standalone: boolean;
  dependencies: DependencyInfo[];
  methods: MethodInfo[];
  properties: PropertyInfo[];
  httpUsage: HttpUsageInfo[];
  browserUsage: { xmlHttpRequest: boolean; objectUrl: boolean; dynamicAnchor: boolean; locationHref: boolean; timers: boolean };
  xhrDownloadFlows: XhrDownloadFlowInfo[];
  controlFlow: MethodFlowInfo[];
  lifecycles: string[];
  templateUsage?: TemplateUsageInfo;
}

export type TestErrorKind = 'compilation' | 'runtime' | 'assertion' | 'configuration' | 'environment';
export interface TestError { kind: TestErrorKind; message: string }
export interface TestResult {
  success: boolean;
  exitCode?: number;
  passed: number;
  failed: number;
  skipped: number;
  duration?: number;
  compilationErrors: TestError[];
  runtimeErrors: TestError[];
  output: string;
  command: string;
  coverage?: CoverageMetrics;
}
export interface CoverageMetrics {
  statements: number; branches: number; functions: number; lines: number; sourceFile: string;
  uncoveredLines?: number[];
  uncoveredFunctions?: Array<{ name: string; line: number }>;
  uncoveredBranches?: Array<{ line: number; indexes: number[] }>;
}
