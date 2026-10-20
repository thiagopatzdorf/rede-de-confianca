# Contrato técnico (v1.2)

Fonte única dos nomes e formas de dado. Código, testes e docs seguem este
arquivo; se algo aqui estiver errado, corrija aqui no mesmo PR.

## Indicadores

Tipos: `ip`, `email`, `dominio`, `dispositivo`.

Normalização (`src/normalizar.js`, função `normalizar(tipo, valor)` → string
ou lança `Error` com `.codigo = "indicador_invalido"`):

- `ip`: IPv4 em notação decimal pontuada canônica (sem zeros à esquerda).
  IPv6: expandir e manter só o prefixo /64, em hex minúsculo `xxxx:xxxx:xxxx:xxxx::/64`.
  IP privado, loopback, link-local e reservado são recusados. IPv6 que
  embrulha um IPv4 vira o IPv4 e segue a regra dele (privado é recusado):
  IPv4 mapeado (`::ffff:a.b.c.d`), 6to4 (`2002::/16`, o IPv4 são os 32 bits
  seguintes) e NAT64 (`64:ff9b::/96`, os 32 bits finais). São recusados todo o
  `::/8` (não especificado, loopback e IPv4-compatível como `::1.2.3.4`),
  `100::/64` (descarte), `2001::/23` (protocolos IETF, inclusive Teredo),
  `2001:db8::/32` e `3fff::/20` (documentação), ULA, link-local e multicast.
- `email`: minúsculas, sem espaços; remove `+tag` da parte local; em
  `gmail.com`/`googlemail.com` remove pontos da parte local e normaliza o
  domínio para `gmail.com`. Domínio em punycode. **Limite documentado:** só o
  Gmail tem os pontos ignorados. Domínio próprio hospedado no Google
  Workspace (ou com catch-all) trata `b.ad@empresa.com.br` e
  `bad@empresa.com.br` como a mesma caixa, mas a rede os vê como dois
  indicadores; descobrir isso exigiria consulta DNS por relato, e não vale o
  custo. Quem reporta um domínio próprio deve também reportar o `dominio`.
- `dominio`: minúsculas, punycode, sem `www.` inicial, sem ponto final.
- `dispositivo`: string opaca de 8 a 128 caracteres `[A-Za-z0-9_-]`, como veio
  (impressão digital calculada pelo cliente; a rede nunca vê o dispositivo).

Hash do cliente (`hashIndicador(tipo, valor)`, exportada por `src/normalizar.js`
para os clientes → hex minúsculo de 64): `sha256("rdc:v1:" + tipo + ":" + normalizado)`.
O cliente pode calcular o hash e consultar sem enviar o valor (exemplo no README).
Esse hash é **público**: é o que viaja na API.

**Hash guardado (v1.2).** O servidor nunca grava o sha256 público. Ele grava
`HMAC-SHA256(PEPPER, hash_do_cliente)` (hex de 64, `hashArmazenado` em
`src/segredos.js`) em `relatos.indicador_hash` e `contestacoes.indicador_hash`,
e usa HMAC também na chave dos limites de uso. Sem o segredo, um banco vazado
não é reversível por força bruta (o IPv4 inteiro cabia em horas de CPU contra o
sha256 puro). Consequências:

- `PEPPER` é segredo do Worker (`wrangler secret put PEPPER`), **no mínimo 32
  caracteres**. Sem ele (ausente ou curto) **todas** as rotas, `/v1/saude`
  inclusive, respondem `500 { "erro": "configuracao" }` e nada é gravado.
- **Trocar o PEPPER invalida todos os relatos e contestações já gravados** (os
  hashes deixam de casar). Guarde-o no cofre e trate a troca como migração.
- O `ADMIN_TOKEN` também exige **no mínimo 32 caracteres**; mais curto, as rotas
  de moderação respondem `401` como se o token estivesse errado.
- O esquema (`001_inicial.sql`) foi alterado no lugar, **sem migração**: não
  havia dado em produção quando o HMAC, `verificado` e `desativado_em` entraram.
  Depois do primeiro deploy, qualquer mudança de esquema vira arquivo novo.

O valor cru **nunca** é gravado nem registrado em log, e **nunca vai na URL**. Limite honesto: o hash
público de IP e de e-mail comum é pseudonimização, não anonimato (o espaço é pequeno o
bastante para ser adivinhado); por isso não existe exportação em massa.

## Relato (objeto de domínio, usado por `pontuar`)

```
{ id: string, tipo_indicador, indicador_hash, categoria, relator_id: string,
  criado_em: number /* ms epoch */,
  contestacao: null | "aberta" | "em_analise" | "procedente" | "improcedente" }
```

`contestacao` é o estado que vale para ESTE relato:

- `procedente`: o relato foi derrubado; é **ignorado** na pontuação. É o único
  estado que mexe no score, e só um moderador o decide.
- `aberta`, `em_analise`, `improcedente`, `null`: não alteram o peso.
  Contestação `aberta` não altera o score porque qualquer pessoa abre uma sem
  prova. `em_analise` (a prova de controle foi aceita) **também não**: desde a
  v1.2 ela não corta mais o peso, porque provar que se controla o indicador mede
  identidade, não inocência (o fraudador controla o e-mail dele). Cortar peso
  por isso dava a ele um jeito de baixar o próprio score.

Categorias e peso base (0 a 1): `chargeback` 1.0, `cartao_testado` 0.9,
`conta_falsa` 0.6, `phishing` 0.8, `bot_abuso` 0.5, `outro` 0.2.

## Pontuação (`src/pontuacao.js`)

`pontuar({ relatos, agora, reputacaoDe, relatorDe })` → 
`{ score: 0..100 (inteiro), nivel: "desconhecido"|"suspeito"|"alto_risco", relatores_distintos: number, ultimo_relato_em: number|null, motivos: string[] }`

`relatorDe(relator_id)` → `{ verificado: boolean, criado_em: ms }`. Se ausente
no chamador de teste, ninguém é verificado e todos são antigos; o Worker sempre
o passa, e relator desconhecido vale como conta nova não verificada.

Regras (cada uma tem teste com nome que descreve a falha que impede):

1. Meia-vida de 90 dias: peso do relato × `0.5 ^ (idade_dias / 90)`.
2. `reputacaoDe(relator_id)` → 0..1 multiplica o peso do relato.
3. Um relator conta uma vez por categoria (o de maior peso); repetir não soma.
4. Relato `procedente` é ignorado; os demais estados de contestação não mudam o peso.
5. **Conta com menos de 7 dias pesa 0.** Continua contando em
   `relatores_distintos`, mas não move o score nem conta como relator efetivo.
6. Soma saturante: `score = round(100 * (1 - exp(-soma / 1.5)))`.
7. Teto por evidência, contando relatores **efetivos** (7 dias ou mais e reputação > 0):
   **1 relator efetivo: `score ≤ 24`** (nunca passa de `desconhecido`);
   **2: `score ≤ 49`** (no máximo `suspeito`).
8. **`alto_risco` (score ≥ 75) exige ≥ 3 relatores distintos com reputação ≥ 0.3
   dos quais ≥ 1 é verificado** (`relatores.verificado = 1`). Sem isso o teto é
   74, para qualquer número de relatores. Para tipo `ip` exige ainda ≥ 5
   relatores efetivos (IP compartilhado, CGNAT, VPN: sinal fraco); o teto de IP
   era 79, acima do limiar de 75, e por isso nunca barrava nada.
9. Níveis: `desconhecido` < 25 ≤ `suspeito` < 75 ≤ `alto_risco`.
10. Função pura e determinística: mesma entrada, mesma saída; `agora` é parâmetro.

Garantia que sai das regras 5, 7 e 8: **N contas falsas sem nenhum verificado
ficam em `desconhecido` (novas, ou 1 conta) ou `suspeito` (no máximo, 74), para
qualquer N**. Prova: `tests/pontuacao.test.mjs` ("N contas falsas…") e
`tests/redteam.test.mjs`.

Reputação do relator (`reputacaoDoRelator({ confirmados, refutados, idade_dias })` → 0..1):

    base  = (0.2 + confirmados) / (1 + confirmados + 2 * refutados)      limitada a [0, 1]
    bonus = confirmados > 0 ? 0.1 * min(1, idade_dias / 180) : 0
    reputação = limitar01(base + bonus)

- **Relator novo começa em 0.2** e **só passa de 0.3 depois de corroboração**:
  sem `confirmados` não há bônus de antiguidade, então 0.2 é o teto de quem
  nunca foi corroborado. Com 1 corroboração a base já é 0.6.
- **`confirmados` = número de relatores DISTINTOS, habilitados, que reportaram
  o mesmo `indicador_hash`** com relatos de pé (nem derrubados nem removidos).
  Não é número de relatos nem de categorias: o mesmo corroborador em 50
  indicadores vale 1. No máximo 10 corroboradores por relator são lidos
  (verificados primeiro, depois os mais antigos); a reputação satura antes.
- **Quem corrobora (habilitado)**, `habilitadoACorroborar`: o relator
  **verificado**, ou o que tem **reputação ≥ 0.3 obtida por corroboração de
  verificado** (reputação calculada só com corroboradores verificados) e 7 dias
  de conta. **Relator novo e não verificado não corrobora ninguém**, e relator
  suspenso ou com chave desativada não corrobora (os relatos dele seguem
  contando, ver Moderação). A definição não é circular: a promoção tem um passo,
  e o início é sempre um verificado pelo moderador. Um grupo de contas sem
  verificado por perto nunca habilita ninguém, qualquer que seja o tamanho.
- `refutados` = relatos do relator derrubados por decisão (tabela
  `relatos_derrubados`) mais os removidos com motivo `malicioso`. Remoção por
  `titular` ou `expirado` não é culpa do relator.
- Relator desconhecido para o cálculo usa 0.2, nunca 0 nem 1.

Custo (v1.2): a reputação sai de **3 consultas agregadas**, qualquer que seja o
número de relatores (eram 3 por relator: 304 com 100 relatores). Uma consulta
pública lê no máximo **100 relatos** do indicador, os de relator verificado
primeiro e depois os mais recentes, e **escreve no D1 só o contador de limite**
(uma escrita; a poda de contadores velhos é do cron).

## API (Worker Cloudflare + D1, binding `DB`)

Todas as respostas são JSON. Erros: `{ "erro": "<codigo>", "mensagem": "..." }`.

Regras de entrada, valem para todo POST com corpo:

- `Content-Type: application/json` (com ou sem `; charset=`). Qualquer outro tipo
  é `415 tipo_de_conteudo`, **antes** de gastar limite: com `text/plain` uma
  página hostil dispararia POST sem preflight pelo navegador do visitante.
- Corpo de no máximo 8192 **bytes**. O Worker confere o `Content-Length` e lê o
  corpo por pedaços, parando ao passar do teto: `413 corpo_grande` sem
  bufferizar tudo.
- Campos de texto livre (`nome`, `contato`, `motivo`, `evidencia`, `nota`,
  `loja_url`) recusam, com `400 campo_invalido`, caracteres de controle (`Cc`),
  de formatação (`Cf`: espaço de largura zero, bidi como U+202E, BOM, hífen
  suave), separadores de linha e parágrafo e preenchimentos invisíveis (Hangul,
  Braille em branco). `evidencia`, `motivo` e `nota` aceitam `\n` e `\t`; `nome`,
  `contato` e `loja_url` são de uma linha.
- `evidencia`, `motivo` e `loja_url` passam por varredura de **dado pessoal**:
  sequência que pareça CPF (com ou sem pontuação, dígito verificador conferido)
  ou número de cartão (13 a 19 dígitos, Luhn), depois de NFKC, é `400
  dado_pessoal`. A mensagem nunca repete o que achou. Pode recusar número de
  pedido que passe no Luhn por acaso (cerca de 1 em 10): mascare-o.
- Erros de configuração: sem `PEPPER` válido, `500 configuracao`.

| rota | quem | corpo / resposta |
|---|---|---|
| `GET /v1/saude` | público | `{ "ok": true, "versao": "1" }` |
| `POST /v1/consulta` | público, limite por balde de rede | `{ tipo, valor }` **ou** `{ tipo, hash }` (hash = hex de 64; valor e hash juntos, ou nenhum, é `400`) → `{ score, nivel, relatores_distintos, ultimo_relato_em }` (nunca lista relatos nem relatores) |
| `GET /v1/consulta?tipo=&hash=` | público, limite por balde de rede | igual ao POST por hash. **`?valor=` não existe**: o valor cru iria para log de borda e de proxy; qualquer GET com `valor` responde `400 valor_na_url` sem repeti-lo |
| `POST /v1/relatos` | relator (`Authorization: Bearer <chave>`) | `{ tipo, valor, categoria, evidencia? (≤280) }` → `201 { id }`; mesmo relator + indicador + categoria em 30 dias → `409 duplicado`; relator suspenso → `403 relator_suspenso` |
| `POST /v1/contestacoes` | público, limite por balde de rede | `{ tipo, valor \| hash, motivo (10..500), contato? }` → `201 { id }`, nasce `aberta` |
| `POST /v1/relatores/solicitacoes` | público, 3/hora por balde de rede | `{ nome, contato, loja_url (http/https) }` → `201 { id }`; nasce `pendente`, não cria chave |
| `POST /v1/admin/relatores` | moderador (`Authorization: Bearer <ADMIN_TOKEN>`) | `{ nome, contato }` → `201 { relator_id, chave }` (a chave aparece **uma vez**; no banco fica só o hash) |
| `GET /v1/admin/contestacoes?estado=` | moderador | `{ contestacoes: [...] }` (até 100, mais antigas primeiro; `estado` opcional: `aberta`, `em_analise`, `procedente`, `improcedente`); traz só o hash do indicador |
| `POST /v1/admin/contestacoes/:id/triagem` | moderador | `{ prova_de_controle: boolean }`. `true` → `em_analise` (habilita a decisão `procedente`, **não muda o score**); `false` → `improcedente` (encerra). Só vale para `aberta`, senão `409 estado_invalido` |
| `POST /v1/admin/contestacoes/:id/decidir` | moderador | `{ decisao: "procedente"\|"improcedente", nota, relato_ids? }` → `{ id, estado }`. `procedente` exige `em_analise` (`409 sem_triagem`); `improcedente` vale de `aberta` ou `em_analise`; segunda decisão é `409 ja_decidida` |
| `POST /v1/admin/relatores/:id/suspender` e `/reativar` | moderador | `{ id, suspenso }`; idempotentes; `404` se o relator não existe |
| `POST /v1/admin/relatores/:id/verificar` e `/desverificar` | moderador | `{ id, verificado }`; idempotentes; `404` se o relator não existe. O moderador só verifica depois de checar, fora da API, que a loja existe e é de quem diz ser. Relator criado ou aprovado nasce **não verificado** |
| `POST /v1/admin/relatores/:id/desativar` | moderador | revoga a chave (`ativo = 0`, daí em diante `401`) e grava `desativado_em`; repetir não renova a data; `404` se não existe |
| `POST /v1/admin/relatos/:id/remover` | moderador | `{ motivo: "malicioso"\|"titular"\|"expirado" }` → tombstone (abaixo); repetir é `409 ja_removido` |
| `POST /v1/admin/relatos/:id/apagar-evidencia` | moderador | zera só a evidência; o relato continua no score |
| `GET /v1/admin/solicitacoes?estado=` | moderador | `{ solicitacoes: [...] }` (`pendente`, `aprovada`, `recusada`) |
| `POST /v1/admin/solicitacoes/:id/aprovar` | moderador | cria o relator e devolve `{ relator_id, chave }` **uma vez**; `409 ja_decidida` se já decidida |
| `POST /v1/admin/solicitacoes/:id/recusar` | moderador | `{ nota? }` → `{ id, estado: "recusada" }` |

### Contestação: estados e decisão por relato

Estados: `aberta` → `em_analise` (triagem com prova) → `procedente` \| `improcedente`.
`aberta` também pode ir direto a `improcedente` (triagem sem prova, ou decisão).

- `aberta` e `em_analise` **não alteram o score**. A triagem só decide se a
  contestação pode virar `procedente`; quem derruba relato é a decisão
  `procedente`, tomada por moderador. (Até a v1.1 `em_analise` cortava o peso
  pela metade; o fraudador provava controle do próprio e-mail e baixava o
  próprio score.)
- **Decisão por relato.** `decidir` aceita `relato_ids` (só com `procedente`, 1 a
  100 ids, todos relatos desse indicador, senão `400 relato_invalido` e nada é
  gravado). Só os relatos listados são derrubados, e só os relatores deles são
  refutados. Sem `relato_ids`, vale para todos os relatos do indicador até o
  instante da decisão; quem reporta depois traz fato novo. A decisão é gravada
  em `relatos_derrubados`; a tabela `relatos` não é alterada.

### Moderação de relator e de relato

- **Suspender** (`suspenso_em`) bloqueia novos relatos (`403`), mas **não toca
  nos relatos que o relator já fez: os pendentes seguem contando no score**, a
  não ser que o moderador os remova um a um. Suspender não revoga a chave
  (`ativo = 0` é revogação, via `/desativar`, e responde `401`). Relator
  suspenso ou desativado deixa de poder corroborar outros.
- **Verificar** é a única entrada de confiança na rede: ver "Quem corrobora".
- **Remover relato** deixa um *tombstone*: a linha permanece com `removido_em` e
  `removido_motivo`, a evidência é apagada, o relato some do score, da contagem
  de relatores distintos, de `ultimo_relato_em`, da corroboração e do dedupe de
  30 dias. `malicioso` conta como refutação do relator.

### Expiração (`scheduled`, cron diário em `wrangler.toml`)

`src/expiracao.js`: remove relatos com mais de 730 dias (24 meses) e as linhas
de `relatos_derrubados` deles, remove contestações **decididas** há mais de 730
dias (nunca as `aberta`/`em_analise`) e poda os contadores de `limites`
vencidos. `prazosDeExpiracao(agora)` é a parte pura. Efeito colateral
assumido: ao expirar um relato derrubado, a refutação some e a reputação do
relator se recupera.

Dados pessoais de quem pede ou tem chave, **90 dias** (`RETENCAO_PESSOAL_DIAS`):

- `solicitacoes_relator` **pendente** há 90 dias (desde `criado_em`): a linha é apagada;
- **recusada**: a linha é apagada 90 dias depois da recusa (`decidido_em`);
- **aprovada**: 90 dias depois da aprovação, `nome`, `contato` e `loja_url` viram
  `[apagado]` e a linha fica (aponta para o relator);
- **relator desativado** (`ativo = 0`, por `/desativar`): 90 dias depois de
  `desativado_em`, `nome` e `contato` viram `[apagado]` e `chave_hash` vira
  `apagado:<id>`. A linha e os relatos ficam: a reputação de quem foi
  corroborado por ele depende deles. Relator desativado direto no banco, sem
  `desativado_em`, ganha a data na primeira passada do cron.

### Limites de uso

| o quê | limite | contado por |
|---|---|---|
| consulta pública (POST e GET) | 300 / minuto | balde de rede |
| contestação | 10 / hora | balde de rede |
| solicitação de chave | 3 / hora | balde de rede |
| tentativa **falha** de moderação | 10 / hora | balde de rede |
| relatos de um relator | 200 / dia | relator |

**Balde de rede** = IPv4 por `/24`, IPv6 por `/64` (IPv4 mapeado em IPv6 conta
como o IPv4); a chave gravada é `HMAC(PEPPER, balde)`, nunca o IP. Quem tem um
`/64` tem 2^64 endereços, então contar por endereço deixava 500 consultas, 300
contestações e 200 solicitações passarem com IP rotativo. Os tetos são do balde
inteiro e foram escolhidos para a loja pequena atrás de NAT não esbarrar: uma
loja faz poucas consultas por minuto (cerca de 4 por pedido), longe de 300; o
preço é que lojas num mesmo `/24` de hospedagem dividem a cota, e uma varredura
a partir de um balde fica em cerca de 432 mil consultas por dia. Depois de 10
falhas de moderação no balde, nem o token certo passa até a janela virar
(`429`, com `Retry-After`); uso legítimo não gasta essa cota.

Evidência é guardada, nunca devolvida em rota pública, e é varrida na entrada
em busca de CPF e cartão (ver Regras de entrada).

## Banco (`schema/001_inicial.sql`)

Esquema em `schema/001_inicial.sql` (v1) e `schema/002_v1_1.sql` (migração, aplicada em ordem).

Tabelas: `relatores(id, nome, contato, chave_hash, criado_em, ativo, verificado, desativado_em, suspenso_em)`,
`relatos(id, tipo_indicador, indicador_hash, categoria, relator_id, evidencia, criado_em, removido_em, removido_motivo)`
(`indicador_hash` é o HMAC com pepper, ver Hash guardado),
`contestacoes(id, tipo_indicador, indicador_hash, motivo, contato, estado, criado_em, decidido_em, nota)`,
`relatos_derrubados(relato_id, contestacao_id, derrubado_em)`,
`solicitacoes_relator(id, nome, contato, loja_url, estado, criado_em, decidido_em, relator_id, nota)`,
`limites(chave, janela, contagem)`.
Estado de contestação: `aberta`, `em_analise`, `procedente`, `improcedente`.
Estado de solicitação: `pendente`, `aprovada`, `recusada`.

## Arquivos e donos

- `src/normalizar.js`, `src/pontuacao.js`, `tests/normalizar.test.mjs`, `tests/pontuacao.test.mjs` — núcleo
- `src/worker.js`, `src/limites.js`, `src/expiracao.js`, `src/segredos.js`, `src/dados-pessoais.js`, `schema/*.sql`, `wrangler.toml`, `tests/api.test.mjs`, `tests/redteam.test.mjs`, `tests/dados-pessoais.test.mjs`, `tests/_ambiente.mjs` (D1 falso compartilhado, não é teste) — API
- `mcp/server.mjs`, `mcp/README.md`, `tests/mcp.test.mjs` — servidor MCP (cliente da API; reaproveita `src/normalizar.js` e `src/dados-pessoais.js`, não duplica regra)
- `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `docs/PRIVACIDADE.md`, `docs/MODERACAO.md`, `docs/GOVERNANCA.md` — docs
- Teste: `node --test` (Node 22, sem dependências npm). Não use `node --test tests/`: no Node 22 a pasta é tratada como módulo e falha.
