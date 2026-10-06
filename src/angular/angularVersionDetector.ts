export interface AngularVersions { angular?: string; cli?: string; typescript?: string }

export function detectAngularVersions(packageJson: string, installedPackages: Record<string, string> = {}): AngularVersions {
  const pkg = parsePackage(packageJson);
  const dependencies = { ...record(pkg.dependencies), ...record(pkg.devDependencies), ...record(pkg.peerDependencies), ...record(pkg.optionalDependencies) };
  return {
    angular: normalizeVersion(installedPackages['@angular/core'] ?? dependency(dependencies, '@angular/core')),
    cli: normalizeVersion(installedPackages['@angular/cli'] ?? dependency(dependencies, '@angular/cli')),
    typescript: normalizeVersion(installedPackages.typescript ?? dependency(dependencies, 'typescript'))
  };
}

export function parsePackage(packageJson: string): Record<string, unknown> {
  try { return JSON.parse(packageJson || '{}') as Record<string, unknown>; } catch { return {}; }
}
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function dependency(dependencies: Record<string, unknown>, name: string): string | undefined { return typeof dependencies[name] === 'string' ? dependencies[name] as string : undefined; }
import { normalizeVersion } from '../utils/versionUtils';

