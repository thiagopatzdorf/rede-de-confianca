// Regressões do relatório do revisor adversarial (red team). Cada teste
// reproduz o ataque e falha sem o conserto correspondente; o nome descreve a
// falha, não a função.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { tratar } from "../src/worker.js";
import { hashIndicador } from "../src/normalizar.js";
import { hashArmazenado, hmacHex } from "../src/segredos.js";
import { expirar } from "../src/expiracao.js";
import {
  ADMIN, PEPPER, T0, DIA, T_MADURO, ambiente, req, chamar, novoRelator, novoRelatorVerificado, admin,
  linhas, relatar, consultar,
} from "./_ambiente.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");
const CATS = ["chargeback", "cartao_testado", "phishing"];
const ALVO = "inocente@loja-real.com.br";

// ======================= 1 e 2: sybil e tetos =======================

async function atacar(env, relatores, agora, valor = ALVO, categorias = CATS, tipo = "email") {
  for (const r of relatores) for (const categoria of categorias) {
    const x = await relatar(env, r.chave, { tipo, valor, categoria }, agora);
    assert.equal(x.status, 201);
  }
}

test("3 contas novas que se corroboram não levam e-mail alheio a alto_risco (a_sybil: era 99)", async () => {
  const env = ambiente();
  const contas = [];
  for (let i = 0; i < 3; i++) contas.push(await novoRelator(env, `fake${i}`, T0));
  await atacar(env, contas, T0);
  const r = (await consultar(env, ALVO, "email", T0)).corpo;
  assert.equal(r.score, 0, "conta com menos de 7 dias pesa 0");
  assert.equal(r.nivel, "desconhecido");
});

test("as mesmas 3 contas depois de esperar 7 dias, sem nenhum verificado, ficam em suspeito no máximo", async () => {
  const env = ambiente();
  const contas = [];
  for (let i = 0; i < 3; i++) contas.push(await novoRelator(env, `fake${i}`, T0));
  await atacar(env, contas, T_MADURO);
  const r = (await consultar(env, ALVO, "email", T_MADURO)).corpo;
  assert.notEqual(r.nivel, "alto_risco", `score ${r.score}`);
  assert.ok(r.score <= 74);
});

test("12 contas falsas maduras que se corroboram, sem verificado, nunca chegam a alto_risco", async () => {
  const env = ambiente();
  const contas = [];
  for (let i = 0; i < 12; i++) contas.push(await novoRelator(env, `fake${i}`, T0));
  // bombeamento de reputação: todas reportam o mesmo lixo, em vários indicadores, antes do alvo
  for (const lixo of ["a1@lixo.example", "a2@lixo.example", "a3@lixo.example"]) await atacar(env, contas, T_MADURO, lixo, ["chargeback"]);
  await atacar(env, contas, T_MADURO, ALVO);
  const r = (await consultar(env, ALVO, "email", T_MADURO)).corpo;
  assert.notEqual(r.nivel, "alto_risco", `score ${r.score}`);
  assert.equal(r.relatores_distintos, 12);
});

test("o caminho legítimo continua: 1 verificado e 2 relatores antigos que ele corrobora chegam a alto_risco", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  await atacar(env, [v, a, b], T0, "golpista@fraude.example");
  const r = (await consultar(env, "golpista@fraude.example", "email", T0)).corpo;
  assert.equal(r.nivel, "alto_risco", `score ${r.score}`);
});

test("sem o verificado reportando o MESMO indicador, os mesmos 3 relatores antigos não passam de suspeito", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  const c = await novoRelator(env, "C");
  await atacar(env, [v], T0, "outro@fraude.example");
  await atacar(env, [a, b, c], T0, "golpista@fraude.example");
  const r = (await consultar(env, "golpista@fraude.example", "email", T0)).corpo;
  assert.notEqual(r.nivel, "alto_risco");
});

test("um relator sozinho nunca passa de desconhecido (24), nem com todas as categorias", async () => {
  const env = ambiente();
  const a = await novoRelatorVerificado(env, "A");
  await atacar(env, [a], T0, ALVO, ["chargeback", "cartao_testado", "conta_falsa", "phishing", "bot_abuso", "outro"]);
  const r = (await consultar(env, ALVO, "email", T0)).corpo;
  assert.ok(r.score <= 24, `score ${r.score}`);
  assert.equal(r.nivel, "desconhecido");
});

test("dois relatores no máximo suspeito (49), mesmo verificados e se corroborando", async () => {
  const env = ambiente();
  const a = await novoRelatorVerificado(env, "A");
  const b = await novoRelatorVerificado(env, "B");
  await atacar(env, [a, b], T0, ALVO, ["chargeback", "cartao_testado", "conta_falsa", "phishing", "bot_abuso", "outro"]);
  const r = (await consultar(env, ALVO, "email", T0)).corpo;
  assert.equal(r.score, 49);
  assert.equal(r.nivel, "suspeito");
});

test("IP reportado por 3 relatores aptos (1 verificado) não chega a alto_risco, e o mesmo cenário em domínio chega (o teto 79 ficava acima do limiar de 75)", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  await atacar(env, [v, a, b], T0, "200.100.50.25", CATS, "ip");
  await atacar(env, [v, a, b], T0, "loja-golpista.example.com", CATS, "dominio");
  const ip = (await consultar(env, "200.100.50.25", "ip", T0)).corpo;
  assert.notEqual(ip.nivel, "alto_risco", `score ${ip.score}`);
  assert.equal((await consultar(env, "loja-golpista.example.com", "dominio", T0)).corpo.nivel, "alto_risco");
});

test("verificar e desverificar: só o moderador, idempotente, 404 se o relator não existe, e o público nunca vê o campo", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  assert.equal((await chamar(env, "POST", `/v1/admin/relatores/${a.relator_id}/verificar`, { corpo: {} })).status, 401);
  assert.equal(linhas(env, "SELECT verificado FROM relatores")[0].verificado, 0);
  const ok = await admin(env, `/v1/admin/relatores/${a.relator_id}/verificar`);
  assert.deepEqual(ok.corpo, { id: a.relator_id, verificado: true });
  assert.equal((await admin(env, `/v1/admin/relatores/${a.relator_id}/verificar`)).status, 200);
  assert.equal(linhas(env, "SELECT verificado FROM relatores")[0].verificado, 1);
  assert.deepEqual((await admin(env, `/v1/admin/relatores/${a.relator_id}/desverificar`)).corpo, { id: a.relator_id, verificado: false });
  assert.equal(linhas(env, "SELECT verificado FROM relatores")[0].verificado, 0);
  assert.equal((await admin(env, "/v1/admin/relatores/nao-existe/verificar")).status, 404);
  assert.equal((await admin(env, "/v1/admin/relatores/nao-existe/desverificar")).status, 404);
  await relatar(env, a.chave);
  assert.ok(!JSON.stringify((await consultar(env)).corpo).includes("verificado"));
});

test("relator criado pelo moderador ou aprovado de uma solicitação nasce NÃO verificado", async () => {
  const env = ambiente();
  await novoRelator(env, "A");
  const sol = await chamar(env, "POST", "/v1/relatores/solicitacoes", { corpo: { nome: "N", contato: "n@n.example", loja_url: "https://n.example" } });
  await admin(env, `/v1/admin/solicitacoes/${sol.corpo.id}/aprovar`);
  assert.deepEqual(linhas(env, "SELECT verificado FROM relatores").map((l) => l.verificado), [0, 0]);
});

test("desverificar tira o poder de corroborar: o relator que dependia dele volta a 0.2", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const a = await novoRelator(env, "A");
  await relatar(env, v.chave);
  await relatar(env, a.chave);
  const com = (await consultar(env)).corpo.score;
  await admin(env, `/v1/admin/relatores/${v.relator_id}/desverificar`);
  const sem = (await consultar(env)).corpo.score;
  assert.ok(sem < com, `${sem} < ${com}`);
});

// ======================= 3: limite por balde de rede =======================

const v6 = (i) => `2804:14d:5c81:4b2a:${(i + 1).toString(16)}::${(i * 7 + 1).toString(16)}`;

test("500 consultas girando o sufixo de um /64 IPv6 batem no limite (eram 500 aceitas)", async () => {
  const env = ambiente();
  let ok = 0;
  let limitadas = 0;
  for (let i = 0; i < 500; i++) {
    const r = await consultar(env, "a@b.example", "email", T0, v6(i));
    if (r.status === 200) ok++;
    else if (r.status === 429) limitadas++;
  }
  assert.equal(ok, 300);
  assert.equal(limitadas, 200);
});

test("um /24 inteiro de IPv4 divide o mesmo balde de consulta", async () => {
  const env = ambiente();
  let ok = 0;
  for (let i = 0; i < 400; i++) {
    const r = await consultar(env, "a@b.example", "email", T0, `198.51.100.${(i % 254) + 1}`);
    if (r.status === 200) ok++;
  }
  assert.equal(ok, 300);
  assert.equal((await consultar(env, "a@b.example", "email", T0, "198.51.101.1")).status, 200, "o /24 vizinho tem balde próprio");
});

test("IPv4 mapeado em IPv6 cai no balde do mesmo /24 IPv4", async () => {
  const env = ambiente();
  for (let i = 0; i < 300; i++) await consultar(env, "a@b.example", "email", T0, "198.51.100.7");
  assert.equal((await consultar(env, "a@b.example", "email", T0, "::ffff:198.51.100.200")).status, 429);
});

test("contestação com IPv6 girando dentro de um /64 leva 429 na 11ª (eram 300 aceitas)", async () => {
  const env = ambiente();
  const corpo = { tipo: "email", valor: "a@b.example", motivo: "Este indicador é meu, sou inocente" };
  const status = [];
  for (let i = 0; i < 14; i++) status.push((await chamar(env, "POST", "/v1/contestacoes", { corpo, ip: v6(i) })).status);
  assert.deepEqual(status, [...Array(10).fill(201), 429, 429, 429, 429]);
});

test("solicitação de relator com IPv6 girando dentro de um /64 leva 429 na 4ª (eram 200 aceitas)", async () => {
  const env = ambiente();
  const corpo = { nome: "Loja", contato: "l@l.example", loja_url: "https://loja.example" };
  const status = [];
  for (let i = 0; i < 6; i++) status.push((await chamar(env, "POST", "/v1/relatores/solicitacoes", { corpo, ip: v6(i) })).status);
  assert.deepEqual(status, [201, 201, 201, 429, 429, 429]);
});

test("a chave de limite é HMAC com pepper do balde, não sha256 do IP: um banco vazado não devolve o IP", async () => {
  const env = ambiente();
  await consultar(env, "a@b.example", "email", T0, "203.0.113.77");
  const chave = linhas(env, "SELECT chave FROM limites")[0].chave;
  assert.equal(chave, "consulta:" + (await hmacHex(PEPPER, "limite-rede:v4:203.0.113.0/24")));
  for (const candidato of ["203.0.113.77", "v4:203.0.113.0/24", "rdc:limite-ip:203.0.113.77"]) {
    assert.ok(!chave.includes(sha(candidato)), `sha256 de "${candidato}" apareceu na chave`);
  }
});

// ======================= 4: pepper e admin =======================

test("o banco guarda HMAC(PEPPER, hash do cliente), nunca o sha256 público 'rdc:v1:' (IPv4 inteiro era reversível)", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave, { tipo: "ip", valor: "203.0.114.7" });
  const publico = hashIndicador("ip", "203.0.114.7");
  const gravado = linhas(env, "SELECT indicador_hash FROM relatos")[0].indicador_hash;
  assert.notEqual(gravado, publico);
  assert.equal(gravado, await hmacHex(PEPPER, publico));
  assert.equal(gravado, await hashArmazenado(PEPPER, publico));
});

test("quem manda só o hash público (cliente) e quem manda o valor chegam ao mesmo indicador", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave);
  const porHash = await chamar(env, "POST", "/v1/consulta", { corpo: { tipo: "email", hash: hashIndicador("email", "golpista@fraude.example") } });
  assert.equal(porHash.corpo.relatores_distintos, 1);
});

test("com outro PEPPER os mesmos hashes não casam: o segredo faz parte da identidade do indicador", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave);
  const outro = { ...env, PEPPER: "outro-pepper-completamente-diferente-32+" };
  assert.equal((await consultar(outro)).corpo.relatores_distintos, 0);
});

test("sem PEPPER, ou com menos de 32 caracteres, o worker falha fechado: 500 configuracao e nada é gravado", async () => {
  for (const PEPPER_RUIM of [undefined, "", "curto", "x".repeat(31)]) {
    const env = ambiente({ PEPPER: PEPPER_RUIM });
    for (const [metodo, caminho, corpo] of [
      ["GET", "/v1/saude"],
      ["POST", "/v1/consulta", { tipo: "email", valor: "a@b.example" }],
      ["POST", "/v1/contestacoes", { tipo: "email", valor: "a@b.example", motivo: "motivo comprido o bastante" }],
      ["POST", "/v1/relatores/solicitacoes", { nome: "N", contato: "c", loja_url: "https://l.example" }],
    ]) {
      const r = await chamar(env, metodo, caminho, { corpo });
      assert.equal(r.status, 500, `${caminho} com PEPPER=${JSON.stringify(PEPPER_RUIM)}`);
      assert.equal(r.corpo.erro, "configuracao");
    }
    assert.equal(linhas(env, "SELECT * FROM limites").length, 0);
    assert.equal(linhas(env, "SELECT * FROM contestacoes").length, 0);
  }
  // 32 caracteres exatos é o mínimo aceito
  assert.equal((await chamar(ambiente({ PEPPER: "x".repeat(32) }), "GET", "/v1/saude")).status, 200);
});

test("ADMIN_TOKEN com menos de 32 caracteres não abre a moderação nem quando enviado exatamente", async () => {
  for (const token of ["123", "x".repeat(31)]) {
    const env = ambiente({ ADMIN_TOKEN: token });
    const r = await chamar(env, "POST", "/v1/admin/relatores", { token, corpo: { nome: "N", contato: "c" } });
    assert.equal(r.status, 401);
    assert.equal(linhas(env, "SELECT * FROM relatores").length, 0);
  }
  const ok = await chamar(ambiente({ ADMIN_TOKEN: "x".repeat(32) }), "POST", "/v1/admin/relatores", { token: "x".repeat(32), corpo: { nome: "N", contato: "c" } });
  assert.equal(ok.status, 201);
});

test("a mensagem de moderação é a mesma com token errado, curto ou não configurado (não revela o deploy)", async () => {
  const msgs = new Set();
  for (const [adm, token] of [[ADMIN, "errado"], ["curto", "curto"], [undefined, "x"], [ADMIN, undefined]]) {
    const r = await chamar(ambiente({ ADMIN_TOKEN: adm }), "POST", "/v1/admin/relatores", { token, corpo: { nome: "N", contato: "c" } });
    msgs.add(r.corpo.mensagem);
  }
  assert.equal(msgs.size, 1);
});

test("rotas admin: depois de 10 tentativas falhas do mesmo balde, nem o token certo passa (429)", async () => {
  const env = ambiente();
  const tentar = (token, ip) => chamar(env, "POST", "/v1/admin/relatores", { token, corpo: { nome: "N", contato: "c" }, ip });
  for (let i = 0; i < 10; i++) assert.equal((await tentar("errado-" + i, v6(i))).status, 401, `tentativa ${i}`);
  const bloqueada = await tentar("errado-final", v6(99));
  assert.equal(bloqueada.status, 429);
  const certo = await tentar(ADMIN, v6(100));
  assert.equal(certo.status, 429, "o token certo também espera a janela passar");
  assert.ok(Number(certo.res.headers.get("retry-after")) >= 1);
  assert.equal(linhas(env, "SELECT * FROM relatores").length, 0);
  assert.equal((await tentar(ADMIN, "198.51.100.200")).status, 201, "outro balde não é afetado");
  assert.equal((await chamar(env, "POST", "/v1/admin/relatores", { token: ADMIN, corpo: { nome: "N", contato: "c" }, ip: v6(5) }, T0 + 3_600_000)).status, 201);
});

test("uso legítimo de moderação não consome o limite de tentativas falhas", async () => {
  const env = ambiente();
  for (let i = 0; i < 30; i++) {
    const r = await chamar(env, "GET", "/v1/admin/contestacoes", { token: ADMIN });
    assert.equal(r.status, 200);
  }
});

// ======================= 5: custo =======================

async function povoar(env, n, { verificadoPrimeiro = false } = {}) {
  const ids = [];
  const insR = env.DB.sqlite.prepare("INSERT INTO relatores (id, nome, contato, chave_hash, criado_em, verificado) VALUES (?, ?, 'c', ?, ?, ?)");
  const insL = env.DB.sqlite.prepare(
    "INSERT INTO relatos (id, tipo_indicador, indicador_hash, categoria, relator_id, criado_em) VALUES (?, 'email', ?, 'chargeback', ?, ?)",
  );
  const hash = await hashArmazenado(PEPPER, hashIndicador("email", ALVO));
  for (let i = 0; i < n; i++) {
    const id = `rel-${i}`;
    insR.run(id, `r${i}`, sha("k" + i), T0 - 60 * DIA, verificadoPrimeiro && i === 0 ? 1 : 0);
    insL.run(`rl-${i}`, hash, id, T0 - i * 1000);
    ids.push(id);
  }
  return ids;
}

const escritas = (log) => log.filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql));

test("a consulta faz o mesmo número pequeno de queries com 5 ou com 100 relatores (eram 3N+4: 304)", async () => {
  const contar = async (n) => {
    const env = ambiente();
    await povoar(env, n);
    env.DB.log.length = 0;
    const r = await consultar(env, ALVO, "email", T0);
    assert.equal(r.status, 200);
    return env.DB.log.length;
  };
  const com5 = await contar(5);
  const com100 = await contar(100);
  assert.equal(com100, com5, "o custo não pode crescer com o número de relatores");
  assert.ok(com100 <= 5, `${com100} queries`);
});

test("a consulta pública só escreve no D1 o contador de limite (uma escrita, na tabela limites)", async () => {
  const env = ambiente();
  await povoar(env, 10);
  env.DB.log.length = 0;
  await consultar(env, ALVO, "email", T0);
  const w = escritas(env.DB.log);
  assert.equal(w.length, 1, w.join(" | "));
  assert.match(w[0], /INTO limites/);
  assert.ok(!env.DB.log.some((sql) => /DELETE FROM limites/.test(sql)), "a poda é do cron, não de cada consulta");
});

test("indicador com relatos demais: lê no máximo 100 e o verificado entra primeiro, mesmo sendo o mais antigo", async () => {
  const env = ambiente();
  // 120 relatores recentes (contas de ontem, peso 0) e 1 verificado maduro com o relato mais antigo
  const ids = await povoar(env, 121, { verificadoPrimeiro: true });
  env.DB.sqlite.prepare("UPDATE relatores SET criado_em = ? WHERE id <> 'rel-0'").run(T0 - DIA);
  env.DB.sqlite.prepare("UPDATE relatos SET criado_em = ? WHERE relator_id = 'rel-0'").run(T0 - 100 * DIA);
  assert.equal(ids.length, 121);
  const r = (await consultar(env, ALVO, "email", T0)).corpo;
  assert.equal(r.relatores_distintos, 100);
  assert.ok(r.score > 0, "o verificado sustenta o score: sem prioridade ele ficava fora dos 100 mais novos");
});

// ======================= 8: entrada =======================

test("POST de text/plain é recusado (415) em todas as rotas públicas, sem gastar limite nem gravar", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const corpo = JSON.stringify({ tipo: "email", valor: "a@b.example", motivo: "motivo comprido o bastante", nome: "N", contato: "c", loja_url: "https://l.example", categoria: "outro" });
  for (const caminho of ["/v1/consulta", "/v1/contestacoes", "/v1/relatores/solicitacoes", "/v1/relatos"]) {
    for (const tipoConteudo of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", null]) {
      const r = await chamar(env, "POST", caminho, { bruto: corpo, tipoConteudo, token: rel.chave });
      assert.equal(r.status, 415, `${caminho} ${tipoConteudo}`);
      assert.equal(r.corpo.erro, "tipo_de_conteudo");
    }
  }
  assert.equal(linhas(env, "SELECT * FROM limites").length, 0, "o POST forjado não queima a cota de quem foi enganado");
  assert.equal(linhas(env, "SELECT * FROM contestacoes").length + linhas(env, "SELECT * FROM relatos").length, 0);
});

test("application/json com charset ou maiúsculas continua aceito", async () => {
  const env = ambiente();
  for (const tipoConteudo of ["application/json; charset=utf-8", "Application/JSON"]) {
    const r = await chamar(env, "POST", "/v1/consulta", { corpo: { tipo: "email", valor: "a@b.example" }, tipoConteudo });
    assert.equal(r.status, 200, tipoConteudo);
  }
});

test("corpo de 5000 caracteres de 2 bytes (10 mil bytes) leva 413: o teto é em bytes, não em unidades UTF-16", async () => {
  const env = ambiente();
  const r = await chamar(env, "POST", "/v1/consulta", { bruto: JSON.stringify({ tipo: "email", valor: "é".repeat(5000) }) });
  assert.equal(r.status, 413);
});

test("corpo enorme em stream é cortado cedo: o worker para de ler ao passar do teto em vez de bufferizar tudo", async () => {
  const env = ambiente();
  let pedacos = 0;
  const corpo = new ReadableStream({
    pull(c) {
      pedacos++;
      c.enqueue(new Uint8Array(1024).fill(120));
      if (pedacos >= 20_000) c.close();
    },
  });
  const request = new Request("https://rede.test/v1/consulta", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: corpo,
    duplex: "half",
  });
  const res = await tratar(request, env, T0);
  assert.equal(res.status, 413);
  assert.ok(pedacos < 100, `leu ${pedacos} KB antes de recusar`);
});

test("Content-Length declarado acima do teto leva 413 sem ler o corpo", async () => {
  const env = ambiente();
  const r = await chamar(env, "POST", "/v1/consulta", { bruto: "{}", headers: { "content-length": "9999999" } });
  assert.equal(r.status, 413);
});

test("texto livre com caractere invisível ou de controle é recusado (zero-width, bidi, BOM, NUL, preenchimento Hangul)", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const base = { tipo: "email", valor: "a@b.example" };
  const invisiveis = ["​", "‮", "﻿", "\u0000", "ㅤ", "⁠", "­", " "];
  for (const ch of invisiveis) {
    const motivo = await chamar(env, "POST", "/v1/contestacoes", { corpo: { ...base, motivo: ch.repeat(12) }, ip: v6(invisiveis.indexOf(ch) + 50) });
    assert.equal(motivo.status, 400, `motivo ${JSON.stringify(ch)}`);
    const nome = await chamar(env, "POST", "/v1/admin/relatores", { token: ADMIN, corpo: { nome: `Loja${ch}`, contato: "c" } });
    assert.equal(nome.status, 400, `nome ${JSON.stringify(ch)}`);
    const ev = await relatar(env, rel.chave, { evidencia: `texto${ch}texto` });
    assert.equal(ev.status, 400, `evidência ${JSON.stringify(ch)}`);
  }
  assert.equal(linhas(env, "SELECT * FROM contestacoes").length, 0);
  assert.equal(linhas(env, "SELECT * FROM relatos").length, 0);
});

test("evidência e motivo aceitam quebra de linha; nome e contato não", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  assert.equal((await relatar(env, rel.chave, { evidencia: "linha 1\nlinha 2\tcom tab" })).status, 201);
  assert.equal((await chamar(env, "POST", "/v1/contestacoes", { corpo: { tipo: "email", valor: "a@b.example", motivo: "primeira linha\nsegunda linha" } })).status, 201);
  assert.equal((await chamar(env, "POST", "/v1/admin/relatores", { token: ADMIN, corpo: { nome: "Linha 1\nLinha 2", contato: "c" } })).status, 400);
});

test("acentos, cedilha e emoji comuns continuam aceitos nos campos livres", async () => {
  const env = ambiente();
  const rel = await novoRelator(env, "Loja São João");
  assert.equal((await relatar(env, rel.chave, { evidencia: "Comprador usou cartão de terceiros ✓ — 12 tentativas em 3 min" })).status, 201);
});

// ======================= 6: IPv6 pela API =======================

test("relatar ::2, ::1.2.3.4 ou ::5.6.7.8 é recusado: não existe mais um hash comum de lixo", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  for (const ip of ["::2", "::1.2.3.4", "::5.6.7.8", "2002:0a00:0001::1", "64:ff9b::a00:1"]) {
    const r = await relatar(env, rel.chave, { tipo: "ip", valor: ip, categoria: "outro" });
    assert.equal(r.status, 400, ip);
    assert.equal(r.corpo.erro, "indicador_invalido");
  }
  assert.equal(linhas(env, "SELECT * FROM relatos").length, 0);
});

// ======================= 9: LGPD =======================

test("CPF na evidência, no motivo ou na URL da loja é recusado (400 dado_pessoal), com ou sem pontuação, e nada é gravado", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const cpfs = ["529.982.247-25", "52998224725", "529 982 247 25", "cliente 529.982.247-25 usou cartão"];
  let ip = 0;
  for (const cpf of cpfs) {
    const ev = await relatar(env, rel.chave, { evidencia: cpf });
    assert.equal(ev.status, 400, cpf);
    assert.equal(ev.corpo.erro, "dado_pessoal");
    assert.ok(!JSON.stringify(ev.corpo).includes("52998"), "a resposta não repete o dado");
    const mo = await chamar(env, "POST", "/v1/contestacoes", { corpo: { tipo: "email", valor: "a@b.example", motivo: `Meu CPF é ${cpf} ok` }, ip: v6(ip++ + 200) });
    assert.equal(mo.corpo.erro, "dado_pessoal", cpf);
  }
  const url = await chamar(env, "POST", "/v1/relatores/solicitacoes", { corpo: { nome: "N", contato: "c", loja_url: "https://l.example/52998224725" } });
  assert.equal(url.corpo.erro, "dado_pessoal");
  assert.equal(linhas(env, "SELECT * FROM relatos").length + linhas(env, "SELECT * FROM contestacoes").length + linhas(env, "SELECT * FROM solicitacoes_relator").length, 0);
});

test("número de cartão (Luhn) na evidência, com espaços, hífens ou corrido, é recusado", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  for (const cartao of ["4111 1111 1111 1111", "4111-1111-1111-1111", "4111111111111111", "teste com 5555555555554444 hoje"]) {
    const r = await relatar(env, rel.chave, { evidencia: cartao });
    assert.equal(r.corpo.erro, "dado_pessoal", cartao);
  }
});

test("texto parecido mas inválido passa: CPF com dígito verificador errado, 16 dígitos sem Luhn, 'rdc' e datas", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const ok = ["529.982.247-26", "4111 1111 1111 1112", "111.111.111-11", "12 tentativas em 3 min", "pedido 20261001 às 12:30", "IP 203.0.113.7 usado 5 vezes"];
  for (const [i, evidencia] of ok.entries()) {
    const r = await relatar(env, rel.chave, { evidencia, valor: `ok${i}@b.example` });
    assert.equal(r.status, 201, evidencia);
  }
});

test("CPF escrito com dígitos de largura total também é recusado (NFKC antes da varredura)", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const r = await relatar(env, rel.chave, { evidencia: "５２９９８２２４７２５" });
  assert.equal(r.corpo.erro, "dado_pessoal");
});

// ----- expiração de dados pessoais -----

const ins = (env, id, estado, criado, decidido, extra = {}) =>
  env.DB.sqlite
    .prepare("INSERT INTO solicitacoes_relator (id, nome, contato, loja_url, estado, criado_em, decidido_em, relator_id) VALUES (?, 'Fulano', 'f@f.example', 'https://f.example', ?, ?, ?, ?)")
    .run(id, estado, criado, decidido, extra.relator_id ?? null);

test("solicitação pendente há mais de 90 dias expira; a de 89 dias fica", async () => {
  const env = ambiente();
  ins(env, "velha", "pendente", T0 - 91 * DIA, null);
  ins(env, "nova", "pendente", T0 - 89 * DIA, null);
  const r = await expirar(env.DB, T0);
  assert.equal(r.solicitacoes, 1);
  assert.deepEqual(linhas(env, "SELECT id FROM solicitacoes_relator").map((l) => l.id), ["nova"]);
});

test("solicitação recusada tem os dados pessoais apagados 90 dias depois da recusa, não da criação", async () => {
  const env = ambiente();
  ins(env, "recusada-velha", "recusada", T0 - 200 * DIA, T0 - 91 * DIA);
  ins(env, "recusada-recente", "recusada", T0 - 200 * DIA, T0 - 10 * DIA);
  await expirar(env.DB, T0);
  assert.deepEqual(linhas(env, "SELECT id FROM solicitacoes_relator").map((l) => l.id), ["recusada-recente"]);
});

test("solicitação aprovada perde nome, contato e URL da loja depois de 90 dias, mas a linha fica", async () => {
  const env = ambiente();
  ins(env, "aprovada-velha", "aprovada", T0 - 200 * DIA, T0 - 91 * DIA, { relator_id: "r1" });
  ins(env, "aprovada-recente", "aprovada", T0 - 20 * DIA, T0 - 10 * DIA, { relator_id: "r2" });
  const r = await expirar(env.DB, T0);
  assert.equal(r.solicitacoes_anonimizadas, 1);
  const velha = linhas(env, "SELECT * FROM solicitacoes_relator WHERE id = 'aprovada-velha'")[0];
  assert.deepEqual([velha.nome, velha.contato, velha.loja_url, velha.relator_id], ["[apagado]", "[apagado]", "[apagado]", "r1"]);
  assert.equal(linhas(env, "SELECT nome FROM solicitacoes_relator WHERE id = 'aprovada-recente'")[0].nome, "Fulano");
  assert.equal((await expirar(env.DB, T0)).solicitacoes_anonimizadas, 0, "idempotente");
});

test("desativar revoga a chave (401) e começa o prazo; repetir não renova o prazo", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  assert.equal((await admin(env, `/v1/admin/relatores/${a.relator_id}/desativar`, {}, T0)).status, 200);
  assert.equal((await relatar(env, a.chave)).status, 401);
  assert.equal(linhas(env, "SELECT desativado_em FROM relatores")[0].desativado_em, T0);
  await admin(env, `/v1/admin/relatores/${a.relator_id}/desativar`, {}, T0 + 5 * DIA);
  assert.equal(linhas(env, "SELECT desativado_em FROM relatores")[0].desativado_em, T0);
  assert.equal((await admin(env, "/v1/admin/relatores/nao-existe/desativar")).status, 404);
});

test("relator desativado há mais de 90 dias perde nome, contato e chave, mas a linha e os relatos ficam", async () => {
  const env = ambiente();
  const velho = await novoRelator(env, "Velho");
  const recente = await novoRelator(env, "Recente");
  const ativo = await novoRelator(env, "Ativo");
  await relatar(env, velho.chave);
  await admin(env, `/v1/admin/relatores/${velho.relator_id}/desativar`, {}, T0 - 91 * DIA);
  await admin(env, `/v1/admin/relatores/${recente.relator_id}/desativar`, {}, T0 - 10 * DIA);
  const r = await expirar(env.DB, T0);
  assert.equal(r.relatores_anonimizados, 1);
  const l = (id) => linhas(env, "SELECT * FROM relatores WHERE id = ?", id)[0];
  assert.deepEqual([l(velho.relator_id).nome, l(velho.relator_id).contato], ["[apagado]", "[apagado]"]);
  assert.equal(l(velho.relator_id).chave_hash, "apagado:" + velho.relator_id);
  assert.equal(l(recente.relator_id).nome, "Recente");
  assert.equal(l(ativo.relator_id).nome, "Ativo");
  assert.equal(linhas(env, "SELECT * FROM relatos WHERE relator_id = ?", velho.relator_id).length, 1, "o relato não some com o nome");
  assert.equal((await expirar(env.DB, T0)).relatores_anonimizados, 0, "idempotente");
});

test("relator desativado direto no banco, sem data, ganha a data na primeira passada do cron e não é apagado na hora", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  env.DB.sqlite.prepare("UPDATE relatores SET ativo = 0 WHERE id = ?").run(a.relator_id);
  const r = await expirar(env.DB, T0);
  assert.equal(r.relatores_anonimizados, 0);
  assert.equal(linhas(env, "SELECT desativado_em FROM relatores")[0].desativado_em, T0);
  assert.equal(linhas(env, "SELECT nome FROM relatores")[0].nome, "A");
  assert.equal((await expirar(env.DB, T0 + 91 * DIA)).relatores_anonimizados, 1);
});

test("o handler scheduled apaga solicitações e relatores vencidos (a retenção está ligada ao cron)", async () => {
  const env = ambiente();
  ins(env, "velha", "pendente", Date.now() - 100 * DIA, null);
  const a = await novoRelator(env, "A");
  await admin(env, `/v1/admin/relatores/${a.relator_id}/desativar`, {}, Date.now() - 100 * DIA);
  const esperas = [];
  worker.scheduled({}, env, { waitUntil: (p) => esperas.push(p) });
  await Promise.all(esperas);
  assert.equal(linhas(env, "SELECT * FROM solicitacoes_relator").length, 0);
  assert.equal(linhas(env, "SELECT nome FROM relatores")[0].nome, "[apagado]");
});
