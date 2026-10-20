# Rede de Confiança para o seu agente (MCP)

Um servidor [MCP](https://modelcontextprotocol.io) (Model Context Protocol) que
deixa o seu assistente de IA (Claude, ou qualquer cliente que fale MCP)
**consultar** e **reportar** na Rede de Confiança em linguagem natural. Você
conversa; o assistente chama a rede.

Não tem dependência para instalar: é um arquivo, `mcp/server.mjs`, que precisa
só do Node 22 e do código deste repositório (ele reaproveita `src/normalizar.js`,
a mesma regra de normalização e hash da rede).

> **Estado:** a instância de referência da rede **ainda não está no ar**. Você
> precisa do endereço de uma instância (`RDC_API_URL`) para usar. Sem ele, as
> ferramentas respondem com uma instrução clara, e não inventam endereço.

## O valor que você consulta não sai da sua máquina

Ao consultar um e-mail, IP, domínio ou dispositivo, o servidor MCP calcula aqui
o hash (`sha256("rdc:v1:" + tipo + ":" + valor normalizado)`) e manda para a API
só `{ tipo, hash }`. O e-mail do seu cliente não vai para a rede, não entra em
log de ninguém e não passa por servidor de terceiros. O mesmo vale para
contestar. O servidor MCP também nunca imprime a sua chave nem o valor cru.

**Uma exceção, dita com todas as letras:** **reportar** envia o valor do
indicador à API, porque o contrato atual (`POST /v1/relatos`, ver
[docs/CONTRATO.md](../docs/CONTRATO.md)) só aceita `valor` e calcula o hash lá. A
API guarda apenas um hash protegido por segredo (HMAC), nunca o valor. Aceitar
hash também em relatos está no roadmap abaixo.

## O que o assistente consegue fazer

| ferramenta | para quê | precisa de chave? |
|---|---|---|
| `consultar_indicador` | "esse e-mail/IP/domínio é suspeito?" Devolve score, nível e quantos lojistas distintos relataram | não |
| `consultar_varios` | o mesmo, até 10 de uma vez (e-mail + IP + domínio de um pedido) | não |
| `reportar_fraude` | reportar uma fraude real que você viveu | **sim**, e **só com a sua confirmação** |
| `contestar_indicador` | "fui marcado por engano": abre contestação para um moderador | não |
| `pedir_chave_de_relator` | pedir à moderação a chave para poder reportar | não |
| `como_interpretar_o_score` | explica faixas, tetos e limites do score | não |

Consultar não muda nada em lugar nenhum. Reportar, contestar e pedir chave
escrevem na rede.

## Instalação

Em todos os casos você precisa:

1. de **Node 22** (`node --version`);
2. de uma cópia deste repositório (`git clone https://github.com/thiagopatzdorf/rede-de-confianca`);
3. do endereço da instância (`RDC_API_URL`, **https**; `http://` só vale para `localhost`, em testes).

Use o **caminho completo** de `mcp/server.mjs`, por exemplo
`/home/voce/rede-de-confianca/mcp/server.mjs`.

### Claude Code

```sh
claude mcp add rede-de-confianca -e RDC_API_URL=https://rede.exemplo.com.br -- node /caminho/para/rede-de-confianca/mcp/server.mjs
```

Para poder reportar, acrescente a chave de relator (veja "Reportar" abaixo):

```sh
claude mcp add rede-de-confianca -e RDC_API_URL=https://rede.exemplo.com.br -e RDC_CHAVE=sua-chave -- node /caminho/para/rede-de-confianca/mcp/server.mjs
```

Confira com `claude mcp list`.

### Claude Desktop

Abra o arquivo de configuração (menu Configurações, Desenvolvedor, Editar
configuração; é o `claude_desktop_config.json`) e acrescente:

```json
{
  "mcpServers": {
    "rede-de-confianca": {
      "command": "node",
      "args": ["/caminho/para/rede-de-confianca/mcp/server.mjs"],
      "env": {
        "RDC_API_URL": "https://rede.exemplo.com.br"
      }
    }
  }
}
```

Para reportar, coloque também `"RDC_CHAVE": "sua-chave"` dentro de `env`.
Reinicie o Claude Desktop. No Windows use o caminho com barras duplas
(`C:\\Users\\voce\\rede-de-confianca\\mcp\\server.mjs`).

### Qualquer cliente MCP (stdio)

Configure um servidor do tipo **stdio** com o comando `node`, o argumento
`/caminho/para/rede-de-confianca/mcp/server.mjs` e as variáveis de ambiente:

| variável | obrigatória | o que é |
|---|---|---|
| `RDC_API_URL` | sim | endereço da instância (https; http só em localhost). Sem ela, as ferramentas explicam o que falta |
| `RDC_CHAVE` | não | chave de relator; só é usada em `reportar_fraude` |

O servidor fala JSON-RPC 2.0 em linhas pelo stdin/stdout; os logs vão para o
stderr. Cada chamada à API tem limite de 10 segundos e **nunca** é repetida
sozinha.

## Exemplos de conversa

**Dono de uma loja virtual:**

> **Você:** Esse pedido de R$ 1.200 veio do e-mail `compras.rapidas+x@gmail.com`
> e do IP 177.10.20.30. Confere na Rede de Confiança?
>
> **Assistente** (chama `consultar_varios`): O e-mail está como *suspeito*
> (score 58, 2 lojistas diferentes relataram, o último em setembro) e o IP como
> *desconhecido*. Lembre que é uma pista, não uma prova: eu não recusaria o
> pedido por isso. Sugiro confirmar a compra por telefone ou WhatsApp e conferir
> o endereço de entrega antes de despachar.

**Reportar (sempre com confirmação):**

> **Você:** Esse cliente deu chargeback no pedido 4821. Reporta na rede.
>
> **Assistente** (chama `reportar_fraude` sem `confirmar`): *Nada foi enviado
> ainda.* Eu reportaria um e-mail, categoria `chargeback`, código `9f3a1c07…`,
> com a evidência "chargeback do pedido 4821". Não vai CPF, cartão nem nome. É
> isso mesmo, você confirma?
>
> **Você:** Confirmo.
>
> **Assistente** (chama `reportar_fraude` com `confirmar: true`): Enviado,
> protocolo `...`.

**Quem foi marcado por engano:**

> **Você:** Minha loja foi barrada por um parceiro e acho que meu domínio está
> marcado errado. Como contesto?
>
> **Assistente** (chama `contestar_indicador`): Abri a contestação. Um moderador
> humano vai analisar; enquanto isso o score não muda por causa dela.

## Reportar exige chave e confirmação

- **Chave.** Reportar só funciona com uma chave de relator em `RDC_CHAVE`. Sem
  chave, peça uma: o assistente tem a ferramenta `pedir_chave_de_relator`
  (nome, contato e endereço da loja; um moderador avalia, nada é criado na hora).
- **Confirmação.** `reportar_fraude` **não envia nada** a menos que receba
  `confirmar: true`. Sem isso ele devolve só o que faria (tipo, categoria, os 8
  primeiros caracteres do hash e o aviso de LGPD) para o assistente mostrar a
  você e perguntar. Uma denúncia errada marca uma pessoa de verdade; por isso o
  passo humano é parte do desenho, não opcional.
- **Sem dado pessoal.** A evidência é recusada **antes de qualquer envio** se
  parecer CPF ou número de cartão. Não coloque nome completo, endereço nem
  telefone de ninguém. Relate o fato ("chargeback do pedido 1234").
- **A chave é segredo.** Fica só na configuração do seu cliente MCP. O servidor
  nunca a imprime nem a repete em resposta, e não segue redirecionamento da API
  (para ela não ser mandada a outro endereço). Não cole a chave na conversa.

## Como o assistente deve usar o resultado

O servidor orienta o modelo, e vale para você também: o score é **pista, não
prova**; **nunca bloqueie sozinho**; em *suspeito* ou *alto risco*, faça revisão
manual ou confirme por outro canal; e **"desconhecido" não quer dizer
"confiável"**. A ferramenta `como_interpretar_o_score` explica as faixas, os
tetos e a meia-vida de 90 dias.

## Erros que você pode ver

Todos chegam em português e dizem o que fazer: `429` (muitas chamadas, espere),
`401` (chave errada ou desativada), `403` (chave suspensa), `409` (relato já
enviado nos últimos 30 dias), `400` (campo inválido ou dado pessoal), API fora do
ar ou lenta (10 s).

## Desenvolvimento

```sh
node --test tests/mcp.test.mjs
```

Os testes sobem `mcp/server.mjs` como processo filho e conversam por stdio com
uma API HTTP falsa local. Eles provam, entre outras coisas, que o valor cru não
aparece no corpo enviado à API, que reportar sem `confirmar` não faz request, que
CPF na evidência é recusado antes de qualquer request e que a chave não vaza.

Para experimentar à mão, sem cliente MCP:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/server.mjs
```

## Roadmap do MCP

- [ ] Servidor **remoto** (HTTP) para quem não quer instalar nada. Exigiria
      ferramentas que recebam **só o hash**, para o valor cru não passar pelo
      servidor remoto; o hash teria de ser calculado no cliente.
- [ ] Aceitar `hash` em `POST /v1/relatos`, para reportar sem enviar o valor
- [ ] SDK de cliente que o servidor MCP e outros integradores compartilhem
- [ ] Pacote no npm (`npx rede-de-confianca-mcp`), em vez de apontar para um arquivo
- [ ] Instância de referência no ar, para haver um `RDC_API_URL` para recomendar

## Licença

Código em `mcp/`: [Apache-2.0](../LICENSE), como `src/`. Esta documentação:
[CC0 1.0](../LICENSE-DOCS).
