import { generateAngularTest } from '../generators/testGenerator';
import { TestFramework, TestGenerationContext } from '../types';
import { detectTestEnvironment, TestDetectionInput } from './testFrameworkDetector';
import { TestFrameworkAdapter } from './testFrameworkAdapter';
export class VitestAdapter implements TestFrameworkAdapter {
  readonly framework = TestFramework.Vitest;
  detect(input: TestDetectionInput) { return detectTestEnvironment(input).frameworks.find(item => item.framework === this.framework); }
  generateComponentTest(context: TestGenerationContext) { return generateAngularTest(context, { globalsImport: "import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';", mock: (_name, methods, observableMethods) => `{ ${methods.map(method => `${method}: vi.fn()${observableMethods.includes(method) ? '.mockReturnValue(of([]))' : ''}`).join(', ')} }`, timers: { install: 'vi.useFakeTimers();', advance: milliseconds => `vi.advanceTimersByTime(${milliseconds});`, uninstall: 'vi.useRealTimers();' } }); }
  generateServiceTest(context: TestGenerationContext) { return this.generateComponentTest(context); }
}
