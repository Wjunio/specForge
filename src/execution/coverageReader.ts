import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { CoverageMetrics } from '../types';

export function parseCoverageSummary(content: string, sourceFile: string): CoverageMetrics | undefined {
  const report = JSON.parse(content) as Record<string, { statements?: { pct?: number }; branches?: { pct?: number }; functions?: { pct?: number }; lines?: { pct?: number } }>;
  const target = normalize(sourceFile);
  const entry = Object.entries(report).find(([name]) => name !== 'total' && (normalize(name) === target || target.endsWith(normalize(name)) || normalize(name).endsWith(path.basename(target))))?.[1];
  if (!entry) return undefined;
  return { statements: entry.statements?.pct ?? 0, branches: entry.branches?.pct ?? 0, functions: entry.functions?.pct ?? 0, lines: entry.lines?.pct ?? 0, sourceFile };
}

export async function readCoverageSummary(workspace: string, sourceFile: string): Promise<CoverageMetrics | undefined> {
  const root = path.join(workspace, 'coverage');
  for (const file of await findSummaries(root)) {
    const metrics = parseCoverageSummary(await fs.readFile(file, 'utf8'), sourceFile);
    if (metrics) {
      const detail = await findCoverageDetail(root, sourceFile);
      return detail ? { ...metrics, ...detail } : metrics;
    }
  }
  return undefined;
}

export function parseCoverageDetail(content: string, sourceFile: string): Pick<CoverageMetrics, 'uncoveredLines' | 'uncoveredFunctions' | 'uncoveredBranches'> | undefined {
  type Location = { start: { line: number } };
  type Entry = { statementMap: Record<string, Location>; s: Record<string, number>; fnMap: Record<string, { name: string; loc: Location }>; f: Record<string, number>; branchMap: Record<string, { loc: Location }>; b: Record<string, number[]> };
  const report = JSON.parse(content) as Record<string, Entry>;
  const target = normalize(sourceFile);
  const entry = Object.entries(report).find(([name]) => normalize(name) === target || target.endsWith(normalize(name)) || normalize(name).endsWith(path.basename(target)))?.[1];
  if (!entry) return undefined;
  const uncoveredLines = [...new Set(Object.entries(entry.s ?? {}).filter(([, hits]) => hits === 0).map(([id]) => entry.statementMap[id]?.start.line).filter((line): line is number => line !== undefined))].sort((a, b) => a - b);
  const uncoveredFunctions = Object.entries(entry.f ?? {}).filter(([, hits]) => hits === 0).map(([id]) => ({ name: entry.fnMap[id]?.name ?? id, line: entry.fnMap[id]?.loc.start.line ?? 0 }));
  const uncoveredBranches = Object.entries(entry.b ?? {}).flatMap(([id, hits]) => { const indexes = hits.map((count, index) => count === 0 ? index : -1).filter(index => index >= 0); return indexes.length ? [{ line: entry.branchMap[id]?.loc.start.line ?? 0, indexes }] : []; });
  return { uncoveredLines, uncoveredFunctions, uncoveredBranches };
}

async function findCoverageDetail(root: string, sourceFile: string): Promise<ReturnType<typeof parseCoverageDetail>> {
  for (const file of await findNamedFiles(root, 'coverage-final.json')) { const detail = parseCoverageDetail(await fs.readFile(file, 'utf8'), sourceFile); if (detail) return detail; }
  return undefined;
}

async function findSummaries(directory: string): Promise<string[]> {
  return findNamedFiles(directory, 'coverage-summary.json');
}
async function findNamedFiles(directory: string, filename: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true }); const output: string[] = [];
    for (const entry of entries) { const target = path.join(directory, entry.name); if (entry.isDirectory()) output.push(...await findNamedFiles(target, filename)); else if (entry.name === filename) output.push(target); }
    return output;
  } catch { return []; }
}
function normalize(value: string): string { return path.resolve(value).replace(/\\/g, '/').toLowerCase(); }
