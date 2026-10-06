import ts from 'typescript';
import { AngularArchitecture } from '../types';

export interface ArchitectureDetection {
  architecture: AngularArchitecture;
  primary: AngularArchitecture;
  componentsAnalyzed: number;
  standaloneComponents: number;
  ngModulesAnalyzed: number;
}

export function detectAngularArchitecture(sources: string[]): ArchitectureDetection {
  let componentsAnalyzed = 0; let standaloneComponents = 0; let ngModulesAnalyzed = 0;
  for (const [index, source] of sources.entries()) {
    const file = ts.createSourceFile(`source-${index}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
        const name = node.expression.expression.getText(file);
        if (name === 'NgModule') ngModulesAnalyzed++;
        if (name === 'Component') {
          componentsAnalyzed++;
          const metadata = node.expression.arguments[0];
          if (metadata && ts.isObjectLiteralExpression(metadata) && metadata.properties.some(property => ts.isPropertyAssignment(property)
            && property.name.getText(file) === 'standalone' && property.initializer.kind === ts.SyntaxKind.TrueKeyword)) standaloneComponents++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  const hasStandalone = standaloneComponents > 0; const hasModules = ngModulesAnalyzed > 0;
  const architecture = hasStandalone && hasModules ? AngularArchitecture.Mixed : hasStandalone ? AngularArchitecture.Standalone
    : hasModules ? AngularArchitecture.NgModule : AngularArchitecture.Unknown;
  const primary = architecture !== AngularArchitecture.Mixed ? architecture
    : standaloneComponents >= ngModulesAnalyzed ? AngularArchitecture.Standalone : AngularArchitecture.NgModule;
  return { architecture, primary, componentsAnalyzed, standaloneComponents, ngModulesAnalyzed };
}
