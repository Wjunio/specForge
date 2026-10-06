import { AngularArchitecture, ProjectDiagnostic, TestFramework, TestRunner } from './types';

export function formatDiagnostic(diagnostic: ProjectDiagnostic): string {
  const { project, testing } = diagnostic;
  const active = testing.activeFramework;
  const lines = ['SpecForge Test Configuration', '', 'Project', `  Name: ${project.name ?? 'Not detected'}`, `  Workspace: ${project.workspace}`, '',
    'Angular', `  Version: ${project.angularVersion ?? 'Not detected'}`, `  CLI: ${project.cliVersion ?? 'Not detected'}`, '',
    'TypeScript', `  Version: ${project.typescriptVersion ?? 'Not detected'}`, '',
    'Architecture', `  Primary: ${architectureName(project.primaryArchitecture)}`, `  Detected: ${architectureName(project.architecture)}`,
    `  Components analyzed: ${project.componentsAnalyzed}`, `  NgModules analyzed: ${project.ngModulesAnalyzed}`, ''];
  if (testing.frameworks.length > 1) {
    lines.push('Detected Test Frameworks', ...testing.frameworks.map(item => `  • ${frameworkName(item.framework)} (${item.confidence} confidence)`), '');
  }
  lines.push('Testing', `  Framework: ${active ? frameworkName(active.framework) : 'Not determined'}`, `  Runner: ${active ? runnerName(active.runner) : 'Not determined'}`, '');
  lines.push('Configuration', `  Config: ${active?.configFiles.join(', ') || testing.frameworks.flatMap(item => item.configFiles).join(', ') || 'Not detected'}`, `  Package manager: ${project.packageManager ?? 'Not detected'}`, '');
  for (const item of testing.frameworks) {
    lines.push(`${frameworkName(item.framework)} evidence`, `  Confidence: ${item.confidence}`, ...item.evidence.map(value => `  • ${value}`), '');
  }
  lines.push('Status', `  Project detected: ${mark(project.isAngular)}`, `  Angular detected: ${mark(Boolean(project.angularVersion))}`,
    `  Architecture detected: ${mark(project.architecture !== AngularArchitecture.Unknown)}`, `  Test framework detected: ${mark(Boolean(active))}`, `  Test runner detected: ${mark(Boolean(active && active.runner !== TestRunner.Unknown))}`);
  if (!active) lines.push('', 'Action', '  Select a testing framework before generating tests.');
  return lines.join('\n');
}

function mark(value: boolean): string { return value ? '✓' : '✗'; }
function architectureName(value: AngularArchitecture): string { return value === AngularArchitecture.NgModule ? 'NgModule' : value[0].toUpperCase() + value.slice(1); }
function frameworkName(value: TestFramework): string { return value === TestFramework.Jest ? 'Jest' : value === TestFramework.Vitest ? 'Vitest' : value === TestFramework.Jasmine ? 'Jasmine' : 'Unknown'; }
function runnerName(value: TestRunner): string { return value === TestRunner.Karma ? 'Karma' : value === TestRunner.Jest ? 'Jest' : value === TestRunner.Vitest ? 'Vitest' : 'Unknown'; }
