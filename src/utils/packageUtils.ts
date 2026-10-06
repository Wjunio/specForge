import { parsePackage, record } from '../angular/angularVersionDetector';

export function allDependencies(packageJson: string): Record<string, unknown> {
  const pkg = parsePackage(packageJson);
  return { ...record(pkg.dependencies), ...record(pkg.devDependencies), ...record(pkg.peerDependencies), ...record(pkg.optionalDependencies) };
}

export function packageName(packageJson: string): string | undefined {
  const name = parsePackage(packageJson).name;
  return typeof name === 'string' ? name : undefined;
}
