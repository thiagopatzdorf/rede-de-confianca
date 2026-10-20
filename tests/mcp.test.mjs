// Testes do servidor MCP (mcp/server.mjs): sobe o servidor como processo filho,
// fala JSON-RPC por stdio e usa uma API HTTP falsa local que imita o contrato.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { hashIndicador } from "../src/normalizar.js";

const SERVIDOR = new URL("../mcp/server.mjs", import.meta.url).pathname;
const CHAVE = "rdc_chave_de_teste_NAO_VAZAR_0123456789abcdef";
const EMAIL = "Cliente.Suspeito+promo@Exemplo-Loja.com";
const CPF_VALIDO = "529.982.247-25";
const CARTAO_VALIDO = "4111 1111 1111 1111";

// ---------- API falsa ----------

let api;
let base;
let requisicoes;
let resposta; // (req) => { status, corpo, headers? }

before(async () => {
  api = createServer((req, res) => {
    const pedacos = [];
    req.on("data", (c) => pedacos.push(c));
    req.on("end", () => {
      const bruto = Buffer.concat(pedacos).toString("utf8");
      let corpo = null;
      try {
        corpo = bruto ? JSON.parse(bruto) : null;
      } catch {}
      const r = { metodo: req.method, caminho: req.url, headers: req.headers, corpo, bruto };
      requisicoes.push(r);
      const { status = 200, corpo: saida = {}, headers = {} } = resposta(r);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(saida));
    });
  });
  await new Promise((ok) => api.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${api.address().port}`;
});
after(() => api.close());
beforeEach(() => {
  requisicoes = [];
  resposta = respostaPadrao;
});

function respostaPadrao(r) {
  if (r.metodo === "POST" && r.caminho === "/v1/consulta") {
    return { corpo: { score: 62, nivel: "suspeito", relatores_distintos: 2, ultimo_relato_em: Date.UTC(2026, 8, 20) } };
  }
  if (r.metodo === "POST" && r.caminho === "/v1/relatos") return { status: 201, corpo: { id: "rel-1" } };
  if (r.metodo === "POST" && r.caminho === "/v1/contestacoes") return { status: 201, corpo: { id: "con-1" } };
  if (r.metodo === "POST" && r.caminho === "/v1/relatores/solicitacoes") return { status: 201, corpo: { id: "sol-1" } };
  return { status: 404, corpo: { erro: "nao_encontrado" } };
}

// ---------- cliente MCP ----------

function iniciar(env = {}) {
  const filho = spawn(process.execPath, [SERVIDOR], {
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const esperando = new Map();
  let proximo = 1;
  createInterface({ input: filho.stdout }).on("line", (l) => {
    stdout.push(l);
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return; // o teste "stdout só tem protocolo" acusa
    }
    if (m && m.id !== undefined && esperando.has(m.id)) {
      esperando.get(m.id)(m);
      esperando.delete(m.id);
    }
  });
  filho.stderr.on("data", (c) => stderr.push(c.toString()));
  const cliente = {
    stdout,
    stderr,
    enviarBruto: (linha) => filho.stdin.write(linha + "\n"),
    rpc(method, params) {
      const id = proximo++;
      const p = new Promise((ok, erro) => {
        esperando.set(id, ok);
        setTimeout(() => erro(new Error(`sem resposta para ${method}`)), 8000).unref();
      });
      filho.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return p;
    },
    notificar: (method, params) => filho.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    chamar: (name, args) => cliente.rpc("tools/call", { name, arguments: args }),
    async fechar() {
      filho.stdin.end();
      await new Promise((ok) => filho.on("close", ok));
    },
    tudo: () => stdout.join("\n") + "\n" + stderr.join(""),
  };
  return cliente;
}

async function comServidor(env, corpo) {
  const c = iniciar(env);
  try {
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teste", version: "0" } });
    c.notificar("notifications/initialized");
    return await corpo(c);
  } finally {
    await c.fechar();
  }
}

const cfg = (extra = {}) => ({ RDC_API_URL: base, ...extra });
const texto = (r) => r.result.content.map((p) => p.text).join("\n");

// ---------- protocolo ----------

test("initialize ecoa a versão do protocolo do cliente quando ela é suportada", async () => {
  const c = iniciar(cfg());
  const r = await c.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  await c.fechar();
  assert.equal(r.result.protocolVersion, "2024-11-05");
  assert.equal(r.result.serverInfo.name, "rede-de-confianca");
  assert.ok(r.result.capabilities.tools);
});

test("initialize responde com uma versão estável conhecida quando a do cliente é desconhecida", async () => {
  const c = iniciar(cfg());
  const r = await c.rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {} });
  await c.fechar();
  assert.equal(r.result.protocolVersion, "2025-06-18");
});

test("notifications/initialized não gera resposta e ping responde vazio", async () => {
  await comServidor(cfg(), async (c) => {
    const antes = c.stdout.length;
    c.notificar("notifications/initialized");
    const ping = await c.rpc("ping");
    assert.deepEqual(ping.result, {});
    assert.equal(c.stdout.length, antes + 1, "a notificação não pode gerar linha no stdout");
  });
});

test("método desconhecido responde erro JSON-RPC -32601", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.rpc("resources/list");
    assert.equal(r.error.code, -32601);
    assert.equal(r.result, undefined);
  });
});

test("tool desconhecida responde erro JSON-RPC -32602, não um resultado", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("apagar_tudo", {});
    assert.equal(r.error.code, -32602);
  });
});

test("JSON malformado responde -32700 e o servidor continua vivo", async () => {
  await comServidor(cfg(), async (c) => {
    c.enviarBruto("{isso não é json");
    const ping = await c.rpc("ping");
    assert.deepEqual(ping.result, {});
    const erro = c.stdout.map((l) => JSON.parse(l)).find((m) => m.error?.code === -32700);
    assert.ok(erro, "faltou o erro -32700");
    assert.equal(erro.id, null);
  });
});

test("stdout só carrega mensagens JSON-RPC (logs vão para stderr)", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
    await c.chamar("como_interpretar_o_score", {});
    await c.rpc("tools/list");
    for (const linha of c.stdout) {
      const m = JSON.parse(linha); // lança se não for JSON
      assert.equal(m.jsonrpc, "2.0", `linha estranha no stdout: ${linha.slice(0, 80)}`);
    }
    assert.ok(c.stderr.join("").length > 0, "o servidor deveria logar algo em stderr");
  });
});

test("tools/list lista as 6 ferramentas com schema e annotations válidos", async () => {
  await comServidor(cfg(), async (c) => {
    const { tools } = (await c.rpc("tools/list")).result;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["como_interpretar_o_score", "consultar_indicador", "consultar_varios", "contestar_indicador", "pedir_chave_de_relator", "reportar_fraude"],
    );
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", t.name);
      assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === "object", t.name);
      for (const obrigatorio of t.inputSchema.required ?? []) assert.ok(obrigatorio in t.inputSchema.properties, `${t.name}: required ${obrigatorio} sem propriedade`);
      assert.ok(t.description.length > 80, `${t.name}: descrição curta demais para o modelo decidir`);
      for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof t.annotations[k], "boolean", `${t.name}.${k}`);
    }
    const por = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const leitura of ["consultar_indicador", "consultar_varios", "como_interpretar_o_score"]) {
      assert.equal(por[leitura].readOnlyHint, true, leitura);
      assert.equal(por[leitura].idempotentHint, true, leitura);
    }
    for (const escrita of ["reportar_fraude", "contestar_indicador", "pedir_chave_de_relator"]) {
      assert.equal(por[escrita].readOnlyHint, false, escrita);
      assert.equal(por[escrita].destructiveHint, false, escrita);
    }
  });
});

// ---------- configuração ----------

test("sem RDC_API_URL as ferramentas dão erro claro e não inventam endereço", async () => {
  await comServidor({}, async (c) => {
    for (const [nome, args] of [
      ["consultar_indicador", { tipo: "email", valor: EMAIL }],
      ["reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", confirmar: true }],
    ]) {
      const r = await c.chamar(nome, args);
      assert.equal(r.result.isError, true, nome);
      assert.match(texto(r), /RDC_API_URL/);
      assert.match(texto(r), /mcp\/README\.md/);
    }
    assert.equal((await c.chamar("como_interpretar_o_score", {})).result.isError, undefined, "a tool sem rede continua funcionando");
  });
});

test("RDC_API_URL em http fora de localhost é recusada, sem fazer request", async () => {
  await comServidor({ RDC_API_URL: "http://rede.exemplo.com.br" }, async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
    assert.equal(r.result.isError, true);
    assert.match(texto(r), /https/);
  });
});

// ---------- consulta ----------

test("o valor cru nunca aparece no corpo, na URL nem nos cabeçalhos enviados à API na consulta", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
    assert.equal(r.result.isError, undefined);
    assert.equal(requisicoes.length, 1);
    const q = requisicoes[0];
    assert.equal(q.metodo, "POST");
    assert.equal(q.caminho, "/v1/consulta");
    assert.deepEqual(Object.keys(q.corpo).sort(), ["hash", "tipo"]);
    assert.equal(q.corpo.hash, hashIndicador("email", EMAIL), "o hash tem de ser o mesmo da regra única de normalização");
    const tudo = q.bruto + q.caminho + JSON.stringify(q.headers);
    for (const pedaco of [EMAIL, EMAIL.toLowerCase(), "exemplo-loja", "cliente.suspeito", "clientesuspeito"]) {
      assert.ok(!tudo.toLowerCase().includes(pedaco.toLowerCase()), `vazou "${pedaco}" para a API`);
    }
    assert.equal(q.headers.authorization, undefined, "consulta é pública: não manda a chave");
  });
});

test("consulta devolve score, nível, relatores e a interpretação de pista, não prova", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "ip", valor: "8.8.8.8" });
    assert.equal(r.result.structuredContent.score, 62);
    assert.equal(r.result.structuredContent.nivel, "suspeito");
    assert.equal(r.result.structuredContent.relatores_distintos, 2);
    assert.match(texto(r), /pista, não uma prova/);
    assert.match(texto(r), /Nunca bloqueie/);
    assert.match(texto(r), /outro canal/);
    assert.ok(!texto(r).includes("8.8.8.8"), "a resposta não repete o valor cru");
  });
});

test("nível desconhecido avisa que desconhecido não significa confiável", async () => {
  resposta = () => ({ corpo: { score: 3, nivel: "desconhecido", relatores_distintos: 0, ultimo_relato_em: null } });
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "dominio", valor: "loja-nova.com.br" });
    assert.match(texto(r), /não significa "confiável"/);
  });
});

test("IP privado é recusado localmente, sem request", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "ip", valor: "192.168.0.10" });
    assert.equal(r.result.isError, true);
    assert.equal(requisicoes.length, 0);
    assert.ok(!texto(r).includes("192.168.0.10"));
  });
});

test("consultar_varios recusa mais de 10 itens sem fazer request", async () => {
  await comServidor(cfg(), async (c) => {
    const itens = Array.from({ length: 11 }, (_, i) => ({ tipo: "dominio", valor: `loja${i}.com.br` }));
    const r = await c.chamar("consultar_varios", { itens });
    assert.equal(r.result.isError, true);
    assert.equal(requisicoes.length, 0);
  });
});

test("consultar_varios isola o erro de um item e consulta os outros", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("consultar_varios", {
      itens: [
        { tipo: "email", valor: EMAIL },
        { tipo: "ip", valor: "10.0.0.1" },
        { tipo: "dominio", valor: "exemplo.com.br" },
      ],
    });
    assert.equal(r.result.isError, undefined);
    const res = r.result.structuredContent.resultados;
    assert.equal(res.length, 3);
    assert.equal(res[0].score, 62);
    assert.ok(res[1].erro, "o item inválido precisa carregar o próprio erro");
    assert.equal(res[2].score, 62);
    assert.equal(requisicoes.length, 2);
    for (const q of requisicoes) assert.ok(!q.bruto.includes("10.0.0.1") && !q.bruto.toLowerCase().includes("exemplo"), "valor cru no lote");
  });
});

// ---------- reportar ----------

test("reportar sem confirmar não faz request e devolve só a prévia", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", evidencia: "chargeback do pedido 1234" });
    assert.equal(requisicoes.length, 0, "sem confirmar:true nada pode ser enviado");
    const s = r.result.structuredContent;
    assert.equal(s.enviado, false);
    assert.equal(s.tipo, "email");
    assert.equal(s.categoria, "chargeback");
    assert.equal(s.hash_parcial, hashIndicador("email", EMAIL).slice(0, 8));
    assert.match(s.aviso_lgpd, /LGPD/);
    assert.match(texto(r), /NADA FOI ENVIADO/);
    assert.ok(!texto(r).toLowerCase().includes("exemplo-loja"), "a prévia não repete o valor cru");
  });
});

test("confirmar diferente de true (texto 'true', 1) também não envia", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    for (const confirmar of ["true", 1, "sim"]) {
      await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", confirmar });
    }
    assert.equal(requisicoes.length, 0);
  });
});

test("reportar sem RDC_CHAVE explica como pedir a chave e não faz request", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", confirmar: true });
    assert.equal(r.result.isError, true);
    assert.match(texto(r), /RDC_CHAVE/);
    assert.match(texto(r), /pedir_chave_de_relator/);
    assert.equal(requisicoes.length, 0);
  });
});

test("reportar com confirmar:true envia POST /v1/relatos com a chave só no cabeçalho Authorization", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", evidencia: "chargeback do pedido 1234", confirmar: true });
    assert.equal(r.result.isError, undefined);
    assert.equal(requisicoes.length, 1);
    const q = requisicoes[0];
    assert.equal(q.caminho, "/v1/relatos");
    assert.equal(q.headers.authorization, `Bearer ${CHAVE}`);
    assert.ok(!q.bruto.includes(CHAVE), "a chave não vai no corpo");
    assert.equal(q.corpo.categoria, "chargeback");
    assert.equal(q.corpo.evidencia, "chargeback do pedido 1234");
    assert.equal(r.result.structuredContent.id, "rel-1");
  });
});

test("evidência com CPF é recusada antes de qualquer request, com ou sem confirmar", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    for (const confirmar of [true, undefined]) {
      const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", evidencia: `cliente CPF ${CPF_VALIDO}`, confirmar });
      assert.equal(r.result.isError, true);
      assert.match(texto(r), /CPF|cartão/);
      assert.ok(!texto(r).includes(CPF_VALIDO) && !texto(r).includes("52998224725"), "a recusa não pode repetir o CPF");
    }
    assert.equal(requisicoes.length, 0);
  });
});

test("evidência com número de cartão é recusada antes de qualquer request", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "cartao_testado", evidencia: `cartão ${CARTAO_VALIDO}`, confirmar: true });
    assert.equal(r.result.isError, true);
    assert.equal(requisicoes.length, 0);
    assert.ok(!texto(r).includes("4111"));
  });
});

test("categoria inválida é recusada localmente", async () => {
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "antipatia", confirmar: true });
    assert.equal(r.result.isError, true);
    assert.equal(requisicoes.length, 0);
  });
});

// ---------- contestação e solicitação ----------

test("contestar manda o hash e nunca o valor cru", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("contestar_indicador", { tipo: "email", valor: EMAIL, motivo: "Esse e-mail é meu e nunca fiz chargeback.", contato: "dono@exemplo.com" });
    assert.equal(r.result.isError, undefined);
    const q = requisicoes[0];
    assert.equal(q.caminho, "/v1/contestacoes");
    assert.equal(q.corpo.hash, hashIndicador("email", EMAIL));
    assert.equal("valor" in q.corpo, false);
    assert.ok(!q.bruto.toLowerCase().includes("exemplo-loja"), "valor cru vazou na contestação");
    assert.equal(q.headers.authorization, undefined);
  });
});

test("contestar recusa motivo curto e motivo com CPF sem fazer request", async () => {
  await comServidor(cfg(), async (c) => {
    assert.equal((await c.chamar("contestar_indicador", { tipo: "email", valor: EMAIL, motivo: "erro" })).result.isError, true);
    assert.equal((await c.chamar("contestar_indicador", { tipo: "email", valor: EMAIL, motivo: `Sou o titular, CPF ${CPF_VALIDO}.` })).result.isError, true);
    assert.equal(requisicoes.length, 0);
  });
});

test("pedir_chave_de_relator envia a solicitação e recusa loja_url que não é http(s)", async () => {
  await comServidor(cfg(), async (c) => {
    const ruim = await c.chamar("pedir_chave_de_relator", { nome: "Loja X", contato: "x@loja.com", loja_url: "javascript:alert(1)" });
    assert.equal(ruim.result.isError, true);
    assert.equal(requisicoes.length, 0);
    const ok = await c.chamar("pedir_chave_de_relator", { nome: "Loja X", contato: "x@loja.com", loja_url: "https://loja.com.br" });
    assert.equal(ok.result.isError, undefined);
    assert.equal(requisicoes[0].caminho, "/v1/relatores/solicitacoes");
    assert.deepEqual(requisicoes[0].corpo, { nome: "Loja X", contato: "x@loja.com", loja_url: "https://loja.com.br" });
  });
});

test("como_interpretar_o_score responde sem chamar a rede e fala dos limites", async () => {
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("como_interpretar_o_score", {});
    assert.equal(requisicoes.length, 0);
    for (const trecho of [/90 dias/, /não é prova|não é lista de culpados/, /NÃO significa confiável/, /24/, /75/]) assert.match(texto(r), trecho);
  });
});

// ---------- erros HTTP ----------

test("429 vira mensagem útil em português com o tempo de espera, sem stack trace", async () => {
  resposta = () => ({ status: 429, corpo: { erro: "limite", mensagem: "x" }, headers: { "retry-after": "42" } });
  await comServidor(cfg(), async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
    assert.equal(r.result.isError, true);
    assert.match(texto(r), /limitou/);
    assert.match(texto(r), /42 segundos/);
    assert.ok(!/\bat \w+.*\(.*:\d+:\d+\)/.test(texto(r)), "stack trace no resultado");
  });
});

test("401, 403, 409 e 400 viram resultados isError com orientação acionável", async () => {
  const casos = [
    [401, { erro: "nao_autorizado" }, /chave.*recusada/i],
    [403, { erro: "relator_suspenso" }, /suspensa/],
    [409, { erro: "duplicado" }, /30 dias/],
    [400, { erro: "dado_pessoal", mensagem: "texto com dado pessoal" }, /CPF ou número de cartão/],
    [500, { erro: "configuracao" }, /problema/],
  ];
  for (const [status, corpo, esperado] of casos) {
    resposta = () => ({ status, corpo });
    await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
      const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", confirmar: true });
      assert.equal(r.result.isError, true, String(status));
      assert.match(texto(r), esperado, String(status));
    });
  }
});

test("resposta que não é JSON vira erro claro, não exceção", async () => {
  const antigo = api.listeners("request");
  api.removeAllListeners("request");
  api.on("request", (_req, res) => res.end("<html>oi</html>"));
  try {
    await comServidor(cfg(), async (c) => {
      const r = await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
      assert.equal(r.result.isError, true);
      assert.match(texto(r), /JSON/);
    });
  } finally {
    api.removeAllListeners("request");
    for (const l of antigo) api.on("request", l);
  }
});

test("API fora do ar vira erro claro sem expor o endereço nem stack", async () => {
  await comServidor({ RDC_API_URL: "http://127.0.0.1:1" }, async (c) => {
    const r = await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
    assert.equal(r.result.isError, true);
    assert.match(texto(r), /Não consegui falar/);
    assert.ok(!texto(r).includes("127.0.0.1"));
  });
});

test("redirecionamento não é seguido, para a chave não ir a outro endereço", async () => {
  const outro = createServer((req, res) => {
    outroRecebeu.push(req.headers.authorization ?? null);
    res.end("{}");
  });
  const outroRecebeu = [];
  await new Promise((ok) => outro.listen(0, "127.0.0.1", ok));
  resposta = () => ({ status: 307, corpo: {}, headers: { location: `http://127.0.0.1:${outro.address().port}/captura` } });
  try {
    await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
      const r = await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", confirmar: true });
      assert.equal(r.result.isError, true);
      assert.deepEqual(outroRecebeu, [], "a chave foi enviada para o destino do redirecionamento");
    });
  } finally {
    outro.close();
  }
});

// ---------- a chave e o valor não vazam ----------

test("a chave não vaza em nenhuma resposta nem no stderr, nem quando a API a repete na mensagem de erro", async () => {
  // API hostil/defeituosa que ecoa a chave e o valor cru na mensagem de erro.
  resposta = (r) => ({ status: 400, corpo: { erro: "campo_invalido", mensagem: `recebi ${r.headers.authorization} e ${EMAIL}` } });
  await comServidor(cfg({ RDC_CHAVE: CHAVE }), async (c) => {
    await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback", confirmar: true });
    await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "chargeback" });
    await c.chamar("consultar_indicador", { tipo: "email", valor: EMAIL });
    await c.chamar("consultar_varios", { itens: [{ tipo: "email", valor: EMAIL }] });
    await c.chamar("contestar_indicador", { tipo: "email", valor: EMAIL, motivo: "Esse e-mail é meu, houve engano." });
    await c.chamar("reportar_fraude", { tipo: "email", valor: EMAIL, categoria: "x", confirmar: true });
    await c.rpc("tools/list");
    const tudo = c.tudo();
    assert.ok(!tudo.includes(CHAVE), "a chave apareceu na saída do servidor");
    assert.ok(!tudo.includes(CHAVE.slice(0, 20)), "parte da chave apareceu");
    // O valor cru também não pode voltar ao modelo, mesmo repetido pela API.
    assert.ok(!tudo.toLowerCase().includes("exemplo-loja"), "o valor cru apareceu na saída do servidor");
  });
});
