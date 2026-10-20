# Moderação e contestação

O score é pista, e pista errada precisa ter conserto rápido. Este documento diz
como se contesta, quem decide e o que acontece depois.

## Fluxo da contestação

1. **Abertura.** Qualquer pessoa envia `POST /v1/contestacoes` com tipo, valor e
   motivo (10 a 500 caracteres), e opcionalmente um contato para a resposta.
   O estado é `aberta`. O contestante pode mandar o hash em vez do valor.
2. **Enquanto `aberta`, o score não muda.** Qualquer pessoa abre contestação sem
   prova; se isso enfraquecesse relatos, contestar seria uma arma contra relato
   verdadeiro.
3. **Triagem.** O moderador confere a prova de controle (veja abaixo) e registra
   o resultado em `POST /v1/admin/contestacoes/:id/triagem` com
   `{prova_de_controle: true|false}`. Com prova, a contestação vira
   `em_analise`: **o score não muda**. A prova mede que o contestante controla o
   indicador, não que o relato seja falso, e o fraudador também controla o
   e-mail dele; só a decisão `procedente` derruba relatos (regra 4 do
   contrato). Sem prova, ela é encerrada como `improcedente`. A fila está em
   `GET /v1/admin/contestacoes?estado=aberta`.
4. **Decisão em até 7 dias corridos** da abertura, via
   `POST /v1/admin/contestacoes/:id/decidir` com `procedente` ou
   `improcedente` e uma nota que explica o porquê. `procedente` só é aceita
   depois da triagem com prova. O moderador pode listar em `relato_ids` quais
   relatos derrubar; só os relatores desses relatos perdem reputação. Sem a
   lista, caem todos os relatos do indicador até o instante da decisão.
5. **Resposta** ao contato informado, se houver, com a nota.

Se o prazo vencer sem decisão, o caso sobe para outro moderador e o atraso entra
no relatório de transparência.

## Prova de controle

Para evitar que terceiros contestem por quem não são, o moderador pede
algo simples: responder de um e-mail, publicar um registro TXT no domínio ou
mostrar controle do IP (quando possível). Sem prova, a contestação é encerrada
como improcedente e o contestante não recebe detalhes além do resultado; ele
pode abrir outra com a prova.

**A prova de controle é só o primeiro filtro.** Ela mostra quem é o titular,
não que o titular é inocente. Para decidir `procedente` o moderador precisa de
algo a mais que desminta o relato: o pedido do cliente, o comprovante, a
conversa com o relator que não sustenta o que disse. A nota da decisão diz o
que foi.

## Critérios

**Procedente** (o relato é ignorado no score) quando:

- o relato não corresponde à categoria apontada;
- o indicador foi usado por outra pessoa sem culpa do titular (e-mail ou conta
  invadidos, IP de rede compartilhada, CGNAT ou VPN);
- o problema foi resolvido e comprovado (domínio devolvido, conta recuperada);
- há indício de relato malicioso ou duplicado de má-fé;
- o relator não consegue sustentar o relato quando consultado.

**Improcedente** (o relato continua contando) quando:

- a contestação não traz fato novo nem contradiz o relato;
- há mais de um relator independente e coerente, e a explicação do
  contestante não os afasta;
- não foi possível verificar nada e a evidência é consistente.

Dúvida real não é improcedência automática: o moderador pode pedir mais
informação uma vez, e o prazo de 7 dias é suspenso até a resposta (máximo de
5 dias de espera).

## Reputação de quem relatou errado

A reputação do relator cai quando contestação procedente refuta o relato dele
(`refutados` na fórmula do contrato). Efeitos práticos:

- relatos futuros dele pesam menos no score;
- relatos com reputação abaixo de 0,3 não contam para `alto_risco` (relator novo
  começa em 0,2 e só passa de 0,3 depois de corroborado por um relator
  **verificado**, ou por alguém que um verificado corroborou);
- o erro de boa-fé não gera punição além disso: o erro mede onde falta regra, e
  o relator é avisado do motivo;
- reincidência ou evidência de má-fé leva a suspensão
  (`POST /v1/admin/relatores/:id/suspender`) ou, nos casos graves, à
  desativação da chave (`/desativar`, que revoga a chave e começa o prazo de 90
  dias para apagar nome e contato), decidida por dois moderadores. Relator
  suspenso ou desativado deixa de corroborar os outros.

## Verificar relator

Toda chave nasce **não verificada**, inclusive a aprovada de uma solicitação. É
o moderador, e só ele, quem marca um relator como verificado
(`POST /v1/admin/relatores/:id/verificar`; `/desverificar` desfaz), e só
depois de checar fora da API que a loja existe e é de quem diz ser: o site
abre e vende de fato, o domínio e o contato batem com o pedido, o CNPJ ou o
perfil público confere. Não use só a `loja_url` do formulário: três domínios
baratos com uma página de loja foram exatamente o ataque.

O verificado é a âncora da confiança: sem ao menos um verificado entre os
relatores, um indicador nunca chega a `alto_risco`, e só relator verificado, ou
corroborado por um, corrobora os outros. Por isso:

- verificar é lento e deliberado; na dúvida, não verifique;
- se um verificado se mostra malicioso, `/desverificar` e `/suspender` na hora,
  e remova os relatos dele com motivo `malicioso`;
- conta com menos de 7 dias pesa 0 no score, qualquer que seja o estado dela,
  então dá tempo de verificar antes de o relator influenciar alguém.

## Abuso: relato malicioso, inclusive contra concorrente

Sinais: vários relatos do mesmo relator contra concorrentes diretos, relatos
sem evidência concreta, picos coordenados em um indicador, relatores recém
criados que se confirmam entre si.

Resposta:

1. Os relatos suspeitos são marcados e analisados por moderador que não tenha
   relação com os envolvidos.
2. Se for confirmado, os relatos são removidos com motivo `malicioso`
   (`POST /v1/admin/relatos/:id/remover`; saem do score e perdem a evidência) ou
   derrubados por decisão, a chave é suspensa
   (`POST /v1/admin/relatores/:id/suspender`) e a reputação despenca. Suspender
   **não** apaga os relatos que o relator já fez: os pendentes seguem contando
   até serem removidos um a um.
3. O caso entra no relatório agregado, sem identificar pessoas.

Moderador declara conflito de interesse e deixa o caso. Quem usa a rede para
prejudicar outro viola o [código de conduta](../CODE_OF_CONDUCT.md).

Contestação abusiva (em massa, para zerar sinais verdadeiros) também é abuso:
o limite de 10 por hora por balde de rede (IPv4 `/24`, IPv6 `/64`) é a primeira barreira, e moderador pode ignorar
contestações repetidas sem fato novo.

## Recurso

Quem discorda da decisão pode pedir **recurso uma vez**, em até 14 dias, com
fato novo ou apontando erro no critério. Outro moderador, que não decidiu o
caso, revisa em até 7 dias e a decisão dele é final na instância. Em caso
de impasse, o mantenedor decide e registra o motivo. O recurso é por e-mail ao
endereço informado na resposta, citando o id da contestação.

## Registro e transparência

Toda decisão guarda quem decidiu, quando e a nota. Publicamos periodicamente
números agregados (contestações abertas, procedentes e improcedentes, tempo
médio de decisão, chaves suspensas), sem dado pessoal. Veja
[GOVERNANCA.md](GOVERNANCA.md).
