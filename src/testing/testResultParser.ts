import { TestError, TestResult } from '../types';

export function parseTestResult(output: string, exitCode: number | undefined, command: string, duration: number): TestResult {
  const compilationErrors = collect(output, /(?:error TS\d+[^\r\n]*|TS\d+:[^\r\n]*)/gi, 'compilation');
  const runtimeErrors = [
    ...collect(output, /NullInjectorError[^\r\n]*/gi, 'runtime'),
    ...collect(output, /(?:Expected|expect\()[^\r\n]*(?:Received|toBe|toEqual|toHaveBeen)[^\r\n]*/gi, 'assertion'),
    ...collect(output, /(?:Cannot find module|No test files found|configuration error)[^\r\n]*/gi, 'configuration')
  ];
  const passed = count(output, /(?:Tests?|Test Files?)\s*:?\s*(\d+)\s+passed/i);
  const failed = count(output, /(?:Tests?|Test Files?)\s*:?\s*(\d+)\s+failed/i);
  const skipped = count(output, /(?:Tests?|Test Files?)\s*:?\s*(\d+)\s+(?:skipped|pending)/i);
  if (exitCode !== 0 && !compilationErrors.length && !runtimeErrors.length) runtimeErrors.push({ kind: 'environment', message: lastMeaningfulLine(output) || `Runner exited with code ${exitCode}.` });
  return { success: exitCode === 0, exitCode, passed, failed, skipped, duration, compilationErrors, runtimeErrors, output, command };
}
function collect(output: string, pattern: RegExp, kind: TestError['kind']): TestError[] { return [...output.matchAll(pattern)].map(match => ({ kind, message: match[0] })); }
function count(output: string, pattern: RegExp): number { return Number(output.match(pattern)?.[1] ?? 0); }
function lastMeaningfulLine(output: string): string | undefined { return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1); }
