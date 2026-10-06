import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectAngularProject } from './angular/angularProjectDetector';
import { parsePackage } from './angular/angularVersionDetector';
import { detectTestEnvironment } from './testing/testFrameworkDetector';
import { PackageManager, ProjectDiagnostic } from './types';

const CONFIG_PATTERNS = ['karma.conf.js', 'karma.conf.ts', 'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.json', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts'];
const VERSION_PACKAGES = ['@angular/core', '@angular/cli', 'typescript', 'jasmine-core', '@types/jasmine', 'karma', 'karma-jasmine', 'jest', 'jest-preset-angular', '@types/jest', 'vitest', '@analogjs/vitest-angular'];

export async function discoverProject(folder: vscode.WorkspaceFolder): Promise<ProjectDiagnostic> {
  const packageJson = await readOptional(vscode.Uri.joinPath(folder.uri, 'package.json')) ?? '{}';
  const angularJson = await readOptional(vscode.Uri.joinPath(folder.uri, 'angular.json')) ?? '';
  const configUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/{${CONFIG_PATTERNS.join(',')}}`), new vscode.RelativePattern(folder, '{node_modules,dist,coverage,.angular}/**'), 100);
  const configFiles = configUris.map(uri => path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/'));
  const installedPackages: Record<string, string> = {};
  for (const packageName of VERSION_PACKAGES) {
    const installedManifest = await readOptional(vscode.Uri.joinPath(folder.uri, 'node_modules', ...packageName.split('/'), 'package.json'));
    if (installedManifest) {
      const version = parsePackage(installedManifest).version;
      if (typeof version === 'string') installedPackages[packageName] = version;
    }
  }
  const sourceUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.ts'), new vscode.RelativePattern(folder, '{node_modules,dist,coverage,.angular}/**'), 5000);
  const productionUris = sourceUris.filter(uri => !/\.(?:spec|test)\.ts$/i.test(uri.fsPath) && !/\.d\.ts$/i.test(uri.fsPath));
  const testUris = sourceUris.filter(uri => /\.(?:spec|test)\.ts$/i.test(uri.fsPath)).slice(0, 100);
  const sources = await Promise.all(productionUris.map(uri => readOptional(uri).then(value => value ?? '')));
  const sourceEvidence = (await Promise.all(testUris.map(uri => readOptional(uri).then(value => value ?? '')))).join('\n');
  const packageManager = await detectPackageManager(folder);
  return {
    project: detectAngularProject({ packageJson, angularJson, sources, installedPackages, workspace: folder.uri.fsPath, fallbackName: path.basename(folder.uri.fsPath), packageManager }),
    testing: detectTestEnvironment({ packageJson, angularJson, configFiles, installedPackages, sourceEvidence })
  };
}

async function detectPackageManager(folder: vscode.WorkspaceFolder): Promise<PackageManager | undefined> {
  const locks: Array<[string, PackageManager]> = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['package-lock.json', 'npm']];
  for (const [file, manager] of locks) if (await exists(vscode.Uri.joinPath(folder.uri, file))) return manager;
  return undefined;
}
async function readOptional(uri: vscode.Uri): Promise<string | undefined> { try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); } catch { return undefined; } }
async function exists(uri: vscode.Uri): Promise<boolean> { try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; } }
