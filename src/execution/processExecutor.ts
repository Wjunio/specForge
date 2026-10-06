import { spawn } from 'node:child_process';
import { ResolvedCommand } from './commandResolver';
import { parseTestResult } from '../testing/testResultParser';
import { TestResult } from '../types';

export function executeTest(command: ResolvedCommand, cwd: string, timeoutMs = 180_000): Promise<TestResult> {
  return new Promise(resolve => {
    const started = Date.now(); let output = ''; let settled = false;
    const child = spawn(command.executable, command.args, { cwd, shell: false, windowsHide: true, env: { ...process.env, CI: 'true' } });
    const append = (chunk: unknown) => { output = (output + String(chunk)).slice(-100_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const finish = (code: number | undefined, suffix = '') => { if (settled) return; settled = true; clearTimeout(timer); resolve(parseTestResult(`${output}${suffix}`, code, command.display, Date.now() - started)); };
    const timer = setTimeout(() => { child.kill(); finish(undefined, `\nExecution timed out after ${timeoutMs}ms.`); }, timeoutMs);
    child.on('error', error => finish(undefined, `\n${error.message}`));
    child.on('close', code => finish(code ?? undefined));
  });
}
