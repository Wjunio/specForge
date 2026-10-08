import * as path from 'node:path';
import { TestRunner } from '../types';

export interface ResolvedCommand { executable: string; args: string[]; display: string }

export function resolveTestCommand(workspace: string, runner: TestRunner, specFile: string, testName?: string, options?: { coverage?: boolean; sourceFile?: string }): ResolvedCommand {
  const root = path.resolve(workspace); const spec = path.resolve(specFile);
  if (spec !== root && !spec.startsWith(`${root}${path.sep}`)) throw new Error('O arquivo de teste está fora do workspace.');
  const relativeSpec = path.relative(root, spec).replace(/\\/g, '/');
  let entry: string; let args: string[];
  if (runner === TestRunner.Jest) { entry = path.join(root, 'node_modules', 'jest', 'bin', 'jest.js'); args = [relativeSpec, '--runInBand', '--no-cache', ...(options?.coverage ? ['--coverage', '--coverageReporters=json-summary', '--coverageReporters=json', ...(options.sourceFile ? [`--collectCoverageFrom=${path.relative(root, options.sourceFile).replace(/\\/g, '/')}`] : [])] : []), ...(testName ? ['--testNamePattern', testName] : [])]; }
  else if (runner === TestRunner.Vitest) { entry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs'); args = ['run', relativeSpec, ...(options?.coverage ? ['--coverage', '--coverage.reporter=json-summary', '--coverage.reporter=json'] : []), ...(testName ? ['-t', testName] : [])]; }
  else if (runner === TestRunner.Karma) { entry = path.join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'); args = ['test', '--watch=false', '--browsers=ChromeHeadless', '--include', relativeSpec, ...(options?.coverage ? ['--code-coverage'] : [])]; }
  else throw new Error('O runner ativo não foi determinado.');
  return { executable: process.execPath, args: [entry, ...args], display: `node ${[entry, ...args].map(quote).join(' ')}` };
}
function quote(value: string): string { return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value; }
