import { generateAngularTest } from '../generators/testGenerator';
import { TestFramework, TestGenerationContext } from '../types';
import { detectTestEnvironment, TestDetectionInput } from './testFrameworkDetector';
import { TestFrameworkAdapter } from './testFrameworkAdapter';
export class JasmineKarmaAdapter implements TestFrameworkAdapter {
  readonly framework = TestFramework.Jasmine;
  detect(input: TestDetectionInput) { return detectTestEnvironment(input).frameworks.find(item => item.framework === this.framework); }
  generateComponentTest(context: TestGenerationContext) { return generateAngularTest(context, { kind: 'jasmine', mock: (name, methods) => methods.length ? `jasmine.createSpyObj('${name}', [${methods.map(method => `'${method}'`).join(', ')}])` : '{}', configureObservableMock: (name, method) => `${name}Mock.${method}.and.returnValue(of([]));`, timers: { install: 'jasmine.clock().install();', advance: milliseconds => `jasmine.clock().tick(${milliseconds});`, uninstall: 'jasmine.clock().uninstall();' } }); }
  generateServiceTest(context: TestGenerationContext) { return this.generateComponentTest(context); }
}
