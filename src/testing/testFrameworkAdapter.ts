import { TestFramework, TestFrameworkInfo, TestGenerationContext } from '../types';
import { TestDetectionInput } from './testFrameworkDetector';

export interface TestFrameworkAdapter {
  readonly framework: TestFramework;
  detect(input: TestDetectionInput): TestFrameworkInfo | undefined;
  generateComponentTest(context: TestGenerationContext): string;
  generateServiceTest(context: TestGenerationContext): string;
}
