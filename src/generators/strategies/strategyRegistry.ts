import { GenerationStrategy } from './generationStrategy';
import { xhrDialogStrategy } from './xhrDialogStrategy';

const strategies: GenerationStrategy[] = [xhrDialogStrategy];
export function registeredStrategies(): readonly GenerationStrategy[] { return strategies; }
