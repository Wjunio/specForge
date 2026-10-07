# SpecForge

Gere e execute testes unitários para componentes e serviços Angular diretamente no
Visual Studio Code. O SpecForge detecta a infraestrutura de testes do projeto,
analisa o código TypeScript por AST e cria um `.spec.ts` compatível com Jasmine/Karma,
Jest ou Vitest.

Um teste só é apresentado como `PASS` depois de ser compilado, executado pelo runner
real do projeto e finalizado com sucesso.

## Funcionalidades

- detecção automática de projetos Angular, arquitetura e versões instaladas;
- suporte a projetos NgModule, Standalone e com arquitetura mista;
- detecção de Jasmine/Karma, Jest e Vitest por dependências e configurações reais;
- geração de testes para `Component` e `Service`;
- mocks específicos para cada framework;
- análise de propriedades, métodos, dependências, `@Inject` e `@Optional`;
- reconhecimento de dependências declaradas com `inject()`, formulários reativos e operações básicas de Signals;
- suporte a Observables e chamadas simples de `HttpClient`;
- cenários reconhecidos para HTTP, condições, agregações, atualizações em lote e timers RxJS;
- execução de arquivo completo ou teste selecionado pelo cursor;
- classificação de erros de compilação, execução, assertion, configuração e ambiente.

## Requisitos

- Visual Studio Code 1.85.0 ou superior;
- projeto Angular 11 ou superior;
- Node.js compatível com o projeto Angular;
- dependências do projeto instaladas em `node_modules`;
- Jasmine/Karma com Angular CLI, Jest ou Vitest configurado no projeto.

O SpecForge utiliza o runner já instalado. Ele não instala nem altera dependências do workspace.

## Instalação

### Arquivo VSIX

1. Gere ou obtenha o arquivo `.vsix`.
2. No VS Code, abra **Extensions**.
3. Abra o menu `...` e selecione **Install from VSIX...**.
4. Escolha o pacote e recarregue a janela, se solicitado.

Após a publicação, a extensão também poderá ser instalada diretamente pelo Visual Studio Marketplace.

## Início rápido

1. Abra a pasta raiz de um projeto Angular no VS Code.
2. Instale as dependências do projeto.
3. Abra um arquivo `.component.ts` ou `.service.ts`.
4. Execute **SpecForge: Generate Test** pela Command Palette.
5. Revise o preview e confirme a criação.
6. Consulte o documento de resultado aberto após a execução.

Por padrão, o teste é criado ao lado da origem:

```text
src/app/users/users.component.ts
src/app/users/users.component.spec.ts
```

Se mais de um framework for detectado e `specForge.framework` estiver em `auto`, o
SpecForge solicitará uma escolha antes de gerar o teste.

## Comandos

| Comando | Comportamento |
| --- | --- |
| `SpecForge: Project Test Configuration` | Exibe versões, arquitetura Angular, gerenciador de pacotes e frameworks detectados. |
| `SpecForge: Generate Test` | Identifica Component ou Service e gera o teste correspondente. |
| `SpecForge: Generate Component Test` | Gera um teste somente quando o arquivo é um Component. |
| `SpecForge: Generate Service Test` | Gera um teste somente quando o arquivo é um Service. |
| `SpecForge: Run Test` | Localiza e executa o `.spec.ts` associado ao arquivo selecionado. |
| `SpecForge: Run Test File` | Executa o arquivo de teste selecionado. |
| `SpecForge: Run Test at Cursor` | Executa o `it(...)` ou `test(...)` literal que contém o cursor. |

## Fluxo de geração

O SpecForge mantém o arquivo de produção somente leitura:

1. valida se a origem pertence ao workspace;
2. descobre o projeto e o framework de testes;
3. analisa a classe TypeScript sem executar seu código;
4. calcula e valida o destino dentro do workspace;
5. apresenta o conteúdo gerado em preview;
6. solicita confirmação explícita;
7. grava exclusivamente o arquivo de teste usando `WorkspaceEdit`;
8. confirma que a origem não foi modificada;
9. compila e executa o teste com o runner local.

Um teste existente não é substituído por padrão. Quando a substituição está
habilitada, uma segunda confirmação é exigida.

## Configurações

| Configuração | Tipo | Padrão | Descrição |
| --- | --- | --- | --- |
| `specForge.framework` | `string` | `auto` | Seleciona `jasmine`, `jest`, `vitest` ou detecção automática. |
| `specForge.overwriteTests` | `boolean` | `false` | Permite solicitar a substituição de um teste existente. |
| `specForge.testFileSuffix` | `string` | `.spec.ts` | Define o sufixo usado durante a geração. |
| `specForge.generateMocks` | `boolean` | `true` | Reservada para controle granular de mocks em fase posterior. |
| `specForge.analyzeTemplates` | `boolean` | `false` | Reservada para análise de templates em fase posterior. |
| `specForge.analyzeCoverage` | `boolean` | `false` | Reservada para análise automática de cobertura em fase posterior. |
| `specForge.maxRepairAttempts` | `number` | `3` | Limite preparado para o futuro fluxo de reparo automático. |
| `specForge.targetCoverage` | `number` | `100` | Meta preparada para o futuro fluxo de cobertura. |

## Compatibilidade

| Área | Suporte atual |
| --- | --- |
| Angular | 11 ou superior |
| Arquitetura | NgModule, Standalone e Mixed |
| Testes | Jasmine/Karma, Jest e Vitest |
| Entidades | Component e Service |
| HTTP | Operações simples de `HttpClient` com URLs literais ou padrões calculados reconhecidos |
| RxJS | Retornos Observable, `subscribe`, `takeUntil` e timers reconhecidos |
| Execução | Entrypoints locais presentes em `node_modules` |

## Segurança e privacidade

- o código analisado não é enviado para serviços externos;
- não são utilizados modelos de IA ou APIs remotas;
- processos são executados sem shell e por entrypoints locais conhecidos;
- arquivos fora do workspace não podem ser usados como destino;
- o arquivo de produção não é alterado durante a geração.

O runner pode executar código e configurações pertencentes ao workspace. Utilize a
extensão somente em projetos confiáveis.

## Limitações conhecidas

- a geração é determinística e baseada em padrões reconhecidos na AST, sem análise
  simbólica completa de qualquer programa TypeScript;
- templates Angular ainda não são analisados; Signals possuem suporte a valores iniciais, `set()` literal/parametrizado e toggles com `update()`;
- cobertura e reparo automático ainda não estão implementados;
- URLs e fluxos HTTP muito dinâmicos podem exigir ajustes manuais;
- `Run Test at Cursor` exige título literal em `it('...')` ou `test('...')`;
- Karma utiliza `ChromeHeadless`, que deve estar disponível no ambiente.

Sempre revise o preview antes de confirmar a criação do teste.

## Solução de problemas

### Nenhuma infraestrutura de testes foi detectada

Confirme que as dependências estão instaladas e que existem scripts ou configurações
para Jasmine/Karma, Jest ou Vitest. Se necessário, defina `specForge.framework`.

### O runner ativo não pôde ser determinado

Verifique os scripts do `package.json`, o `angular.json` e os arquivos de configuração do runner.

### O arquivo de teste correspondente não existe

Gere o teste primeiro e confira se o sufixo corresponde a `specForge.testFileSuffix`.

### O teste foi criado, mas terminou como FAILED

Abra **SpecForge Test Result**. O documento contém comando, duração, contadores e saída
do runner para diagnosticar compilação, providers, mocks ou configuração.

### Karma não encontra um navegador

Instale ou configure o Chrome/Chromium usado pelo `ChromeHeadless`.

## Desenvolvimento

```bash
npm install
npm run compile
npm test
npm run test:coverage
```

Abra o projeto no VS Code e pressione `F5` para iniciar o Extension Development Host.

## Licença

Distribuído sob a licença MIT. Consulte [LICENSE](LICENSE).
