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

export type EntityType = 'component' | 'service';
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
  isPublic: boolean;
  dependencyCalls: Array<{ dependency: string; method: string; deferred: boolean }>;
}
export interface PropertyInfo { name: string; initializer?: string; isPublic: boolean }
export interface HttpUsageInfo {
  methodName: string;
  httpMethod: string;
  urls: string[];
  subscribesInternally: boolean;
}
export interface TestGenerationContext {
  diagnostic: ProjectDiagnostic;
  sourceFile: string;
  sourceCode: string;
  entityType: EntityType;
  className: string;
  standalone: boolean;
  dependencies: DependencyInfo[];
  methods: MethodInfo[];
  properties: PropertyInfo[];
  httpUsage: HttpUsageInfo[];
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
}
