// Ambiente compartilhado dos testes de API: D1 falso sobre node:sqlite (SQLite
// em memória com o esquema real), requisições e atalhos. Não termina em
// .test.mjs de propósito: o `node --test` não o executa como teste.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { tratar } from "../src/worker.js";

// Todas as migrações em ordem, como `wrangler d1 migrations apply` faz: testar
// só o 001 esconderia erro na 002.
export const DIR_ESQUEMA = new URL("../schema/", import.meta.url);
const ESQUEMA = readdirSync(DIR_ESQUEMA)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(new URL(f, DIR_ESQUEMA), "utf8"))
  .join("\n");

export const ADMIN = "token-de-moderacao-de-teste-com-mais-de-32-caracteres";
export const PEPPER = "pepper-de-teste-com-mais-de-32-caracteres-aleatorios";
export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
export const DIA = 86_400_000;
// Idade que libera o peso de uma conta (mais de 7 dias): relator criado em T0
// só pesa a partir daqui.
export const T_MADURO = T0 + 10 * DIA;

// Mesma superfície do D1 que o worker usa: prepare/bind/first/all/run. `log`
// guarda o SQL de cada execução, para os testes de custo.
export function d1Falso() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(ESQUEMA);
  const log = [];
  const db = {
    sqlite,
    log,
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const vinculado = (args) => ({
        async first() {
          log.push(sql);
          return stmt.get(...args) ?? null;
        },
        async all() {
          log.push(sql);
          return { results: stmt.all(...args).map((l) => ({ ...l })) };
        },
        async run() {
          log.push(sql);
          const r = stmt.run(...args);
          return { success: true, meta: { changes: Number(r.changes) } };
        },
      });
      return { bind: (...args) => vinculado(args), ...vinculado([]) };
    },
  };
  return db;
}

export function ambiente(extra = {}) {
  return { DB: d1Falso(), ADMIN_TOKEN: ADMIN, PEPPER, ...extra };
}

export function req(metodo, caminho, { corpo, token, ip = "203.0.113.7", bruto, tipoConteudo = "application/json", headers = {} } = {}) {
  const h = { "cf-connecting-ip": ip, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method: metodo, headers: h };
  if (bruto !== undefined) init.body = bruto;
  else if (corpo !== undefined) init.body = JSON.stringify(corpo);
  if (init.body !== undefined && tipoConteudo) h["content-type"] = tipoConteudo;
  return new Request("https://rede.test" + caminho, init);
}

export async function chamar(env, metodo, caminho, opcoes = {}, agora = T0) {
  const res = await tratar(req(metodo, caminho, opcoes), env, agora);
  return { status: res.status, corpo: await res.json(), res };
}

// Por padrão o relator nasce 30 dias antes de T0: conta com menos de 7 dias pesa
// 0 no score, e a maioria dos testes quer um relator que pesa. Os testes de
// conta nova passam `agora = T0` de propósito.
export const T_ANTES = T0 - 30 * DIA;
export async function novoRelator(env, nome = "Loja A", agora = T_ANTES) {
  const r = await chamar(env, "POST", "/v1/admin/relatores", { token: ADMIN, corpo: { nome, contato: `${nome}@loja.example` } }, agora);
  assert.equal(r.status, 201);
  return r.corpo;
}

export const admin = (env, caminho, corpo = {}, agora = T0 + DIA) =>
  chamar(env, "POST", caminho, { token: ADMIN, corpo }, agora);

export async function novoRelatorVerificado(env, nome, agora = T_ANTES) {
  const r = await novoRelator(env, nome, agora);
  assert.equal((await admin(env, `/v1/admin/relatores/${r.relator_id}/verificar`, {}, agora)).status, 200);
  return r;
}

export const linhas = (env, sql, ...args) => env.DB.sqlite.prepare(sql).all(...args);

export const relatar = (env, chave, extra = {}, agora = T0) =>
  chamar(env, "POST", "/v1/relatos", {
    token: chave,
    corpo: { tipo: "email", valor: "golpista@fraude.example", categoria: "chargeback", ...extra },
  }, agora);

export const consultar = (env, valor = "golpista@fraude.example", tipo = "email", agora = T0, ip) =>
  chamar(env, "POST", "/v1/consulta", { corpo: { tipo, valor }, ip }, agora);
