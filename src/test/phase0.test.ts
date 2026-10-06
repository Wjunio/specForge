import assert from 'node:assert/strict';
import test from 'node:test';
import { detectAngularArchitecture } from '../angular/angularArchitectureDetector';
import { detectAngularProject } from '../angular/angularProjectDetector';
import { detectAngularVersions } from '../angular/angularVersionDetector';
import { formatDiagnostic } from '../diagnosticFormatter';
import { detectTestEnvironment, TestDetectionInput } from '../testing/testFrameworkDetector';
import { JasmineKarmaAdapter } from '../testing/jasmineKarmaAdapter';
import { JestAdapter } from '../testing/jestAdapter';
import { VitestAdapter } from '../testing/vitestAdapter';
import { AngularArchitecture, ProjectDiagnostic, TestFramework, TestRunner } from '../types';

function input(packageJson: object, configFiles: string[] = [], angularJson = '', sourceEvidence = ''): TestDetectionInput {
  return { packageJson: JSON.stringify(packageJson), configFiles, angularJson, sourceEvidence };
}

test('discovers exact installed Angular versions over declared ranges', () => {
  const versions = detectAngularVersions(JSON.stringify({ dependencies: { '@angular/core': '^17.0.0' }, devDependencies: { '@angular/cli': '~17.0.1', typescript: '^5.2' } }), { '@angular/core': '17.3.12', '@angular/cli': '17.3.12', typescript: '5.4.5' });
  assert.deepEqual(versions, { angular: '17.3.12', cli: '17.3.12', typescript: '5.4.5' });
  assert.deepEqual(detectAngularVersions('{invalid json'), { angular: undefined, cli: undefined, typescript: undefined });
});

test('reads peer and optional dependencies without inventing versions', () => {
  const versions = detectAngularVersions(JSON.stringify({ peerDependencies: { '@angular/core': '^20.1.2' }, optionalDependencies: { typescript: '~5.8.3' } }));
  assert.deepEqual(versions, { angular: '20.1.2', cli: undefined, typescript: '5.8.3' });
  const project = detectAngularProject({ packageJson: '{}', angularJson: '', sources: ["import { Component } from '@angular/core';"], workspace: '/workspace/demo', fallbackName: 'demo' });
  assert.equal(project.isAngular, true); assert.equal(project.name, 'demo');
});

test('classifies standalone, NgModule, mixed, and unknown architectures with counts', () => {
  const standalone = '@Component({ standalone: true }) export class One {}';
  const modular = '@NgModule({ declarations: [] }) export class AppModule {}';
  assert.equal(detectAngularArchitecture([standalone]).architecture, AngularArchitecture.Standalone);
  assert.equal(detectAngularArchitecture([modular]).architecture, AngularArchitecture.NgModule);
  const mixed = detectAngularArchitecture([standalone, modular]);
  assert.equal(mixed.architecture, AngularArchitecture.Mixed);
  assert.equal(mixed.componentsAnalyzed, 1); assert.equal(mixed.ngModulesAnalyzed, 1);
  assert.equal(detectAngularArchitecture(['export class Plain {}']).architecture, AngularArchitecture.Unknown);
});

test('detects a high-confidence modern Vitest environment from combined evidence', () => {
  const result = detectTestEnvironment(input({ devDependencies: { vitest: '^1.6.0' }, scripts: { test: 'vitest run' } }, ['vitest.config.ts'], '', "import { vi } from 'vitest'; vi.fn();"));
  assert.equal(result.activeFramework?.framework, TestFramework.Vitest);
  assert.equal(result.activeFramework?.runner, TestRunner.Vitest);
  assert.equal(result.activeFramework?.confidence, 'high');
  assert.deepEqual(result.activeFramework?.configFiles, ['vitest.config.ts']);
});

test('detects legacy Jasmine and Karma through Angular builder evidence', () => {
  const result = detectTestEnvironment(input({ devDependencies: { 'jasmine-core': '~3.6', karma: '~6.3' }, scripts: { test: 'ng test' } }, ['karma.conf.js'], '"builder": "@angular-devkit/build-angular:karma"'));
  assert.equal(result.activeFramework?.framework, TestFramework.Jasmine);
  assert.equal(result.activeFramework?.runner, TestRunner.Karma);
});

test('does not select an active framework for an ambiguous workspace', () => {
  const result = detectTestEnvironment(input({ devDependencies: { 'jasmine-core': '5', jest: '29', vitest: '2' } }, ['karma.conf.js', 'jest.config.ts', 'vitest.config.ts']));
  assert.deepEqual(result.frameworks.map(item => item.framework), [TestFramework.Jasmine, TestFramework.Jest, TestFramework.Vitest]);
  assert.equal(result.activeFramework, undefined);
});

test('a package dependency alone is low confidence and not active', () => {
  const result = detectTestEnvironment(input({ devDependencies: { jest: '^29' } }));
  assert.equal(result.frameworks[0].confidence, 'low');
  assert.equal(result.activeFramework, undefined);
});

test('keeps Jasmine framework separate from an unconfirmed runner', () => {
  const result = detectTestEnvironment(input({ peerDependencies: { 'jasmine-core': '^5' } }, [], '', 'jasmine.createSpy();'));
  assert.equal(result.activeFramework?.framework, TestFramework.Jasmine);
  assert.equal(result.activeFramework?.runner, TestRunner.Unknown);
  assert.match(result.activeFramework?.evidence.join('\n') ?? '', /without a confirmed runner/);
});

test('framework adapters expose the same read-only discovery contracts', () => {
  const environment = input({ devDependencies: { 'jasmine-core': '5', jest: '29', vitest: '2' } }, ['karma.conf.js', 'jest.config.ts', 'vitest.config.ts']);
  assert.equal(new JasmineKarmaAdapter().detect(environment)?.runner, TestRunner.Karma);
  assert.equal(new JestAdapter().detect(environment)?.runner, TestRunner.Jest);
  assert.equal(new VitestAdapter().detect(environment)?.runner, TestRunner.Vitest);
});

test('formats a resolved framework with successful status markers', () => {
  const diagnostic: ProjectDiagnostic = {
    project: { isAngular: true, name: 'legacy', workspace: '/workspace/legacy', angularVersion: '11.2.14', typescriptVersion: '4.1.6', architecture: AngularArchitecture.NgModule, primaryArchitecture: AngularArchitecture.NgModule, componentsAnalyzed: 4, ngModulesAnalyzed: 1, packageManager: 'npm', evidence: [] },
    testing: detectTestEnvironment(input({ devDependencies: { 'jasmine-core': '3.6', karma: '6.3' }, scripts: { test: 'ng test' } }, ['karma.conf.js']))
  };
  const report = formatDiagnostic(diagnostic);
  assert.match(report, /Framework: Jasmine/); assert.match(report, /Runner: Karma/); assert.match(report, /Test runner detected: ✓/);
});

test('formats the objective structured diagnostic and ambiguity action', () => {
  const diagnostic: ProjectDiagnostic = {
    project: { isAngular: true, name: 'app', workspace: '/workspace/app', angularVersion: '17.3.12', cliVersion: '17.3.12', typescriptVersion: '5.4.5', architecture: AngularArchitecture.Mixed, primaryArchitecture: AngularArchitecture.Standalone, componentsAnalyzed: 24, ngModulesAnalyzed: 1, packageManager: 'npm', evidence: [] },
    testing: detectTestEnvironment(input({ devDependencies: { jest: '29', vitest: '2' } }, ['jest.config.ts', 'vitest.config.ts']))
  };
  const report = formatDiagnostic(diagnostic);
  assert.match(report, /Name: app/); assert.match(report, /Primary: Standalone/); assert.match(report, /Detected: Mixed/);
  assert.match(report, /Framework: Not determined/); assert.match(report, /Select a testing framework/);
});
