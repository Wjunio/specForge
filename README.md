# SpecForge — Fase 1

Extensão VS Code local para descobrir a infraestrutura de testes de projetos
Angular e gerar testes reais de `Component` e `Service`. Um teste só é apresentado
como `PASS` depois de o runner configurado compilá-lo, executá-lo e retornar sucesso.

## Garantia de integridade

O arquivo TypeScript usado como base é somente leitura. O SpecForge:

- calcula o destino ao lado da origem usando `.spec.ts` por padrão;
- valida que o destino permanece dentro do workspace;
- mostra o conteúdo gerado em preview;
- pede confirmação antes de criar o spec;
- usa `WorkspaceEdit` para gravar exclusivamente o arquivo de teste;
- nunca substitui um teste existente por padrão;
- exige configuração e confirmação explícitas para substituir um spec;
- compara o conteúdo da origem antes e depois da operação.

## Comandos

- `SpecForge: Project Test Configuration`
- `SpecForge: Generate Test`
- `SpecForge: Generate Component Test`
- `SpecForge: Generate Service Test`
- `SpecForge: Run Test`
- `SpecForge: Run Test File`
- `SpecForge: Run Test at Cursor`

Abra um `.component.ts` ou `.service.ts` e execute um comando de geração. Depois do
preview e da confirmação, o teste é salvo e executado automaticamente. Em ambientes
ambíguos, o framework deve ser selecionado explicitamente.

## Compatibilidade da Fase 1

- Angular 11 ou superior, sem inferir arquitetura pela versão;
- NgModule e Standalone;
- Jasmine/Karma, Jest e Vitest;
- análise AST de classes, decorators, construtores, dependências, métodos,
  propriedades estáveis, chamadas delegadas e usos simples de `HttpClient`;
- mocks específicos do framework;
- retorno Observable para padrões `dependency.method().subscribe(...)`;
- URLs HTTP literais ou calculadas, incluindo caminhos padrão e base de API configurável;
- tokens de injeção declarados com `@Inject` e dependências `@Optional`;
- cenários de sucesso/erro HTTP, limites condicionais, agregações, atualizações em lote
  e timers RxJS para padrões reconhecidos pela análise AST;
- execução por entrypoint instalado em `node_modules`, sem `shell` e sem comandos
  derivados do código analisado;
- classificação de falhas de compilação, runtime, assertion, configuração e ambiente.

## Configurações

- `specForge.framework`: `auto`, `jasmine`, `jest` ou `vitest`;
- `specForge.generateMocks`: habilita mocks determinísticos;
- `specForge.analyzeTemplates`: reservado para fase posterior;
- `specForge.analyzeCoverage`: reservado para fase posterior;
- `specForge.overwriteTests`: padrão `false`;
- `specForge.testFileSuffix`: padrão `.spec.ts`;
- `specForge.maxRepairAttempts`: limite preparado para reparos;
- `specForge.targetCoverage`: meta preparada para cobertura.

## Desenvolvimento

```bash
npm install
npm run compile
npm test
npm run test:coverage
```

A Fase 1 não afirma cobertura do projeto Angular sem medição. Template, Signals,
reparo automático avançado e ciclo de cobertura/gaps pertencem às fases seguintes.
