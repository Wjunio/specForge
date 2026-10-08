# SpecForge

O SpecForge é uma extensão para Visual Studio Code que analisa código Angular/TypeScript e gera arquivos de testes unitários compatíveis com a infraestrutura já instalada no projeto.

A extensão detecta o projeto Angular, identifica o runner, analisa o arquivo selecionado por AST, gera um `.spec.ts`, apresenta um preview e, após confirmação, executa o teste no runner real do workspace.

> **Importante:** `PASS` significa que o teste gerado compilou e terminou com sucesso. Quando `specForge.analyzeCoverage` está habilitado, a meta somente é considerada atingida após confirmação pelo relatório do runner; sem essa opção, `PASS` não implica automaticamente 100% de cobertura.

## Objetivos

- descobrir automaticamente a arquitetura e o ambiente de testes;
- analisar TypeScript sem executar o código de produção;
- criar mocks compatíveis com Jasmine, Jest ou Vitest;
- gerar testes determinísticos a partir dos metadados encontrados;
- executar imediatamente o arquivo gerado;
- manter o arquivo de produção inalterado;
- operar localmente, sem enviar código a serviços externos.

O SpecForge não utiliza IA remota. A geração atual é baseada em AST, metadados extraídos do código e estratégias determinísticas.

## Funcionalidades atuais

### Descoberta do projeto

- detecta workspaces Angular;
- identifica versões instaladas do Angular, Angular CLI e TypeScript;
- classifica a arquitetura como NgModule, Standalone, Mixed ou Unknown;
- identifica o gerenciador de pacotes;
- detecta Jasmine/Karma, Jest e Vitest por dependências, scripts e configurações;
- utiliza somente entrypoints locais encontrados em `node_modules`.

### Entidades analisadas

- componentes Angular;
- serviços baseados em classe;
- pipes baseados em classe;
- guards baseados em classe.

Também são reconhecidos `CanActivateFn`, `CanMatchFn`, `CanDeactivateFn`, `ResolveFn` e `HttpInterceptorFn`, executados por `TestBed.runInInjectionContext()`.

## Como a análise funciona

O analisador usa a API do compilador TypeScript para criar uma AST e extrair:

- nome e tipo da entidade;
- configuração `standalone` explícita ou inferida;
- propriedades e inicializadores;
- métodos públicos, protegidos e privados;
- nomes e tipos dos parâmetros;
- dependências declaradas no construtor;
- tokens com `@Inject()`;
- dependências com `@Optional()`;
- dependências declaradas por `inject()`;
- chamadas feitas às dependências;
- chamadas executadas dentro de callbacks;
- usos de Observables;
- operações básicas com Signals;
- formulários criados por `FormBuilder.group()`;
- chamadas de `HttpClient`;
- usos reconhecidos de APIs do navegador.

### Fluxo de controle

O analisador registra decisões encontradas nos métodos:

- `if` e `else`;
- `switch`, `case` e `default`;
- operadores ternários;
- coalescência nula (`??`);
- optional chaining (`?.`);
- blocos `catch`;
- métodos `async`.

Também deriva candidatos de entrada a partir dos tipos e das comparações. Para números comparados com literais, considera o valor exato e valores adjacentes. Parâmetros opcionais ou anuláveis recebem `undefined` e `null`.

Para evitar explosão combinatória, existe um limite de combinações por método. A implementação associa restrições simples aos efeitos e seleciona entradas representativas por caminho, mas ainda não é um solver simbólico completo para qualquer programa TypeScript.

### Efeitos comportamentais

O contexto de geração registra efeitos observáveis encontrados na AST:

- atribuições literais em propriedades da instância;
- valores literais retornados;
- exceções lançadas;
- chamadas realizadas em dependências.

Quando as restrições são suportadas pelo solver, cada caminho recebe uma entrada representativa e uma assertion exata. Expressões não suportadas são omitidas do conjunto resolvido em vez de receberem uma expectativa inventada.

O gerador não usa `expect(subject).toBeDefined()` como substituto de uma assertion comportamental em cenários de fluxo de controle.

## Configuração do TestBed

### Componentes NgModule

Componentes não standalone são configurados em `declarations`:

```typescript
await TestBed.configureTestingModule({
  declarations: [ExampleComponent],
  imports: [],
  providers: []
}).compileComponents();
```

### Componentes standalone

Componentes standalone são configurados em `imports`:

```typescript
await TestBed.configureTestingModule({
  imports: [ExampleComponent],
  providers: []
}).compileComponents();
```

Depois da criação, o gerador executa:

```typescript
fixture = TestBed.createComponent(ExampleComponent);
subject = fixture.componentInstance;
fixture.detectChanges();
```

Isso inicializa o componente e executa hooks como `ngOnInit`.

### Serviços, pipes e guards

Entidades não visuais baseadas em classe são registradas como providers e obtidas com `TestBed.inject()`.

Pipes standalone ainda precisam de uma estratégia própria para configuração ideal em todas as versões. Guards, resolvers e interceptors funcionais são executados com `TestBed.runInInjectionContext()`.

## Dependências e mocks

As dependências injetadas são transformadas em mocks conforme o framework ativo.

Jasmine:

```typescript
jasmine.createSpyObj('service', ['load', 'save']);
```

Jest:

```typescript
{ load: jest.fn(), save: jest.fn() }
```

Vitest:

```typescript
{ load: vi.fn(), save: vi.fn() }
```

Métodos reconhecidos como Observable recebem, por padrão, retorno com `of([])`. Esse valor atende coleções simples, mas pode exigir especialização quando o Observable retorna objetos, escalares ou sequências complexas.

### ActivatedRoute

O mock de `ActivatedRoute` inclui:

- `snapshot.paramMap` e `snapshot.queryParamMap`;
- `snapshot.params`, `snapshot.queryParams` e `snapshot.data`;
- `params`, `queryParams` e `data` como Observables.

## HTTP

O SpecForge reconhece chamadas simples de `GET`, `POST`, `PUT`, `PATCH` e `DELETE`.

Quando a URL pode ser resolvida estaticamente, o gerador usa `HttpTestingController` para verificar a requisição.

Exemplo de sucesso:

```typescript
subject.load().subscribe();
const request = httpMock.expectOne('/api/items');
expect(request.request.method).toBe('GET');
request.flush([]);
```

Para métodos que retornam um Observable, também é gerado um cenário de erro:

```typescript
subject.load().subscribe({ error: () => undefined });
const request = httpMock.expectOne('/api/items');
request.flush('Server Error', {
  status: 500,
  statusText: 'Internal Server Error'
});
```

Para inscrições internas, o cenário de erro é gerado quando a AST identifica `catchError` ou um handler `error`.

A resposta simulada é inferida de forma básica:

| Tipo HTTP | Resposta gerada |
| --- | --- |
| `T[]` ou `Array<T>` | `[]` |
| `boolean` | `true` |
| `number` | `0` |
| `string` | `'response'` |
| objeto desconhecido | `{} as any` |

Para Angular 15 ou superior, o gerador usa `provideHttpClient()` e `provideHttpClientTesting()`. Versões anteriores continuam usando `HttpClientTestingModule`.

## RxJS

O analisador reconhece:

- chamadas encadeadas com `subscribe`;
- dependências cujos métodos precisam retornar Observable;
- callbacks executados de forma adiada;
- `catchError` e handlers `error` em fluxos HTTP;
- alguns usos conhecidos de timers RxJS.

Ainda não existe modelagem completa para múltiplas emissões, schedulers, marble testing, retry, finalize, Subjects complexos ou cancelamento.

## Signals

O suporte atual cobre:

- valor inicial de `signal()`;
- `.set()` com literal;
- `.set()` com parâmetro do método;
- toggle booleano simples com `.update(current => !current)`.

`computed()` tem suas dependências diretas extraídas e recebe um cenário de recomputação. Para `effect()`, o analisador extrai Signals lidos, escritas diretas em propriedades e o registro de cleanup; o teste altera o Signal de origem e valida os efeitos observáveis. `linkedSignal()` e grafos indiretos complexos ainda não são resolvidos por completo.

## Ciclo de vida

O contexto registra e gera cenários explícitos para:

- `ngOnInit`;
- `ngOnDestroy`;
- `ngOnChanges`;
- `ngAfterViewInit`;
- `ngAfterViewChecked`;
- `ngAfterContentInit`;
- `ngAfterContentChecked`;
- `ngDoCheck`.

`ngOnChanges` recebe um objeto vazio tipado como `any`. Componentes que dependam de um `SimpleChanges` específico podem exigir um cenário mais detalhado.

## Formulários reativos

O analisador reconhece configurações básicas criadas com `FormBuilder.group()` e extrai valores iniciais dos campos. Para cenários de delegação que utilizam um formulário reconhecido, pode gerar `setValue()` antes da chamada do método.

Validadores customizados, validação assíncrona, `FormArray`, grupos profundamente aninhados e estados dirty/touched ainda não são resolvidos completamente.

## APIs do navegador

O analisador identifica usos conhecidos de:

- `XMLHttpRequest`;
- `URL.createObjectURL` e `URL.revokeObjectURL`;
- `document.createElement('a')`;
- `window.location.href`;
- `setTimeout` e `setInterval`.

Existe uma estratégia para fluxos que combinam diálogo, XHR, progresso, Blob, link de download, temporizador, erro de rede e redirecionamento. Método HTTP, caminho, status de sucesso, propriedade de progresso, nome do arquivo, timeout e URL são extraídos da AST quando disponíveis.

Essa estratégia não representa suporte universal a todas as APIs do navegador. `fetch`, WebSocket, storage, observers, FileReader, workers e eventos arbitrários ainda não possuem estratégias completas.

## Templates

Quando `specForge.analyzeTemplates` está ativo, templates inline e externos são analisados com o `@angular/compiler` do workspace. O contexto registra eventos, métodos invocados, inputs, outputs e `formControlName`.

## Frameworks de teste

| Framework | Runner esperado | Mocks | Timers |
| --- | --- | --- | --- |
| Jasmine | Karma/Angular CLI | `jasmine.createSpyObj` | `jasmine.clock()` |
| Jest | Jest | `jest.fn()` | `jest.useFakeTimers()` |
| Vitest | Vitest | `vi.fn()` | `vi.useFakeTimers()` |

O SpecForge não instala, remove ou atualiza dependências. Ele utiliza o ambiente já configurado no workspace.

## Compatibilidade Angular

| Área | Suporte atual |
| --- | --- |
| Angular | Detecção preparada para Angular 11 ou superior |
| NgModule | Componentes configurados em `declarations` |
| Standalone | Componentes configurados em `imports` |
| Arquitetura mista | Detectada pelo projeto |
| `inject()` | Dependências diretas reconhecidas |
| Signals | Operações básicas de `signal`, `set` e `update` |
| HTTP moderno | Usa providers a partir do Angular 15 |

O projeto ainda não possui uma matriz de integração executando os testes gerados em todas as versões entre Angular 11 e Angular 19+. Portanto, esse intervalo é um alvo de compatibilidade da detecção, não uma certificação integral de todas as combinações.

## Fluxo de geração

1. valida se o arquivo pertence ao workspace;
2. lê o arquivo de produção;
3. descobre o projeto Angular;
4. detecta frameworks e runners;
5. seleciona o framework configurado ou solicita uma escolha;
6. analisa o código por AST;
7. constrói o contexto de geração;
8. gera o `.spec.ts` pelo adapter correspondente;
9. apresenta o conteúdo em preview;
10. verifica se o destino existe;
11. solicita confirmação antes de criar ou substituir;
12. grava somente o arquivo de teste;
13. confirma que a origem não foi modificada;
14. executa o teste pelo runner local;
15. aplica reparos determinísticos e executa novamente, quando necessário;
16. opcionalmente coleta cobertura e acrescenta cenários associados ao CFG;
17. repete até atingir a meta, esgotar as tentativas ou não encontrar correção segura;
18. apresenta comando, saída, cobertura e resultado.

## Instalação

### VSIX

1. Gere ou obtenha o arquivo `.vsix`.
2. Abra **Extensions** no VS Code.
3. Abra o menu `...`.
4. Selecione **Install from VSIX...**.
5. Escolha o pacote e recarregue a janela, se solicitado.

## Início rápido

1. Abra a raiz de um projeto Angular.
2. Instale as dependências em `node_modules`.
3. Abra um `.component.ts`, `.service.ts`, `.pipe.ts` ou guard baseado em classe.
4. Execute **SpecForge: Generate Test**.
5. Revise o preview.
6. Confirme a criação.
7. Consulte **SpecForge Test Result**.

Por padrão, o teste é criado ao lado da origem:

```text
src/app/users/users.component.ts
src/app/users/users.component.spec.ts
```

## Comandos

| Comando | Comportamento |
| --- | --- |
| `SpecForge: Project Test Configuration` | Exibe versões, arquitetura, gerenciador e frameworks detectados. |
| `SpecForge: Generate Test` | Analisa a entidade selecionada e gera o teste. |
| `SpecForge: Generate Component Test` | Exige um componente. |
| `SpecForge: Generate Service Test` | Exige um serviço. |
| `SpecForge: Run Test` | Localiza e executa o `.spec.ts` associado. |
| `SpecForge: Run Test File` | Executa o arquivo de teste selecionado. |
| `SpecForge: Run Test at Cursor` | Executa o `it(...)` ou `test(...)` literal sob o cursor. |

Não existem comandos dedicados para pipe ou guard; use **SpecForge: Generate Test**.

## Configurações

| Configuração | Tipo | Padrão | Estado |
| --- | --- | --- | --- |
| `specForge.framework` | `string` | `auto` | Seleciona `jasmine`, `jest`, `vitest` ou detecção automática. |
| `specForge.overwriteTests` | `boolean` | `false` | Permite confirmar substituição de teste existente. |
| `specForge.testFileSuffix` | `string` | `.spec.ts` | Define o sufixo gerado. |
| `specForge.generateMocks` | `boolean` | `true` | Reservada para controle granular futuro. |
| `specForge.analyzeTemplates` | `boolean` | `false` | Ativa análise com o compilador Angular do workspace. |
| `specForge.analyzeCoverage` | `boolean` | `false` | Executa o runner com cobertura e lê `coverage-summary.json` e `coverage-final.json`. |
| `specForge.maxRepairAttempts` | `number` | `3` | Limita reparos determinísticos após falhas. |
| `specForge.targetCoverage` | `number` | `100` | Meta comparada ao relatório de cobertura. |

## Resultados

### PASS

O teste foi aceito pelo runner, compilou e terminou com código de saída de sucesso.

### FAILED

O runner reportou erro de compilação, execução, assertion, configuração ou ambiente. O arquivo pode ser criado mesmo quando termina como `FAILED`, permitindo revisão manual.

### Cobertura

Quando `specForge.analyzeCoverage` está ativo, o comando solicita cobertura ao runner, lê `coverage-summary.json` e `coverage-final.json`, compara statements, branches, functions e lines com `specForge.targetCoverage` e apresenta as linhas, funções e alternativas de branch não atingidas quando o runner produz o mapa Istanbul detalhado.

## Limitações conhecidas

- não existe análise simbólica completa de qualquer TypeScript;
- o solver cobre expressões escalares comuns, mas não todas as expressões TypeScript;
- construtores, getters, setters e propriedades arrow ainda não recebem CFG dedicado;
- loops, short-circuit complexo, recursão e condições correlacionadas podem não ser resolvidos;
- combinações de parâmetros são limitadas para evitar explosão combinatória;
- a análise de templates depende do `@angular/compiler` instalado no workspace;
- `effect()` indireto, assíncrono ou sem efeito observável estaticamente resolvível pode exigir teste manual;
- RxJS complexo pode exigir mocks manuais;
- APIs do navegador fora das estratégias reconhecidas podem exigir ajustes;
- `window.location` pode ser não configurável em alguns runners;
- pipes standalone ainda não têm setup dedicado;
- reparos são limitados a providers importados e métodos ausentes em mocks;
- a realimentação de cobertura acrescenta cenários quando a lacuna pode ser associada com segurança a um método e ao seu CFG; lacunas sem associação determinística são apenas diagnosticadas;
- não há certificação automatizada para cada versão Angular entre 11 e 19+.

Sempre revise o preview antes de confirmar a criação.

## Segurança e privacidade

- o código não é enviado para serviços externos;
- não são usados modelos de IA ou APIs remotas;
- o arquivo de produção não é modificado;
- o destino precisa permanecer dentro do workspace;
- processos usam entrypoints locais conhecidos;
- dependências não são instaladas automaticamente;
- substituição de testes exige configuração e confirmação.

O runner executa código e configurações do workspace. Use a extensão somente em projetos confiáveis.

## Solução de problemas

### Nenhuma infraestrutura foi detectada

Confirme que as dependências estão instaladas e que existe configuração para Jasmine/Karma, Jest ou Vitest. Se necessário, defina `specForge.framework`.

### O runner não pôde ser determinado

Verifique `package.json`, `angular.json`, arquivos de configuração e dependências instaladas.

### O teste foi gerado, mas falhou

Abra **SpecForge Test Result** e verifique comando, erros TypeScript, providers, mocks, requisições pendentes, assertions e ambiente.

### Karma não encontra navegador

Instale ou configure o Chrome/Chromium necessário para `ChromeHeadless`.

### O teste existente não foi substituído

Ative `specForge.overwriteTests` e confirme a substituição.

## Arquitetura implementada e evolução técnica

As seções abaixo documentam tanto a arquitetura já implementada quanto extensões ainda possíveis. Cada seção declara explicitamente o estado atual para não confundir comportamento disponível com trabalho futuro.

### 1. Associação entre caminho e efeito

**Estado: implementado para expressões resolvidas pelo solver leve.** O analisador registra decisões, candidatos, restrições e efeitos observáveis e associa cada efeito ao caminho que o produz. Expressões dinâmicas fora do subconjunto suportado permanecem diagnosticáveis, mas não são tratadas como caminhos provados.

Para o subconjunto suportado, o fluxo de controle representa:

```text
entrada
  → restrições do caminho
  → branch alcançado
  → efeitos esperados
  → assertion exata
```

Exemplo:

```typescript
if (age >= 18) {
  this.category = 'adult';
} else {
  this.category = 'minor';
}
```

O contexto preserva uma relação equivalente a:

```typescript
[
  {
    arguments: ['18'],
    constraints: ['age >= 18'],
    effects: [{ property: 'category', value: "'adult'" }]
  },
  {
    arguments: ['17'],
    constraints: ['age < 18'],
    effects: [{ property: 'category', value: "'minor'" }]
  }
]
```

Isso permite gerar assertions determinísticas:

```typescript
subject.classify(18);
expect(subject.category).toBe('adult');
```

### 2. Particionamento e valores de fronteira

**Estado: implementado para tipos e comparações escalares suportados.** O solver de cenários usa:

- partições de equivalência;
- valor imediatamente anterior ao limite;
- valor exato do limite;
- valor imediatamente posterior;
- valores para `null` e `undefined` quando aceitos pelo tipo;
- literais encontrados diretamente nas comparações;
- combinações representativas, limitadas a 64 por método;
- descarte de combinações cujas restrições escalares avaliadas não produzem efeitos.

Para `age >= 18`, por exemplo, os candidatos relevantes são `17`, `18` e `19`.

O objetivo não é gerar o produto cartesiano completo, mas selecionar a menor tabela de decisão que cubra os caminhos alcançáveis.

### 3. HTTP moderno por versão Angular

**Estado: implementado.** O setup HTTP é selecionado conforme a versão Angular detectada.

Configuração baseada em módulo:

```typescript
imports: [HttpClientTestingModule]
```

Configuração moderna baseada em providers:

```typescript
providers: [
  provideHttpClient(),
  provideHttpClientTesting()
]
```

O gerador:

- verificar a versão instalada do Angular;
- importar os providers somente quando disponíveis;
- manter compatibilidade com projetos antigos;
- validar a ordem dos providers;
- mantém a ordem `provideHttpClient()` antes de `provideHttpClientTesting()`.

A validação em fixtures reais para todas as versões Angular permanece como trabalho de integração separado.

### 4. Guards, resolvers e interceptors funcionais

**Estado: implementado para guards, resolvers e interceptors funcionais.** O analisador reconhece declarações como:

```typescript
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAuthenticated();
};
```

e gera a execução dentro do contexto de injeção:

```typescript
const result = TestBed.runInInjectionContext(() => authGuard(route, state));
```

O mesmo modelo atende:

- `CanActivateFn`;
- `CanMatchFn`;
- `CanDeactivateFn`;
- `ResolveFn`;
- `HttpInterceptorFn`.

Para interceptors, o gerador cria uma requisição tipada como `any`, um spy para `HttpHandlerFn`, configura retorno Observable e verifica a delegação. Transformações específicas e propagação de erro somente recebem cenários adicionais quando seus efeitos são resolvidos pela análise.

### 5. Signals derivados

**Estado: implementado para `signal()`, `computed()` e efeitos diretos de `effect()`.** A análise mapeia:

- Signals de origem;
- `computed()` e suas dependências;
- `effect()` e seus efeitos observáveis;
- registro de cleanup em `effect()`;
- alterações disparadas por `.set()` e `.update()`.

O cenário de `computed()` altera o Signal de origem, solicita detecção de mudanças em componentes e verifica o novo valor derivado. `linkedSignal()` e efeitos indiretos continuam fora do subconjunto implementado.

### 6. Análise de templates Angular

**Estado: implementado.** Quando `specForge.analyzeTemplates` está ativo, o SpecForge localiza o template inline ou o arquivo indicado por `templateUrl` e usa o compilador Angular instalado no workspace.

A AST do template identifica:

- `(click)`;
- `(submit)`;
- outros event bindings;
- `[formGroup]`;
- `formControlName`;
- inputs e outputs;
- métodos públicos chamados pelo template.

Esses métodos são priorizados como pontos de entrada da UI. A análise do template complementa a análise TypeScript.

O carregamento de `@angular/compiler` ocorre a partir do próprio workspace para respeitar a versão Angular do projeto e evitar incompatibilidades entre ASTs de template.

### 7. Estratégias extensíveis de mocks

**Estado: infraestrutura implementada.** O gerador possui um registro de estratégias; o fluxo especializado de diálogo/XHR/DOM/timers já foi extraído do gerador principal.

Contrato conceitual:

```typescript
interface GenerationStrategy {
  readonly id: string;
  applies(context: TestGenerationContext): boolean;
  requiresRxjsOf?(context: TestGenerationContext): boolean;
  append(
    lines: string[],
    context: TestGenerationContext,
    syntax: FrameworkSyntax
  ): void;
}
```

Áreas que podem receber estratégias adicionais:

- HttpClient;
- Router e ActivatedRoute;
- MatDialog;
- RxJS;
- timers;
- XMLHttpRequest;
- fetch;
- DOM;
- storage;
- Signals;
- formulários.

Spies automáticos em métodos da própria classe ainda não fazem parte do registro atual.

### 8. Descoberta de APIs públicas de serviços

Atualmente os mocks incluem principalmente os métodos observados no arquivo analisado. Uma evolução possível é consultar a declaração TypeScript do serviço injetado e descobrir sua API pública completa.

Essa evolução precisaria:

- resolver imports locais;
- localizar a declaração do tipo;
- respeitar métodos públicos;
- preservar overloads relevantes;
- evitar executar o serviço real;
- não atravessar caminhos fora do workspace.

O uso futuro de Proxy ou auto-mock dinâmico deve ser opcional, pois pode esconder erros de digitação e reduzir a segurança de tipos.

### 9. Reparo iterativo

**Estado: implementado para diagnósticos determinísticos suportados.** O fluxo de reparo usa `specForge.maxRepairAttempts`:

```text
gerar teste
  → executar
  → classificar diagnóstico
  → aplicar correção segura
  → executar novamente
```

Correções implementadas:

- adicionar provider ausente identificado por `NullInjectorError`;
- completar mock de método identificado como `is not a function`;

O reparo preserva o arquivo de produção, mantém alterações restritas ao `.spec.ts` e interrompe quando a correção não é determinística.

### 10. Cobertura real e realimentação

A coleta de cobertura fornece a evidência necessária para avaliar o gerador e orientar novas tentativas.

**Estado: implementado para relatórios Istanbul JSON e caminhos resolvíveis pelo CFG.** O fluxo:

1. executar o runner com cobertura habilitada;
2. solicitar os formatos Istanbul `json-summary` e `json`;
3. localizar exclusivamente o arquivo de produção analisado;
4. ler statements, branches, functions e lines;
5. associar lacunas a nós da AST e caminhos do CFG;
6. gerar cenários adicionais;
7. repetir até a meta, o limite de tentativas ou um bloqueio comprovado;
8. apresentar a cobertura medida ao usuário.

O SpecForge só declara a meta atingida quando o relatório do runner confirma os percentuais configurados.

### Estado das entregas

| Estado | Entrega |
| --- | --- |
| Implementado | Associação caminho → efeito e assertions exatas para o subconjunto resolvido pelo solver. |
| Implementado | Coleta Istanbul JSON, leitura de lacunas e realimentação do CFG. |
| Implementado | `provideHttpClientTesting()` condicionado à versão. |
| Implementado | Guards, resolvers e interceptors funcionais. |
| Implementado | Reparo determinístico de providers e métodos ausentes em mocks. |
| Implementado | Registro extensível de estratégias e estratégia XHR/diálogo/DOM/timers. |
| Implementado | AST opcional de templates inline e externos. |
| Implementado | `computed()` e efeitos diretos observáveis de `effect()`. |
| Evolução possível | Descoberta da API pública completa de serviços injetados. |

### Critérios de validação

Uma funcionalidade é tratada como implementada no projeto quando possui:

- testes unitários do analisador;
- testes do código gerado para Jasmine, Jest e Vitest aplicáveis;
- documentação atualizada;
- ausência de regras baseadas em nomes de métodos ou propriedades da aplicação;
- diagnóstico claro quando o cenário não puder ser resolvido automaticamente.

Fixtures Angular reais compilando e executando em múltiplas versões são o critério adicional para declarar uma combinação específica de Angular e runner como certificada. A suíte atual valida o analisador e o texto gerado, mas não constitui essa matriz completa de certificação.

## Desenvolvimento

```bash
npm install
npm run compile
npm test
npm run test:coverage
```

Abra o projeto no VS Code e pressione `F5` para iniciar o Extension Development Host.

## Suíte interna

A suíte interna valida descoberta, AST, geração por framework, HTTP, Observables, Signals básicos, ciclo de vida, pipes, guards baseados em classe, fluxo de controle e cenários reconhecidos do navegador.

Ela testa o código do SpecForge; não substitui uma matriz de integração com projetos Angular reais em todas as versões suportadas.

## Licença

Distribuído sob a licença MIT. Consulte [LICENSE](LICENSE).
