import { solveFlowScenarios } from '../analysis/controlFlowAnalyzer';
import { CoverageMetrics, TestGenerationContext } from '../types';

export interface CoverageFeedbackResult { content: string; addedScenarios: number; methods: string[] }

export function augmentTestForCoverage(content: string, context: TestGenerationContext, coverage: CoverageMetrics): CoverageFeedbackResult | undefined {
  if (context.functional) return undefined;
  const uncoveredNames = new Set(coverage.uncoveredFunctions?.map(item => item.name) ?? []);
  const uncoveredLines = new Set([...(coverage.uncoveredLines ?? []), ...(coverage.uncoveredBranches ?? []).map(item => item.line)]);
  const flows = context.controlFlow.filter(flow => uncoveredNames.has(flow.methodName) || [...uncoveredLines].some(line => line >= flow.startLine && line <= flow.endLine));
  const blocks: string[] = [];
  const methods: string[] = [];
  for (const flow of flows) {
    const marker = `coverage feedback for ${flow.methodName}`;
    if (content.includes(marker)) continue;
    const scenarios = solveFlowScenarios(flow);
    if (!scenarios.length) continue;
    methods.push(flow.methodName);
    scenarios.forEach((scenario, index) => {
      const invocation = `(subject as any).${flow.methodName}(${scenario.arguments.join(', ')})`;
      blocks.push('', `  it('${marker} path ${index + 1}', ${flow.async ? 'async ' : ''}() => {`, `    const result = ${flow.async ? `await ${invocation}` : invocation};`);
      const returned = scenario.effects.find(effect => effect.kind === 'return');
      if (returned?.kind === 'return') blocks.push(`    expect(result).toEqual(${returned.values[0]});`);
      for (const effect of scenario.effects) {
        if (effect.kind === 'property-write') blocks.push(`    expect(subject.${effect.property}).toEqual(${effect.values[0]});`);
        if (effect.kind === 'dependency-call' && context.dependencies.some(dependency => dependency.name === effect.dependency)) blocks.push(`    expect(${effect.dependency}Mock.${effect.method}).toHaveBeenCalled();`);
      }
      if (!returned && !scenario.effects.some(effect => effect.kind === 'property-write' || effect.kind === 'dependency-call')) blocks.push('    expect(result).toBeUndefined();');
      blocks.push('  });');
    });
  }
  if (!blocks.length) return undefined;
  const closing = content.lastIndexOf('});');
  if (closing < 0) return undefined;
  return { content: `${content.slice(0, closing)}${blocks.join('\n')}\n${content.slice(closing)}`, addedScenarios: blocks.filter(line => /^  it\(/.test(line)).length, methods };
}
