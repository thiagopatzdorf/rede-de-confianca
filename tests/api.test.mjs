// Testes da API contra um D1 falso feito sobre node:sqlite (SQLite em memória
// com o esquema real; ver _ambiente.mjs). Cada nome descreve a falha que o
// teste impede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/worker.js";
import { hashIndicador } from "../src/normalizar.js";
import { hashArmazenado } from "../src/segredos.js";
import { reputacaoDoRelator } from "../src/pontuacao.js";
import {
  ADMIN, PEPPER, T0, DIA, T_MADURO, DIR_ESQUEMA, ambiente, chamar, novoRelator, novoRelatorVerificado,
  admin, linhas, relatar, consultar,
} from "./_ambiente.mjs";

const sha = (t) => createHash("sha256").update(t).digest("hex");

test("saúde responde ok e versão 1", async () => {
  const r = await chamar(ambiente(), "GET", "/v1/saude");
  assert.deepEqual(r.corpo, { ok: true, versao: "1" });
});

test("rota inexistente devolve erro no formato do contrato, não HTML nem 200", async () => {
  const r = await chamar(ambiente(), "GET", "/v1/nada");
  assert.equal(r.status, 404);
  assert.equal(r.corpo.erro, "nao_encontrado");
  assert.equal(typeof r.corpo.mensagem, "string");
});

test("método errado numa rota existente devolve 405 e não executa a ação", async () => {
  const r = await chamar(ambiente(), "GET", "/v1/relatos");
  assert.equal(r.status, 405);
  assert.equal(r.corpo.erro, "metodo_nao_permitido");
});

test("consulta de indicador sem relatos devolve desconhecido, não erro", async () => {
  const r = await consultar(ambiente());
  assert.equal(r.status, 200);
  assert.equal(r.corpo.score, 0);
  assert.equal(r.corpo.nivel, "desconhecido");
  assert.equal(r.corpo.ultimo_relato_em, null);
});

test("consulta pública não vaza quem reportou, evidência nem relatos", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const seg = "EVIDENCIA-SECRETA-123";
  assert.equal((await relatar(env, rel.chave, { evidencia: seg })).status, 201);
  const r = await consultar(env);
  assert.deepEqual(Object.keys(r.corpo).sort(), ["nivel", "relatores_distintos", "score", "ultimo_relato_em"]);
  const texto = JSON.stringify(r.corpo);
  assert.ok(!texto.includes(rel.relator_id));
  assert.ok(!texto.includes(seg));
  assert.equal(r.corpo.relatores_distintos, 1);
  assert.equal(r.corpo.ultimo_relato_em, T0);
});

test("consulta com tipo inválido ou valor mal formado devolve 400 sem ecoar o valor", async () => {
  const env = ambiente();
  const a = await chamar(env, "POST", "/v1/consulta", { corpo: { tipo: "cpf", valor: "x" } });
  assert.equal(a.status, 400);
  assert.equal(a.corpo.erro, "tipo_invalido");
  const b = await consultar(env, "isto-nao-e-um-email-SEGREDINHO", "email");
  assert.equal(b.status, 400);
  assert.equal(b.corpo.erro, "indicador_invalido");
  assert.ok(!JSON.stringify(b.corpo).includes("SEGREDINHO"));
  const c = await chamar(env, "POST", "/v1/consulta", { corpo: { tipo: "email" } });
  assert.equal(c.status, 400);
});

test("o valor cru do indicador não é gravado em nenhuma tabela, só o hash", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave, { valor: "Pessoa.Rara+x@Exemplo-Cru.example", evidencia: "ok" });
  await chamar(env, "POST", "/v1/contestacoes", {
    corpo: { tipo: "email", valor: "Pessoa.Rara+x@Exemplo-Cru.example", motivo: "Fui contestar isto aqui" },
  });
  await consultar(env, "Pessoa.Rara+x@Exemplo-Cru.example");
  for (const tabela of ["relatores", "relatos", "contestacoes", "limites"]) {
    const dump = JSON.stringify(env.DB.sqlite.prepare(`SELECT * FROM ${tabela}`).all()).toLowerCase();
    assert.ok(!dump.includes("exemplo-cru"), `valor cru apareceu em ${tabela}`);
    assert.ok(!dump.includes("203.0.113.7"), `IP cru apareceu em ${tabela}`);
  }
  const linha = env.DB.sqlite.prepare("SELECT indicador_hash FROM relatos").get();
  assert.match(linha.indicador_hash, /^[0-9a-f]{64}$/);
});

test("chave do relator aparece uma vez e o banco guarda só o sha256", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  assert.match(rel.chave, /^rdc_[0-9a-f]{64}$/);
  const linha = env.DB.sqlite.prepare("SELECT * FROM relatores WHERE id = ?").get(rel.relator_id);
  assert.equal(linha.chave_hash, sha(rel.chave));
  assert.ok(!JSON.stringify(linha).includes(rel.chave));
  const outro = await novoRelator(env, "Loja B");
  assert.notEqual(outro.chave, rel.chave);
});

test("rotas de moderação recusam pedido sem token, com token errado ou de outro tamanho", async () => {
  const env = ambiente();
  const corpo = { nome: "X", contato: "x@x.example" };
  // IP (balde /24) diferente a cada pedido: o limite de tentativas falhas de
  // moderação não pode mascarar a recusa que este teste confere.
  let n = 0;
  const ipNovo = () => `198.51.${++n}.9`;
  for (const token of [undefined, "errado", ADMIN + "x", ADMIN.slice(0, -1)]) {
    const r = await chamar(env, "POST", "/v1/admin/relatores", { token, corpo, ip: ipNovo() });
    assert.equal(r.status, 401);
    assert.equal(r.corpo.erro, "nao_autorizado");
  }
  const d = await chamar(env, "POST", "/v1/admin/contestacoes/abc/decidir", { corpo: { decisao: "procedente", nota: "n" }, ip: ipNovo() });
  assert.equal(d.status, 401);
  // Toda rota de moderação nova também exige o token.
  const rotas = [
    ["GET", "/v1/admin/contestacoes"],
    ["POST", "/v1/admin/contestacoes/abc/triagem"],
    ["POST", "/v1/admin/relatores/abc/suspender"],
    ["POST", "/v1/admin/relatores/abc/reativar"],
    ["POST", "/v1/admin/relatores/abc/verificar"],
    ["POST", "/v1/admin/relatores/abc/desverificar"],
    ["POST", "/v1/admin/relatores/abc/desativar"],
    ["POST", "/v1/admin/relatos/abc/remover"],
    ["POST", "/v1/admin/relatos/abc/apagar-evidencia"],
    ["GET", "/v1/admin/solicitacoes"],
    ["POST", "/v1/admin/solicitacoes/abc/aprovar"],
    ["POST", "/v1/admin/solicitacoes/abc/recusar"],
  ];
  for (const [m, caminho] of rotas) {
    const r = await chamar(env, m, caminho, { corpo: m === "POST" ? {} : undefined, ip: ipNovo() });
    assert.equal(r.status, 401, `${m} ${caminho}`);
  }
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM relatores").get().n, 0);
});

test("sem ADMIN_TOKEN configurado a moderação fica fechada, mesmo com Bearer vazio-ish", async () => {
  const env = ambiente({ ADMIN_TOKEN: undefined });
  for (const token of ["undefined", "x"]) {
    const r = await chamar(env, "POST", "/v1/admin/relatores", { token, corpo: { nome: "X", contato: "c" } });
    assert.equal(r.status, 401);
  }
  const vazio = ambiente({ ADMIN_TOKEN: "" });
  const r = await chamar(vazio, "POST", "/v1/admin/relatores", { token: "a", corpo: { nome: "X", contato: "c" } });
  assert.equal(r.status, 401);
});

test("criar relator sem nome ou contato devolve 400", async () => {
  const env = ambiente();
  const r = await chamar(env, "POST", "/v1/admin/relatores", { token: ADMIN, corpo: { nome: "X" } });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, "campo_invalido");
});

test("relato sem chave, com chave inventada ou de relator desativado devolve 401", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  const corpo = { tipo: "email", valor: "a@b.example", categoria: "outro" };
  assert.equal((await chamar(env, "POST", "/v1/relatos", { corpo })).status, 401);
  assert.equal((await chamar(env, "POST", "/v1/relatos", { token: "rdc_inventada", corpo })).status, 401);
  env.DB.sqlite.prepare("UPDATE relatores SET ativo = 0 WHERE id = ?").run(rel.relator_id);
  assert.equal((await chamar(env, "POST", "/v1/relatos", { token: rel.chave, corpo })).status, 401);
});

test("relato com categoria, tipo, evidência ou JSON inválidos é recusado e nada é gravado", async () => {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  const base = { tipo: "email", valor: "a@b.example", categoria: "chargeback" };
  const casos = [
    [{ ...base, categoria: "simpatia" }, "categoria_invalida"],
    [{ ...base, tipo: "cpf" }, "tipo_invalido"],
    [{ ...base, evidencia: "x".repeat(281) }, "campo_invalido"],
    [{ ...base, evidencia: 42 }, "campo_invalido"],
    [{ ...base, valor: "sem-arroba" }, "indicador_invalido"],
  ];
  for (const [corpo, erro] of casos) {
    const r = await chamar(env, "POST", "/v1/relatos", { token: chave, corpo });
    assert.equal(r.status, 400, erro);
    assert.equal(r.corpo.erro, erro);
  }
  const lixo = await chamar(env, "POST", "/v1/relatos", { token: chave, bruto: "{nao e json" });
  assert.equal(lixo.corpo.erro, "corpo_invalido");
  const arr = await chamar(env, "POST", "/v1/relatos", { token: chave, bruto: "[1]" });
  assert.equal(arr.corpo.erro, "corpo_invalido");
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM relatos").get().n, 0);
});

test("corpo gigante é recusado com 413 antes de qualquer processamento", async () => {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  const r = await chamar(env, "POST", "/v1/relatos", { token: chave, bruto: JSON.stringify({ lixo: "x".repeat(20_000) }) });
  assert.equal(r.status, 413);
  assert.equal(r.corpo.erro, "corpo_grande");
});

test("mesmo relator, indicador e categoria em 30 dias devolve 409 duplicado, inclusive com e-mail escrito de outro jeito", async () => {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  assert.equal((await relatar(env, chave)).status, 201);
  const de_novo = await relatar(env, chave, { valor: "GOLPISTA@Fraude.example" }, T0 + 29 * DIA);
  assert.equal(de_novo.status, 409);
  assert.equal(de_novo.corpo.erro, "duplicado");
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM relatos").get().n, 1);
});

test("depois de 30 dias o mesmo relato volta a ser aceito", async () => {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  await relatar(env, chave);
  assert.equal((await relatar(env, chave, {}, T0 + 31 * DIA)).status, 201);
});

test("categoria diferente ou relator diferente não é tratado como duplicado", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  assert.equal((await relatar(env, a.chave)).status, 201);
  assert.equal((await relatar(env, a.chave, { categoria: "phishing" })).status, 201);
  assert.equal((await relatar(env, b.chave)).status, 201);
  assert.equal((await consultar(env)).corpo.relatores_distintos, 2);
});

test("relator passa de 200 relatos por dia e leva 429 com Retry-After; no dia seguinte volta", async () => {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  for (let i = 0; i < 200; i++) {
    const r = await relatar(env, chave, { valor: `d${i}.exemplo.example`, tipo: "dominio" });
    assert.equal(r.status, 201, `relato ${i}`);
  }
  const estouro = await relatar(env, chave, { valor: "d200.exemplo.example", tipo: "dominio" });
  assert.equal(estouro.status, 429);
  assert.equal(estouro.corpo.erro, "limite_excedido");
  assert.ok(Number(estouro.res.headers.get("retry-after")) >= 1);
  const amanha = await relatar(env, chave, { valor: "d200.exemplo.example", tipo: "dominio" }, T0 + DIA);
  assert.equal(amanha.status, 201);
});

test("consulta pública passa de 300 por minuto por balde de rede e leva 429, sem afetar outro balde", async () => {
  const env = ambiente();
  for (let i = 0; i < 300; i++) assert.equal((await consultar(env, "a@b.example", "email", T0, "198.51.100.1")).status, 200);
  const estouro = await consultar(env, "a@b.example", "email", T0, "198.51.100.1");
  assert.equal(estouro.status, 429);
  assert.equal(estouro.corpo.erro, "limite_excedido");
  assert.equal((await consultar(env, "a@b.example", "email", T0, "198.51.101.1")).status, 200, "outro /24 tem balde próprio");
  assert.equal((await consultar(env, "a@b.example", "email", T0 + 60_000, "198.51.100.1")).status, 200);
});

test("contestação passa de 10 por hora por balde de rede e leva 429", async () => {
  const env = ambiente();
  const corpo = { tipo: "email", valor: "a@b.example", motivo: "Este indicador é meu, sou inocente" };
  for (let i = 0; i < 10; i++) assert.equal((await chamar(env, "POST", "/v1/contestacoes", { corpo })).status, 201);
  assert.equal((await chamar(env, "POST", "/v1/contestacoes", { corpo })).status, 429);
  assert.equal((await chamar(env, "POST", "/v1/contestacoes", { corpo }, T0 + 3_600_000)).status, 201);
});

test("limites não guardam o IP cru de quem consulta", async () => {
  const env = ambiente();
  await consultar(env, "a@b.example", "email", T0, "198.51.100.77");
  const chaves = env.DB.sqlite.prepare("SELECT chave FROM limites").all().map((l) => l.chave).join(" ");
  assert.ok(!chaves.includes("198.51.100.77"));
});

test("contestação com motivo curto, longo ou indicador inválido é recusada", async () => {
  const env = ambiente();
  const base = { tipo: "email", valor: "a@b.example" };
  const curto = await chamar(env, "POST", "/v1/contestacoes", { corpo: { ...base, motivo: "curto" } });
  assert.equal(curto.status, 400);
  const longo = await chamar(env, "POST", "/v1/contestacoes", { corpo: { ...base, motivo: "x".repeat(501) } });
  assert.equal(longo.status, 400);
  const ruim = await chamar(env, "POST", "/v1/contestacoes", { corpo: { tipo: "ip", valor: "10.0.0.1", motivo: "motivo comprido o bastante" } });
  assert.equal(ruim.corpo.erro, "indicador_invalido");
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM contestacoes").get().n, 0);
});

test("contestação criada nasce aberta e devolve só o id", async () => {
  const env = ambiente();
  const r = await chamar(env, "POST", "/v1/contestacoes", {
    corpo: { tipo: "email", valor: "a@b.example", motivo: "Sou o dono e não fraudei", contato: "dono@x.example" },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.corpo), ["id"]);
  const linha = env.DB.sqlite.prepare("SELECT estado, decidido_em FROM contestacoes WHERE id = ?").get(r.corpo.id);
  assert.equal(linha.estado, "aberta");
  assert.equal(linha.decidido_em, null);
});

async function cenarioContestado() {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  await relatar(env, chave);
  const c = await chamar(env, "POST", "/v1/contestacoes", {
    corpo: { tipo: "email", valor: "golpista@fraude.example", motivo: "Este e-mail é legítimo, juro" },
  });
  return { env, chave, idContestacao: c.corpo.id };
}
const decidir = (env, id, corpo, token = ADMIN, agora = T0 + DIA) =>
  chamar(env, "POST", `/v1/admin/contestacoes/${id}/decidir`, { token, corpo }, agora);
const triar = (env, id, prova_de_controle, agora = T0 + DIA / 2) =>
  chamar(env, "POST", `/v1/admin/contestacoes/${id}/triagem`, { token: ADMIN, corpo: { prova_de_controle } }, agora);

test("contestação procedente faz o relato anterior ser ignorado na consulta", async () => {
  const { env, idContestacao } = await cenarioContestado();
  assert.ok((await consultar(env, undefined, undefined, T0 + 1000)).corpo.score > 0);
  assert.equal((await triar(env, idContestacao, true)).status, 200);
  const d = await decidir(env, idContestacao, { decisao: "procedente", nota: "dono provou" });
  assert.equal(d.status, 200);
  assert.equal(d.corpo.estado, "procedente");
  const r = await consultar(env, undefined, undefined, T0 + DIA + 1000);
  assert.equal(r.corpo.score, 0);
  assert.equal(r.corpo.nivel, "desconhecido");
});

test("relato novo depois de uma contestação procedente volta a contar", async () => {
  const { env, idContestacao } = await cenarioContestado();
  await triar(env, idContestacao, true);
  await decidir(env, idContestacao, { decisao: "procedente", nota: "dono provou" });
  const outro = await novoRelator(env, "Loja Nova");
  assert.equal((await relatar(env, outro.chave, {}, T0 + 2 * DIA)).status, 201);
  const r = await consultar(env, undefined, undefined, T0 + 2 * DIA + 1000);
  assert.ok(r.corpo.score > 0);
});

test("contestação improcedente não apaga o relato nem muda o score", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const antes = (await consultar(env, undefined, undefined, T0 + DIA)).corpo.score;
  assert.ok(antes > 0);
  await triar(env, idContestacao, true);
  await decidir(env, idContestacao, { decisao: "improcedente", nota: "sem prova" });
  assert.equal((await consultar(env, undefined, undefined, T0 + DIA)).corpo.score, antes);
  assert.equal(linhas(env, "SELECT * FROM relatos").length, 1);
});

test("decidir exige decisão válida, contestação existente e só funciona uma vez", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const ruim = await decidir(env, idContestacao, { decisao: "talvez", nota: "n" });
  assert.equal(ruim.status, 400);
  const semNota = await decidir(env, idContestacao, { decisao: "procedente" });
  assert.equal(semNota.status, 400);
  const fantasma = await decidir(env, "nao-existe", { decisao: "procedente", nota: "n" });
  assert.equal(fantasma.status, 404);
  assert.equal((await decidir(env, idContestacao, { decisao: "improcedente", nota: "n" })).status, 200);
  const segunda = await decidir(env, idContestacao, { decisao: "procedente", nota: "mudei" });
  assert.equal(segunda.status, 409);
  assert.equal(segunda.corpo.erro, "ja_decidida");
  assert.equal(env.DB.sqlite.prepare("SELECT estado FROM contestacoes WHERE id = ?").get(idContestacao).estado, "improcedente");
});

test("decidir contestação sem token de moderador não altera nada", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const r = await decidir(env, idContestacao, { decisao: "procedente", nota: "n" }, "token-errado");
  assert.equal(r.status, 401);
  assert.equal(env.DB.sqlite.prepare("SELECT estado FROM contestacoes WHERE id = ?").get(idContestacao).estado, "aberta");
});

test("o mesmo indicador escrito de formas equivalentes cai no mesmo hash na consulta", async () => {
  const env = ambiente();
  const { chave } = await novoRelator(env);
  await relatar(env, chave, { valor: "Fulano+promo@Gmail.com" });
  const r = await consultar(env, "f.u.l.a.n.o@googlemail.com");
  assert.equal(r.corpo.relatores_distintos, 1);
});

// ======================= contrato v1.1 =======================

const HASH_GOLPISTA = hashIndicador("email", "golpista@fraude.example");
const HASH_ARMAZENADO = await hashArmazenado(PEPPER, HASH_GOLPISTA);
const pegar = (env, caminho, opcoes = {}, agora = T0) => chamar(env, "GET", caminho, opcoes, agora);

// ---------- consulta sem valor na URL ----------

test("GET /v1/consulta com ?valor= é recusado e o valor não volta na resposta nem vira consulta", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave);
  const r = await pegar(env, "/v1/consulta?tipo=email&valor=SEGREDINHO%40x.example");
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, "valor_na_url");
  assert.ok(!JSON.stringify(r.corpo).includes("SEGREDINHO"));
  assert.equal(r.corpo.score, undefined);
  const p = await pegar(env, `/v1/consulta?tipo=email&valor=golpista%40fraude.example`);
  assert.equal(p.status, 400, "mesmo um valor que existe no banco não pode ser consultado pela URL");
});

test("consulta por hash (GET e POST) dá o mesmo resultado que a consulta por valor, sem enviar o valor", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave);
  const porValor = await consultar(env);
  const porHashPost = await chamar(env, "POST", "/v1/consulta", { corpo: { tipo: "email", hash: HASH_GOLPISTA } });
  const porHashGet = await pegar(env, `/v1/consulta?tipo=email&hash=${HASH_GOLPISTA}`);
  assert.equal(porHashPost.status, 200);
  assert.deepEqual(porHashPost.corpo, porValor.corpo);
  assert.deepEqual(porHashGet.corpo, porValor.corpo);
  assert.ok(porValor.corpo.score > 0);
});

test("consulta por hash aceita hexadecimal maiúsculo como o mesmo hash", async () => {
  const env = ambiente();
  const rel = await novoRelator(env);
  await relatar(env, rel.chave);
  const r = await chamar(env, "POST", "/v1/consulta", { corpo: { tipo: "email", hash: HASH_GOLPISTA.toUpperCase() } });
  assert.equal(r.corpo.relatores_distintos, 1);
});

test("consulta com valor e hash juntos, nenhum dos dois, ou hash mal formado devolve 400", async () => {
  const env = ambiente();
  const casos = [
    { tipo: "email", valor: "a@b.example", hash: HASH_GOLPISTA },
    { tipo: "email" },
    { tipo: "email", hash: "abc" },
    { tipo: "email", hash: "z".repeat(64) },
    { tipo: "email", hash: 42 },
    { tipo: "cpf", hash: HASH_GOLPISTA },
  ];
  for (const corpo of casos) {
    const r = await chamar(env, "POST", "/v1/consulta", { corpo });
    assert.equal(r.status, 400, JSON.stringify(corpo));
  }
});

test("consulta por hash também gasta o limite de 300 por minuto por balde", async () => {
  const env = ambiente();
  for (let i = 0; i < 300; i++) {
    assert.equal((await pegar(env, `/v1/consulta?tipo=email&hash=${HASH_GOLPISTA}`, { ip: "198.51.100.9" })).status, 200);
  }
  assert.equal((await pegar(env, `/v1/consulta?tipo=email&hash=${HASH_GOLPISTA}`, { ip: "198.51.100.9" })).status, 429);
});

test("contestação por hash funciona sem enviar o valor cru", async () => {
  const env = ambiente();
  const r = await chamar(env, "POST", "/v1/contestacoes", {
    corpo: { tipo: "email", hash: HASH_GOLPISTA, motivo: "Esse e-mail é meu e é legítimo" },
  });
  assert.equal(r.status, 201);
  // O banco guarda o HMAC com pepper, não o sha256 público que o cliente mandou.
  assert.equal(linhas(env, "SELECT indicador_hash FROM contestacoes")[0].indicador_hash, HASH_ARMAZENADO);
});

test("hashIndicador exportado para clientes bate com sha256('rdc:v1:' + tipo + ':' + normalizado)", () => {
  // É a fórmula do README: o cliente de shell só consegue isto (sem normalizar).
  assert.equal(hashIndicador("email", "Golpista@Fraude.example"), sha("rdc:v1:email:golpista@fraude.example"));
  assert.match(HASH_GOLPISTA, /^[0-9a-f]{64}$/);
});

// ---------- reputação e corroboração no banco ----------

test("relator novo sozinho fica em 0.2: o score de um relato isolado é o de reputação 0.2", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave);
  // soma = 1.0 (chargeback) * 0.2 => 100*(1-exp(-0.2/1.5))
  assert.equal((await consultar(env)).corpo.score, Math.round(100 * (1 - Math.exp(-0.2 / 1.5))));
});

test("verificado e relator antigo que o corrobora sobem a reputação dos dois (e param no teto de 2 relatores)", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const b = await novoRelator(env, "B");
  await relatar(env, v.chave);
  const sozinho = (await consultar(env)).corpo.score;
  await relatar(env, b.chave);
  const dois = (await consultar(env)).corpo;
  // cada um vale (0.2+1)/(1+1)=0.6: soma 1.2 daria 55, mas 2 relatores param em 49
  assert.equal(dois.score, 49);
  assert.ok(dois.score > sozinho);
});

test("dois relatores antigos sem verificado por perto NÃO se corroboram: seguem em 0.2", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  await relatar(env, a.chave);
  await relatar(env, b.chave);
  // soma = 2 x 0.2 (chargeback 1.0 x reputação 0.2); teria subido para 0.6 cada se corroborassem
  assert.equal((await consultar(env)).corpo.score, Math.round(100 * (1 - Math.exp(-0.4 / 1.5))));
});

test("relato derrubado não corrobora: o outro relator volta a 0.2", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const b = await novoRelator(env, "B");
  await relatar(env, v.chave);
  await relatar(env, b.chave);
  const idV = linhas(env, "SELECT id FROM relatos WHERE relator_id = ?", v.relator_id)[0].id;
  const c = await chamar(env, "POST", "/v1/contestacoes", { corpo: { tipo: "email", valor: "golpista@fraude.example", motivo: "Esse e-mail é meu mesmo" } });
  await triar(env, c.corpo.id, true);
  assert.equal((await decidir(env, c.corpo.id, { decisao: "procedente", nota: "n", relato_ids: [idV] })).status, 200);
  // sobrou só o relato de B, sem ninguém que o corrobore: reputação 0.2
  assert.equal((await consultar(env, undefined, undefined, T0 + DIA)).corpo.score, Math.round(100 * (1 - Math.exp(-0.2 / 1.5))));
});

test("relator com dois relatos derrubados não serve de corroborador, mesmo corroborado por verificado", async () => {
  const env = ambiente();
  const v = await novoRelatorVerificado(env, "V");
  const ruim = await novoRelator(env, "Ruim");
  const b = await novoRelator(env, "B");
  // "Ruim" reportou x1 e x2 junto com o verificado; os dois relatos caíram.
  for (const x of ["x1@fraude.example", "x2@fraude.example"]) {
    await relatar(env, v.chave, { valor: x });
    await relatar(env, ruim.chave, { valor: x });
    const id = linhas(env, "SELECT id FROM relatos WHERE relator_id = ? AND indicador_hash = ?", ruim.relator_id, await hashArmazenado(PEPPER, hashIndicador("email", x)))[0].id;
    env.DB.sqlite.prepare("INSERT INTO relatos_derrubados VALUES (?, 'c', ?)").run(id, T0);
  }
  const agora = T0 + DIA;
  for (const rel of [v, ruim, b]) await relatar(env, rel.chave, {}, agora);
  const q = (await consultar(env, undefined, undefined, agora)).corpo;
  const idade_dias = 31;
  // V e B só têm como corroborador o outro (verificado/habilitado); Ruim, com
  // 2 refutações (0.2 + bônus, abaixo de 0.3), não habilita ninguém. Se
  // habilitasse, V e B teriam 2 corroboradores e a soma seria maior.
  const repV = reputacaoDoRelator({ confirmados: 1, idade_dias });
  const repB = reputacaoDoRelator({ confirmados: 1, idade_dias });
  const repRuim = reputacaoDoRelator({ confirmados: 2, refutados: 2, idade_dias });
  assert.equal(q.score, Math.round(100 * (1 - Math.exp(-(repV + repB + repRuim) / 1.5))));
});

// ---------- contestação não é arma ----------

test("contestação aberta não muda o score", async () => {
  const { env } = await cenarioContestado();
  const antes = (await consultar(env, undefined, undefined, T0 + 1000)).corpo.score;
  assert.ok(antes > 0);
  // a contestação já está aberta desde o cenário
  assert.equal((await consultar(env, undefined, undefined, T0 + 2000)).corpo.score, antes);
});

test("triagem com prova de controle (em_analise) NÃO corta o peso: o fraudador prova que controla o próprio e-mail", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const antes = (await consultar(env, undefined, undefined, T0 + 2000)).corpo.score;
  assert.ok(antes > 0);
  assert.equal((await triar(env, idContestacao, true)).corpo.estado, "em_analise");
  const depois = await consultar(env, undefined, undefined, T0 + 2000);
  assert.equal(depois.corpo.score, antes, "provar controle mede identidade, não inocência");
});

test("triagem sem prova de controle encerra como improcedente e o score não se mexe", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const antes = (await consultar(env)).corpo.score;
  const r = await triar(env, idContestacao, false);
  assert.equal(r.corpo.estado, "improcedente");
  assert.equal((await consultar(env)).corpo.score, antes);
});

test("decisão procedente sem triagem prévia é recusada (409) e nenhum relato é derrubado", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const r = await decidir(env, idContestacao, { decisao: "procedente", nota: "n" });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro, "sem_triagem");
  assert.equal(linhas(env, "SELECT * FROM relatos_derrubados").length, 0);
});

test("triagem só vale para contestação aberta: repetir ou triar depois de decidida dá 409", async () => {
  const { env, idContestacao } = await cenarioContestado();
  assert.equal((await triar(env, idContestacao, true)).status, 200);
  assert.equal((await triar(env, idContestacao, true)).status, 409);
  assert.equal((await triar(env, "nao-existe", true)).status, 404);
  const ruim = await chamar(env, "POST", `/v1/admin/contestacoes/${idContestacao}/triagem`, { token: ADMIN, corpo: { prova_de_controle: "sim" } });
  assert.equal(ruim.status, 400);
});

test("contestação grava criado_em do momento do pedido", async () => {
  const env = ambiente();
  const r = await chamar(env, "POST", "/v1/contestacoes", {
    corpo: { tipo: "email", valor: "a@b.example", motivo: "Sou o dono e não fraudei" },
  }, T0 + 5);
  assert.equal(linhas(env, "SELECT criado_em FROM contestacoes WHERE id = ?", r.corpo.id)[0].criado_em, T0 + 5);
});

test("listar contestações por estado traz a fila do moderador e não vaza para quem não é moderador", async () => {
  const { env, idContestacao } = await cenarioContestado();
  const todas = await chamar(env, "GET", "/v1/admin/contestacoes", { token: ADMIN });
  assert.equal(todas.corpo.contestacoes.length, 1);
  assert.equal(todas.corpo.contestacoes[0].id, idContestacao);
  assert.equal(todas.corpo.contestacoes[0].estado, "aberta");
  const filtro = await chamar(env, "GET", "/v1/admin/contestacoes?estado=em_analise", { token: ADMIN });
  assert.equal(filtro.corpo.contestacoes.length, 0);
  const ruim = await chamar(env, "GET", "/v1/admin/contestacoes?estado=qualquer", { token: ADMIN });
  assert.equal(ruim.status, 400);
  assert.ok(!JSON.stringify(todas.corpo).includes("fraude.example"), "só hash, nunca o valor cru");
});

// ---------- decisão por relato ----------

async function doisRelatosContestados() {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  await relatar(env, a.chave);
  await relatar(env, b.chave);
  const c = await chamar(env, "POST", "/v1/contestacoes", { corpo: { tipo: "email", valor: "golpista@fraude.example", motivo: "Esse e-mail é meu mesmo" } });
  await triar(env, c.corpo.id, true);
  const id = (rel) => linhas(env, "SELECT id FROM relatos WHERE relator_id = ?", rel.relator_id)[0].id;
  return { env, a, b, idA: id(a), idB: id(b), idC: c.corpo.id };
}

test("decidir com relato_ids derruba só esses relatos e o outro relator segue contando", async () => {
  const { env, idA, idB, idC } = await doisRelatosContestados();
  const r = await decidir(env, idC, { decisao: "procedente", nota: "n", relato_ids: [idA] });
  assert.equal(r.status, 200);
  assert.deepEqual(linhas(env, "SELECT relato_id FROM relatos_derrubados").map((l) => l.relato_id), [idA]);
  const q = await consultar(env, undefined, undefined, T0 + DIA);
  assert.equal(q.corpo.relatores_distintos, 1);
  assert.ok(idB);
});

test("decidir com relato_ids não escreve na tabela relatos (a decisão fica em relatos_derrubados)", async () => {
  const { env, idA, idC } = await doisRelatosContestados();
  const antes = JSON.stringify(linhas(env, "SELECT * FROM relatos ORDER BY id"));
  await decidir(env, idC, { decisao: "procedente", nota: "n", relato_ids: [idA] });
  assert.equal(JSON.stringify(linhas(env, "SELECT * FROM relatos ORDER BY id")), antes);
});

test("decidir sem relato_ids derruba todos os relatos até o instante da decisão, não os posteriores", async () => {
  const { env, idC } = await doisRelatosContestados();
  const c = await novoRelator(env, "C");
  await decidir(env, idC, { decisao: "procedente", nota: "n" }, ADMIN, T0 + DIA);
  assert.equal(linhas(env, "SELECT * FROM relatos_derrubados").length, 2);
  await relatar(env, c.chave, {}, T0 + 2 * DIA);
  const q = await consultar(env, undefined, undefined, T0 + 2 * DIA);
  assert.equal(q.corpo.relatores_distintos, 1, "relato novo traz fato novo e conta");
});

test("relato_ids com relato de outro indicador, inexistente, vazio ou em decisão improcedente é recusado sem derrubar nada", async () => {
  const { env, a, idC } = await doisRelatosContestados();
  await relatar(env, a.chave, { valor: "outro@fraude.example" });
  const idOutro = linhas(env, "SELECT id FROM relatos WHERE indicador_hash <> ?", HASH_ARMAZENADO)[0].id;
  for (const ids of [[idOutro], ["nao-existe"], [], "texto"]) {
    const r = await decidir(env, idC, { decisao: "procedente", nota: "n", relato_ids: ids });
    assert.equal(r.status, 400, JSON.stringify(ids));
  }
  const imp = await decidir(env, idC, { decisao: "improcedente", nota: "n", relato_ids: ["x"] });
  assert.equal(imp.status, 400);
  assert.equal(linhas(env, "SELECT * FROM relatos_derrubados").length, 0);
  assert.equal(linhas(env, "SELECT estado FROM contestacoes")[0].estado, "em_analise");
});

test("relatos derrubados refutam só os relatores desses relatos (o outro não perde reputação)", async () => {
  const { env, idA, idC } = await doisRelatosContestados();
  await decidir(env, idC, { decisao: "procedente", nota: "n", relato_ids: [idA] });
  // B segue sozinho no indicador (0.2); se B fosse refutado também, o score seria menor
  const q = await consultar(env, undefined, undefined, T0 + DIA);
  assert.equal(q.corpo.score, Math.round(100 * (1 - Math.exp(-0.2 * Math.pow(0.5, 1 / 90) / 1.5))));
});

// ---------- suspensão, remoção, evidência ----------

test("relator suspenso leva 403 ao reportar, mas os relatos pendentes dele seguem contando", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave);
  const antes = (await consultar(env)).corpo.score;
  assert.equal((await admin(env, `/v1/admin/relatores/${a.relator_id}/suspender`)).status, 200);
  const r = await relatar(env, a.chave, { valor: "outro@fraude.example" });
  assert.equal(r.status, 403);
  assert.equal(r.corpo.erro, "relator_suspenso");
  assert.equal(linhas(env, "SELECT * FROM relatos").length, 1);
  assert.equal((await consultar(env)).corpo.score, antes);
});

test("reativar devolve ao relator suspenso o direito de reportar", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await admin(env, `/v1/admin/relatores/${a.relator_id}/suspender`);
  await admin(env, `/v1/admin/relatores/${a.relator_id}/reativar`);
  assert.equal((await relatar(env, a.chave)).status, 201);
  assert.equal((await admin(env, "/v1/admin/relatores/nao-existe/suspender")).status, 404);
});

test("remover relato tira do score, apaga a evidência e deixa tombstone com o motivo", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave, { evidencia: "prova-secreta" });
  const id = linhas(env, "SELECT id FROM relatos")[0].id;
  const r = await admin(env, `/v1/admin/relatos/${id}/remover`, { motivo: "titular" });
  assert.equal(r.status, 200);
  const linha = linhas(env, "SELECT * FROM relatos WHERE id = ?", id)[0];
  assert.equal(linha.evidencia, null);
  assert.equal(linha.removido_motivo, "titular");
  assert.equal(linha.removido_em, T0 + DIA);
  const q = await consultar(env, undefined, undefined, T0 + DIA);
  assert.equal(q.corpo.score, 0);
  assert.equal(q.corpo.relatores_distintos, 0);
  assert.equal(q.corpo.ultimo_relato_em, null);
});

test("remover relato exige motivo da lista, existir e não repetir", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave);
  const id = linhas(env, "SELECT id FROM relatos")[0].id;
  assert.equal((await admin(env, `/v1/admin/relatos/${id}/remover`, { motivo: "porque sim" })).status, 400);
  assert.equal((await admin(env, `/v1/admin/relatos/${id}/remover`, {})).status, 400);
  assert.equal((await admin(env, "/v1/admin/relatos/nao-existe/remover", { motivo: "malicioso" })).status, 404);
  assert.equal((await admin(env, `/v1/admin/relatos/${id}/remover`, { motivo: "expirado" })).status, 200);
  assert.equal((await admin(env, `/v1/admin/relatos/${id}/remover`, { motivo: "expirado" })).status, 409);
});

test("relato removido como malicioso derruba a reputação do relator; como titular, não", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  const b = await novoRelator(env, "B");
  await relatar(env, a.chave, { valor: "x1@fraude.example" });
  await relatar(env, a.chave, { valor: "y@fraude.example" });
  await relatar(env, b.chave, { valor: "x2@fraude.example" });
  await relatar(env, b.chave, { valor: "z@fraude.example" });
  const id = async (rel, valor) =>
    linhas(env, "SELECT id FROM relatos WHERE relator_id = ? AND indicador_hash = ?", rel.relator_id, await hashArmazenado(PEPPER, hashIndicador("email", valor)))[0].id;
  await admin(env, `/v1/admin/relatos/${await id(a, "x1@fraude.example")}/remover`, { motivo: "malicioso" });
  await admin(env, `/v1/admin/relatos/${await id(b, "x2@fraude.example")}/remover`, { motivo: "titular" });
  const f = Math.pow(0.5, 1 / 90);
  const pesoCom = (rep) => Math.round(100 * (1 - Math.exp(-(rep * f) / 1.5)));
  // A: 1 refutado, 0 corroborações: 0.2/(1+0+2) = 0.0667. B: remoção por titular não é culpa dele: 0.2.
  assert.equal((await consultar(env, "y@fraude.example", "email", T0 + DIA)).corpo.score, pesoCom(0.2 / 3));
  assert.equal((await consultar(env, "z@fraude.example", "email", T0 + DIA)).corpo.score, pesoCom(0.2));
});

test("remover o relato libera o dedupe: o relator pode reportar de novo o mesmo indicador", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave);
  const id = linhas(env, "SELECT id FROM relatos")[0].id;
  assert.equal((await relatar(env, a.chave, {}, T0 + 1000)).status, 409);
  await admin(env, `/v1/admin/relatos/${id}/remover`, { motivo: "titular" });
  assert.equal((await relatar(env, a.chave, {}, T0 + DIA)).status, 201);
});

test("apagar evidência zera só a evidência: o relato continua no score", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave, { evidencia: "dado-pessoal-por-engano" });
  const id = linhas(env, "SELECT id FROM relatos")[0].id;
  const antes = (await consultar(env)).corpo.score;
  assert.equal((await admin(env, `/v1/admin/relatos/${id}/apagar-evidencia`)).status, 200);
  const linha = linhas(env, "SELECT * FROM relatos WHERE id = ?", id)[0];
  assert.equal(linha.evidencia, null);
  assert.equal(linha.removido_em, null);
  assert.equal((await consultar(env)).corpo.score, antes);
  assert.equal((await admin(env, "/v1/admin/relatos/nao-existe/apagar-evidencia")).status, 404);
});

// ---------- auto-solicitação de chave ----------

const solicitar = (env, extra = {}, ip, agora = T0) =>
  chamar(env, "POST", "/v1/relatores/solicitacoes", {
    corpo: { nome: "Loja Nova", contato: "dono@lojanova.example", loja_url: "https://lojanova.example", ...extra },
    ip,
  }, agora);

test("solicitação pública entra pendente, devolve só o id e não cria relator nem chave", async () => {
  const env = ambiente();
  const r = await solicitar(env);
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.corpo), ["id"]);
  assert.equal(linhas(env, "SELECT * FROM relatores").length, 0);
  assert.equal(linhas(env, "SELECT estado FROM solicitacoes_relator")[0].estado, "pendente");
});

test("solicitação com URL perigosa, campos vazios ou ausentes é recusada", async () => {
  const env = ambiente();
  const casos = [{ loja_url: "javascript:alert(1)" }, { loja_url: "ftp://x.example" }, { loja_url: "não é url" }, { nome: "" }, { contato: undefined }];
  // IP diferente por caso: o limite de 3 por hora não pode mascarar a validação.
  for (const [i, extra] of casos.entries()) {
    assert.equal((await solicitar(env, extra, `198.51.${100 + i}.9`)).status, 400, JSON.stringify(extra));
  }
  assert.equal(linhas(env, "SELECT * FROM solicitacoes_relator").length, 0);
});

test("solicitação passa de 3 por hora por balde de rede e leva 429, sem afetar outro balde", async () => {
  const env = ambiente();
  for (let i = 0; i < 3; i++) assert.equal((await solicitar(env, {}, "198.51.100.5")).status, 201);
  assert.equal((await solicitar(env, {}, "198.51.100.5")).status, 429);
  assert.equal((await solicitar(env, {}, "198.51.101.6")).status, 201);
  assert.equal((await solicitar(env, {}, "198.51.100.5", T0 + 3_600_000)).status, 201);
  const chaves = linhas(env, "SELECT chave FROM limites").map((l) => l.chave).join(" ");
  assert.ok(!chaves.includes("198.51.100.5"));
});

test("aprovar solicitação cria o relator, devolve a chave uma vez e a chave funciona", async () => {
  const env = ambiente();
  const { corpo: { id } } = await solicitar(env);
  const lista = await chamar(env, "GET", "/v1/admin/solicitacoes?estado=pendente", { token: ADMIN });
  assert.equal(lista.corpo.solicitacoes.length, 1);
  assert.equal(lista.corpo.solicitacoes[0].loja_url, "https://lojanova.example");
  const ap = await admin(env, `/v1/admin/solicitacoes/${id}/aprovar`);
  assert.equal(ap.status, 200);
  assert.match(ap.corpo.chave, /^rdc_[0-9a-f]{64}$/);
  assert.equal((await relatar(env, ap.corpo.chave)).status, 201);
  const linha = linhas(env, "SELECT * FROM solicitacoes_relator WHERE id = ?", id)[0];
  assert.equal(linha.estado, "aprovada");
  assert.equal(linha.relator_id, ap.corpo.relator_id);
  assert.ok(!JSON.stringify(linha).includes(ap.corpo.chave));
  const depois = await chamar(env, "GET", "/v1/admin/solicitacoes?estado=pendente", { token: ADMIN });
  assert.equal(depois.corpo.solicitacoes.length, 0);
  assert.ok(!JSON.stringify(depois.corpo).includes(ap.corpo.chave));
});

test("aprovar duas vezes ou depois de recusar dá 409 e não cria um segundo relator", async () => {
  const env = ambiente();
  const a = (await solicitar(env)).corpo.id;
  const b = (await solicitar(env)).corpo.id;
  assert.equal((await admin(env, `/v1/admin/solicitacoes/${a}/aprovar`)).status, 200);
  assert.equal((await admin(env, `/v1/admin/solicitacoes/${a}/aprovar`)).status, 409);
  assert.equal((await admin(env, `/v1/admin/solicitacoes/${b}/recusar`, { nota: "loja não verificada" })).status, 200);
  assert.equal((await admin(env, `/v1/admin/solicitacoes/${b}/aprovar`)).status, 409);
  assert.equal((await admin(env, `/v1/admin/solicitacoes/${b}/recusar`)).status, 409);
  assert.equal((await admin(env, "/v1/admin/solicitacoes/nao-existe/aprovar")).status, 404);
  assert.equal(linhas(env, "SELECT * FROM relatores").length, 1);
  assert.equal(linhas(env, "SELECT estado FROM solicitacoes_relator WHERE id = ?", b)[0].estado, "recusada");
});

test("aprovação que falha ao criar o relator devolve a solicitação à fila", async () => {
  const env = ambiente();
  const id = (await solicitar(env)).corpo.id;
  env.DB.sqlite.exec("DROP TABLE relatores");
  const r = await admin(env, `/v1/admin/solicitacoes/${id}/aprovar`);
  assert.equal(r.status, 500);
  assert.equal(linhas(env, "SELECT estado FROM solicitacoes_relator")[0].estado, "pendente");
});

// ---------- expiração ----------

import { expirar, prazosDeExpiracao, RETENCAO_DIAS } from "../src/expiracao.js";

test("prazosDeExpiracao é pura: 24 meses são 730 dias contados do agora recebido", () => {
  const p = prazosDeExpiracao(T0);
  assert.equal(RETENCAO_DIAS, 730);
  assert.equal(p.relatos_criados_antes_de, T0 - 730 * DIA);
  assert.deepEqual(prazosDeExpiracao(T0), p);
});

test("expirar remove relatos com mais de 24 meses (e os derrubados deles) e preserva os recentes", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave, { valor: "velho@fraude.example" }, T0 - 731 * DIA);
  await relatar(env, a.chave, { valor: "novo@fraude.example" }, T0 - 700 * DIA);
  const velho = linhas(env, "SELECT id FROM relatos WHERE criado_em < ?", T0 - 730 * DIA)[0].id;
  env.DB.sqlite.prepare("INSERT INTO relatos_derrubados VALUES (?, 'c', ?)").run(velho, T0);
  const r = await expirar(env.DB, T0);
  assert.equal(r.relatos, 1);
  assert.equal(r.relatos_derrubados, 1);
  assert.equal(linhas(env, "SELECT * FROM relatos").length, 1);
  assert.equal(linhas(env, "SELECT * FROM relatos_derrubados").length, 0);
});

test("expirar remove contestação decidida há mais de 24 meses, mas nunca a que ainda espera decisão", async () => {
  const env = ambiente();
  const ins = env.DB.sqlite.prepare(
    `INSERT INTO contestacoes (id, tipo_indicador, indicador_hash, motivo, estado, criado_em, decidido_em)
     VALUES (?, 'email', ?, 'motivo comprido o bastante', ?, ?, ?)`,
  );
  const velho = T0 - 800 * DIA;
  ins.run("decidida-velha", "h".repeat(64), "improcedente", velho, velho);
  ins.run("decidida-recente", "h".repeat(64), "procedente", velho, T0 - 10 * DIA);
  ins.run("aberta-velha", "h".repeat(64), "aberta", velho, null);
  ins.run("analise-velha", "h".repeat(64), "em_analise", velho, null);
  const r = await expirar(env.DB, T0);
  assert.equal(r.contestacoes, 1);
  assert.deepEqual(linhas(env, "SELECT id FROM contestacoes ORDER BY id").map((l) => l.id), ["aberta-velha", "analise-velha", "decidida-recente"]);
});

test("expirar poda contadores de limites vencidos e mantém a janela atual", async () => {
  const env = ambiente();
  await consultar(env, "a@b.example", "email", T0 - 3 * 60_000, "198.51.100.1"); // janela antiga
  await consultar(env, "a@b.example", "email", T0, "198.51.100.2"); // janela atual
  await solicitar(env, {}, "198.51.100.3", T0 - 5 * 3_600_000);
  const r = await expirar(env.DB, T0);
  assert.equal(r.limites, 2);
  assert.equal(linhas(env, "SELECT * FROM limites").length, 1);
});

test("o handler scheduled do worker executa a expiração", async () => {
  const env = ambiente();
  const a = await novoRelator(env, "A");
  await relatar(env, a.chave, {}, Date.now() - 800 * DIA);
  const esperas = [];
  worker.scheduled({}, env, { waitUntil: (p) => esperas.push(p) });
  await Promise.all(esperas);
  assert.equal(linhas(env, "SELECT * FROM relatos").length, 0);
});

// ---------- esquema ----------

test("a migração 002 preserva contestações do v1 e aceita o estado em_analise", () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("001_inicial.sql", DIR_ESQUEMA), "utf8"));
  sqlite.exec(
    `INSERT INTO contestacoes (id, tipo_indicador, indicador_hash, motivo, estado, decidido_em)
     VALUES ('c1', 'email', '${"a".repeat(64)}', 'motivo antigo do v1', 'procedente', 12345)`,
  );
  sqlite.exec(readFileSync(new URL("002_v1_1.sql", DIR_ESQUEMA), "utf8"));
  const c = sqlite.prepare("SELECT * FROM contestacoes WHERE id = 'c1'").get();
  assert.equal(c.estado, "procedente");
  assert.equal(c.decidido_em, 12345);
  assert.equal(c.criado_em, 12345);
  sqlite.exec(`UPDATE contestacoes SET estado = 'em_analise' WHERE id = 'c1'`);
});
