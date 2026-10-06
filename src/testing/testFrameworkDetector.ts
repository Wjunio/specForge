import { parsePackage, record } from '../angular/angularVersionDetector';
import { DetectionConfidence, TestEnvironmentInfo, TestFramework, TestFrameworkInfo, TestRunner } from '../types';
import { allDependencies } from '../utils/packageUtils';
import { normalizeVersion } from '../utils/versionUtils';

export interface TestDetectionInput {
  packageJson: string;
  angularJson: string;
  configFiles: string[];
  installedPackages?: Record<string, string>;
  sourceEvidence?: string;
}

interface Definition { framework: TestFramework; runner: TestRunner; packages: string[]; configs: RegExp; script: RegExp; source: RegExp; angular: RegExp }
const DEFINITIONS: Definition[] = [
  { framework: TestFramework.Jasmine, runner: TestRunner.Karma, packages: ['jasmine-core', '@types/jasmine', 'karma', 'karma-jasmine'], configs: /^karma\.conf\.[cm]?[jt]s$/i, script: /(?:ng\s+test|\bkarma\b)/i, source: /\b(?:jasmine\.|spyOn\s*\()/, angular: /@angular-devkit\/build-angular:karma|"builder"\s*:\s*"[^"]*karma/i },
  { framework: TestFramework.Jest, runner: TestRunner.Jest, packages: ['jest', 'jest-preset-angular', '@types/jest'], configs: /^jest\.config\.(?:js|cjs|mjs|ts|json)$/i, script: /\bjest\b/i, source: /\bjest\.(?:fn|mock|spyOn)\b|from\s+['"]@jest\/globals['"]/, angular: /"builder"\s*:\s*"[^"]*jest/i },
  { framework: TestFramework.Vitest, runner: TestRunner.Vitest, packages: ['vitest', '@analogjs/vitest-angular'], configs: /^vitest\.config\.(?:js|mjs|ts)$/i, script: /\bvitest\b/i, source: /\bvi\.(?:fn|mock|spyOn)\b|from\s+['"]vitest['"]/, angular: /"builder"\s*:\s*"[^"]*vitest/i }
];

export function detectTestEnvironment(input: TestDetectionInput): TestEnvironmentInfo {
  const pkg = parsePackage(input.packageJson); const dependencies = allDependencies(input.packageJson);
  const scripts = Object.values(record(pkg.scripts)).filter((value): value is string => typeof value === 'string').join('\n');
  const installed = input.installedPackages ?? {};
  const scored = DEFINITIONS.map(definition => detectOne(definition, dependencies, installed, scripts, input)).filter((item): item is TestFrameworkInfo & { score: number } => Boolean(item));
  const frameworks = scored.map(({ score: _score, ...framework }) => framework);
  const high = scored.filter(item => item.confidence === 'high');
  const active = high.length === 1 ? frameworks.find(item => item.framework === high[0].framework)
    : scored.length === 1 && scored[0].confidence !== 'low' ? frameworks[0] : undefined;
  return { frameworks, activeFramework: active };
}

function detectOne(definition: Definition, dependencies: Record<string, unknown>, installed: Record<string, string>, scripts: string, input: TestDetectionInput): (TestFrameworkInfo & { score: number }) | undefined {
  let score = 0; const evidence: string[] = []; const detectedPackages: string[] = [];
  for (const name of definition.packages) {
    if (typeof dependencies[name] === 'string' || installed[name]) {
      detectedPackages.push(name); score += installed[name] ? 2 : 1;
      evidence.push(`${name} ${installed[name] ? 'installed package' : 'dependency'}`);
    }
  }
  const configFiles = input.configFiles.filter(file => definition.configs.test(file.split(/[\\/]/).pop() ?? file));
  if (configFiles.length) { score += 4; evidence.push(...configFiles); }
  if (definition.script.test(scripts)) { score += 4; evidence.push(`test script uses ${definition.framework}`); }
  if (definition.angular.test(input.angularJson)) { score += 4; evidence.push(`angular.json uses ${definition.runner} builder`); }
  if (definition.source.test(input.sourceEvidence ?? '')) { score += 3; evidence.push(`TypeScript code uses ${definition.framework} APIs`); }
  if (!score) return undefined;
  const versionPackage = definition.framework === TestFramework.Jasmine ? 'jasmine-core' : definition.framework;
  const rawVersion = installed[versionPackage] ?? (typeof dependencies[versionPackage] === 'string' ? dependencies[versionPackage] as string : undefined);
  const runner = definition.framework === TestFramework.Jasmine && !hasKarmaEvidence(dependencies, installed, scripts, input.angularJson, configFiles)
    ? TestRunner.Unknown : definition.runner;
  if (definition.framework === TestFramework.Jasmine && runner === TestRunner.Unknown) evidence.push('Jasmine detected without a confirmed runner');
  return { framework: definition.framework, runner, version: normalizeVersion(rawVersion), confidence: confidence(score), configFiles, detectedPackages, evidence, score };
}

function confidence(score: number): DetectionConfidence { return score >= 5 ? 'high' : score >= 3 ? 'medium' : 'low'; }
function hasKarmaEvidence(dependencies: Record<string, unknown>, installed: Record<string, string>, scripts: string, angularJson: string, configFiles: string[]): boolean {
  return ['karma', 'karma-jasmine'].some(name => typeof dependencies[name] === 'string' || Boolean(installed[name]))
    || configFiles.some(file => /karma\.conf\./i.test(file)) || /(?:ng\s+test|\bkarma\b)/i.test(scripts)
    || /@angular-devkit\/build-angular:karma|"builder"\s*:\s*"[^"]*karma/i.test(angularJson);
}
