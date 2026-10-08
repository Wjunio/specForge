import { TestGenerationContext } from '../../types';
import type { FrameworkSyntax } from '../testGenerator';

export interface GenerationStrategy {
  readonly id: string;
  applies(context: TestGenerationContext): boolean;
  requiresRxjsOf?(context: TestGenerationContext): boolean;
  append(lines: string[], context: TestGenerationContext, syntax: FrameworkSyntax): void;
}
