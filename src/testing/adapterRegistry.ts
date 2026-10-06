import { TestFramework } from '../types';
import { JasmineKarmaAdapter } from './jasmineKarmaAdapter';
import { JestAdapter } from './jestAdapter';
import { TestFrameworkAdapter } from './testFrameworkAdapter';
import { VitestAdapter } from './vitestAdapter';

const adapters: TestFrameworkAdapter[] = [new JasmineKarmaAdapter(), new JestAdapter(), new VitestAdapter()];
export function adapterFor(framework: TestFramework): TestFrameworkAdapter {
  const adapter = adapters.find(item => item.framework === framework);
  if (!adapter) throw new Error(`Framework ${framework} não possui adapter de geração.`);
  return adapter;
}
