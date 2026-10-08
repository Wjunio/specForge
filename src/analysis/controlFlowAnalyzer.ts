import ts from 'typescript';
import { FlowConstraintInfo, FlowDecisionInfo, FlowEffectInfo, FlowScenarioInfo, MethodFlowInfo } from '../types';

const MAX_COMBINATIONS = 64;

export function analyzeControlFlow(declaration: ts.ClassDeclaration, file: ts.SourceFile): MethodFlowInfo[] {
  return declaration.members.filter(ts.isMethodDeclaration).flatMap(method => {
    if (!method.body || !method.name || !ts.isIdentifier(method.name)) return [];
    const decisions: FlowDecisionInfo[] = [];
    const effects: FlowEffectInfo[] = [];
    const literals = new Map<string, Set<string>>();
    for (const parameter of method.parameters) if (ts.isIdentifier(parameter.name)) literals.set(parameter.name.text, new Set());

    const addEffect = (effect: FlowEffectInfo): void => { effects.push(effect); };
    const walk = (node: ts.Node, constraints: FlowConstraintInfo[]): void => {
      if (ts.isIfStatement(node)) {
        const expression = node.expression.getText(file);
        decisions.push({ expression, kind: 'if', outcomes: node.elseStatement ? ['true', 'false'] : ['true', 'fallthrough'] });
        collectFromExpression(node.expression);
        walk(node.thenStatement, [...constraints, { expression, outcome: true }]);
        if (node.elseStatement) walk(node.elseStatement, [...constraints, { expression, outcome: false }]);
        return;
      }
      if (ts.isSwitchStatement(node)) {
        const subject = node.expression.getText(file);
        decisions.push({ expression: subject, kind: 'switch', outcomes: node.caseBlock.clauses.map(clause => ts.isDefaultClause(clause) ? 'default' : clause.expression.getText(file)) });
        const cases = node.caseBlock.clauses.filter(ts.isCaseClause);
        for (const clause of node.caseBlock.clauses) {
          const caseConstraints = ts.isCaseClause(clause)
            ? [...constraints, { expression: `${subject} === ${clause.expression.getText(file)}`, outcome: true }]
            : [...constraints, ...cases.map(item => ({ expression: `${subject} === ${item.expression.getText(file)}`, outcome: false }))];
          clause.statements.forEach(statement => walk(statement, caseConstraints));
        }
        return;
      }
      if (ts.isTryStatement(node)) {
        walk(node.tryBlock, constraints);
        if (node.catchClause) { decisions.push({ expression: node.catchClause.variableDeclaration?.name.getText(file) ?? 'error', kind: 'catch', outcomes: ['success', 'throw'] }); walk(node.catchClause.block, [...constraints, { expression: '__throws__', outcome: true }]); }
        if (node.finallyBlock) walk(node.finallyBlock, constraints);
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const property = /^this\.([$\w]+)$/.exec(node.left.getText(file))?.[1];
        if (property && ts.isConditionalExpression(node.right)) {
          const expression = node.right.condition.getText(file);
          decisions.push({ expression, kind: 'ternary', outcomes: ['true', 'false'] }); collectFromExpression(node.right.condition);
          if (isAssertionExpression(node.right.whenTrue)) addEffect({ kind: 'property-write', property, values: [node.right.whenTrue.getText(file)], constraints: [...constraints, { expression, outcome: true }] });
          if (isAssertionExpression(node.right.whenFalse)) addEffect({ kind: 'property-write', property, values: [node.right.whenFalse.getText(file)], constraints: [...constraints, { expression, outcome: false }] });
          return;
        }
        if (property && isAssertionExpression(node.right)) addEffect({ kind: 'property-write', property, values: [node.right.getText(file)], constraints: [...constraints] });
      }
      if (ts.isReturnStatement(node) && node.expression) {
        if (ts.isConditionalExpression(node.expression)) {
          const expression = node.expression.condition.getText(file);
          decisions.push({ expression, kind: 'ternary', outcomes: ['true', 'false'] }); collectFromExpression(node.expression.condition);
          if (isAssertionExpression(node.expression.whenTrue)) addEffect({ kind: 'return', values: [node.expression.whenTrue.getText(file)], constraints: [...constraints, { expression, outcome: true }] });
          if (isAssertionExpression(node.expression.whenFalse)) addEffect({ kind: 'return', values: [node.expression.whenFalse.getText(file)], constraints: [...constraints, { expression, outcome: false }] });
          return;
        }
        if (isAssertionExpression(node.expression)) addEffect({ kind: 'return', values: [node.expression.getText(file)], constraints: [...constraints] });
      }
      if (ts.isThrowStatement(node) && node.expression) addEffect({ kind: 'throw', values: [node.expression.getText(file)], constraints: [...constraints] });
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
        addEffect({ kind: 'dependency-call', dependency: node.expression.expression.name.text, method: node.expression.name.text, arguments: node.arguments.map(argument => argument.getText(file)), constraints: [...constraints] });
      }
      if (ts.isConditionalExpression(node)) decisions.push({ expression: node.condition.getText(file), kind: 'ternary', outcomes: ['true', 'false'] });
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) decisions.push({ expression: node.getText(file), kind: 'nullish', outcomes: ['defined', 'nullish'] });
      if (ts.isPropertyAccessChain(node) || ts.isElementAccessChain(node) || ts.isCallChain(node)) decisions.push({ expression: node.getText(file), kind: 'optional-chain', outcomes: ['defined', 'nullish'] });
      if (ts.isBinaryExpression(node)) collectConstraint(node, literals, file);
      ts.forEachChild(node, child => walk(child, constraints));
    };
    const collectFromExpression = (expression: ts.Expression): void => { const visit = (node: ts.Node): void => { if (ts.isBinaryExpression(node)) collectConstraint(node, literals, file); ts.forEachChild(node, visit); }; visit(expression); };
    walk(method.body, []);
    const parameters = method.parameters.filter(parameter => ts.isIdentifier(parameter.name)).map(parameter => {
      const name = (parameter.name as ts.Identifier).text;
      return { name, type: parameter.type?.getText(file), optional: Boolean(parameter.questionToken || parameter.initializer), candidates: candidatesFor(parameter, literals.get(name) ?? new Set(), file) };
    });
    return [{ methodName: method.name.text, startLine: file.getLineAndCharacterOfPosition(method.getStart(file)).line + 1, endLine: file.getLineAndCharacterOfPosition(method.end).line + 1, parameters, decisions: uniqueDecisions(decisions), effects, async: Boolean(method.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword)), leafCount: estimateLeaves(decisions) }];
  });
}

export function argumentCombinations(method: MethodFlowInfo): string[][] {
  if (!method.parameters.length) return [[]];
  let combinations: string[][] = [[]];
  for (const parameter of method.parameters) combinations = combinations.flatMap(existing => parameter.candidates.map(candidate => [...existing, candidate])).slice(0, MAX_COMBINATIONS);
  return combinations;
}

export function solveFlowScenarios(method: MethodFlowInfo): FlowScenarioInfo[] {
  const scenarios = argumentCombinations(method).map(argumentsList => {
    const environment = new Map(method.parameters.map((parameter, index) => [parameter.name, parseCandidate(argumentsList[index])]));
    const effects = method.effects.filter(effect => effect.constraints.every(constraint => evaluateConstraint(constraint, environment)));
    return { arguments: argumentsList, effects, constraints: effects.flatMap(effect => effect.constraints) };
  }).filter(scenario => scenario.effects.length);
  const unique = new Map<string, FlowScenarioInfo>();
  for (const scenario of scenarios) {
    const key = `${scenario.constraints.map(item => `${item.expression}:${item.outcome}`).join('&')}:${scenario.effects.map(effectKey).join(',')}`;
    if (!unique.has(key)) unique.set(key, scenario);
  }
  return [...unique.values()];
}

function candidatesFor(parameter: ts.ParameterDeclaration, constrained: Set<string>, file: ts.SourceFile): string[] {
  const type = parameter.type?.getText(file) ?? '';
  const values = new Set<string>(constrained);
  if (/boolean/.test(type)) { values.add('true'); values.add('false'); }
  else if (/number/.test(type)) { values.add('0'); values.add('1'); values.add('-1'); }
  else if (/string/.test(type)) { values.add("''"); values.add("'test'"); }
  else { values.add('undefined'); values.add('null'); values.add('{} as any'); }
  if (parameter.questionToken || /null|undefined/.test(type)) { values.add('undefined'); values.add('null'); }
  return [...values].slice(0, 10);
}

function collectConstraint(node: ts.BinaryExpression, output: Map<string, Set<string>>, file: ts.SourceFile): void {
  const operators = [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken];
  if (!operators.includes(node.operatorToken.kind)) return;
  const add = (identifier: ts.Expression, value: ts.Expression): void => {
    if (!ts.isIdentifier(identifier) || !output.has(identifier.text)) return;
    const values = output.get(identifier.text)!;
    if (ts.isNumericLiteral(value)) { const number = Number(value.text); values.add(String(number - 1)); values.add(String(number)); values.add(String(number + 1)); }
    else if (ts.isStringLiteralLike(value)) { values.add(JSON.stringify(value.text)); values.add("''"); }
    else if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(value.kind)) values.add(value.getText(file));
  };
  add(node.left, node.right); add(node.right, node.left);
}

function evaluateConstraint(constraint: FlowConstraintInfo, environment: Map<string, unknown>): boolean {
  if (constraint.expression === '__throws__') return false;
  const file = ts.createSourceFile('condition.ts', `(${constraint.expression});`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) return false;
  const value = evaluateExpression(ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : statement.expression, environment);
  return value !== UNKNOWN && Boolean(value) === constraint.outcome;
}

const UNKNOWN = Symbol('unknown');
function evaluateExpression(node: ts.Expression, environment: Map<string, unknown>): unknown {
  if (ts.isIdentifier(node)) return environment.has(node.text) ? environment.get(node.text) : node.text === 'undefined' ? undefined : UNKNOWN;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isParenthesizedExpression(node)) return evaluateExpression(node.expression, environment);
  if (ts.isPrefixUnaryExpression(node)) { const value = evaluateExpression(node.operand, environment); if (value === UNKNOWN) return UNKNOWN; if (node.operator === ts.SyntaxKind.ExclamationToken) return !value; if (node.operator === ts.SyntaxKind.MinusToken) return -Number(value); }
  if (ts.isBinaryExpression(node)) {
    const left = evaluateExpression(node.left, environment); const right = evaluateExpression(node.right, environment); if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.EqualsEqualsToken: return left == right;
      case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
      case ts.SyntaxKind.ExclamationEqualsToken: return left != right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
      case ts.SyntaxKind.LessThanToken: return (left as number) < (right as number);
      case ts.SyntaxKind.LessThanEqualsToken: return (left as number) <= (right as number);
      case ts.SyntaxKind.GreaterThanToken: return (left as number) > (right as number);
      case ts.SyntaxKind.GreaterThanEqualsToken: return (left as number) >= (right as number);
      case ts.SyntaxKind.AmpersandAmpersandToken: return Boolean(left) && Boolean(right);
      case ts.SyntaxKind.BarBarToken: return Boolean(left) || Boolean(right);
      default: return UNKNOWN;
    }
  }
  return UNKNOWN;
}

function parseCandidate(value: string | undefined): unknown { if (value === undefined || value === 'undefined') return undefined; if (value === 'null') return null; if (value === 'true') return true; if (value === 'false') return false; if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value); if (/^(['"]).*\1$/.test(value)) return value.slice(1, -1); return UNKNOWN; }
function effectKey(effect: FlowEffectInfo): string { return effect.kind === 'property-write' ? `${effect.kind}:${effect.property}:${effect.values.join('|')}` : effect.kind === 'dependency-call' ? `${effect.kind}:${effect.dependency}.${effect.method}` : `${effect.kind}:${effect.values.join('|')}`; }
function uniqueDecisions(values: FlowDecisionInfo[]): FlowDecisionInfo[] { return [...new Map(values.map(item => [`${item.kind}:${item.expression}`, item])).values()]; }
function estimateLeaves(decisions: FlowDecisionInfo[]): number { return Math.min(256, Math.max(1, decisions.reduce((total, item) => total * Math.max(1, item.outcomes.length), 1))); }
function isAssertionExpression(expression: ts.Expression): boolean { return ts.isLiteralExpression(expression) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(expression.kind) || ts.isIdentifier(expression) && expression.text === 'undefined' || ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression); }
