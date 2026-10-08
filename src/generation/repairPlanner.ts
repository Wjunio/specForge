import { TestFramework } from '../types';

export interface RepairResult { content: string; reasons: string[] }

export function repairGeneratedTest(content: string, output: string, framework: TestFramework): RepairResult | undefined {
  let repaired = content; const reasons: string[] = [];
  for (const match of output.matchAll(/\b([A-Za-z_$][\w$]*)Mock\.([A-Za-z_$][\w$]*)\s+is not a function/g)) {
    const [, mock, method] = match;
    const next = addMockMethod(repaired, mock, method, framework);
    if (next !== repaired) { repaired = next; reasons.push(`added ${mock}Mock.${method}`); }
  }
  for (const match of output.matchAll(/NullInjectorError[^\r\n]*No provider for\s+([A-Za-z_$][\w$]*)/g)) {
    const token = match[1];
    if (!new RegExp(`import\\s*\\{[^}]*\\b${escapeRegExp(token)}\\b[^}]*}`).test(repaired)) continue;
    const provider = `{ provide: ${token}, useValue: {} }`;
    if (repaired.includes(provider)) continue;
    const next = repaired.replace(/providers:\s*\[/, `providers: [${provider}, `);
    if (next !== repaired) { repaired = next; reasons.push(`added provider ${token}`); }
  }
  return reasons.length ? { content: repaired, reasons } : undefined;
}

function addMockMethod(content: string, mock: string, method: string, framework: TestFramework): string {
  if (framework === TestFramework.Jasmine) {
    const pattern = new RegExp(`(${escapeRegExp(mock)}Mock\\s*=\\s*jasmine\\.createSpyObj\\([^,]+,\\s*\\[)([^\\]]*)(\\])`);
    return content.replace(pattern, (_all, start: string, methods: string, end: string) => `${start}${methods.trim() ? `${methods}, ` : ''}'${method}'${end}`);
  }
  const factory = framework === TestFramework.Vitest ? 'vi.fn()' : 'jest.fn()';
  const pattern = new RegExp(`(${escapeRegExp(mock)}Mock\\s*=\\s*\\{\\s*)`);
  return content.replace(pattern, `$1${method}: ${factory}, `);
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
