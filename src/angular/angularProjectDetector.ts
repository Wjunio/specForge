import { detectAngularArchitecture } from './angularArchitectureDetector';
import { detectAngularVersions } from './angularVersionDetector';
import { AngularProjectInfo, PackageManager } from '../types';
import { packageName } from '../utils/packageUtils';

export interface AngularProjectDetectionInput {
  packageJson: string;
  angularJson: string;
  sources: string[];
  installedPackages?: Record<string, string>;
  workspace: string;
  fallbackName?: string;
  packageManager?: PackageManager;
}

export function detectAngularProject(input: AngularProjectDetectionInput): AngularProjectInfo {
  const versions = detectAngularVersions(input.packageJson, input.installedPackages);
  const architecture = detectAngularArchitecture(input.sources);
  const isAngular = Boolean(versions.angular || input.angularJson.trim() || input.sources.some(source => /from\s+['"]@angular\//.test(source)));
  return {
    isAngular, name: packageName(input.packageJson) ?? input.fallbackName, workspace: input.workspace,
    angularVersion: versions.angular, cliVersion: versions.cli, typescriptVersion: versions.typescript,
    architecture: architecture.architecture, primaryArchitecture: architecture.primary,
    componentsAnalyzed: architecture.componentsAnalyzed, ngModulesAnalyzed: architecture.ngModulesAnalyzed,
    packageManager: input.packageManager,
    evidence: [...(versions.angular ? [`@angular/core ${versions.angular}`] : []), ...(input.angularJson ? ['angular.json'] : []),
      ...(architecture.architecture !== 'unknown' ? [`${architecture.architecture} decorators`] : [])]
  };
}
