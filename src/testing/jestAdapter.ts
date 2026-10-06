import { generateAngularTest } from '../generators/testGenerator';
import { TestFramework, TestGenerationContext } from '../types';
import { detectTestEnvironment, TestDetectionInput } from './testFrameworkDetector';
import { TestFrameworkAdapter } from './testFrameworkAdapter';
export class JestAdapter implements TestFrameworkAdapter {
  readonly framework = TestFramework.Jest;
  detect(input: TestDetectionInput) { return detectTestEnvironment(input).frameworks.find(item => item.framework === this.framework); }
  generateComponentTest(context: TestGenerationContext) { return generateAngularTest(context, { mock: (_name, methods, observableMethods) => `{ ${methods.map(method => `${method}: jest.fn()${observableMethods.includes(method) ? '.mockReturnValue(of([]))' : ''}`).join(', ')} }`, timers: { install: 'jest.useFakeTimers();', advance: milliseconds => `jest.advanceTimersByTime(${milliseconds});`, uninstall: 'jest.useRealTimers();' } }); }
  generateServiceTest(context: TestGenerationContext) { return this.generateComponentTest(context); }
}
