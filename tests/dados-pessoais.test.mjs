import { test } from "node:test";
import assert from "node:assert/strict";
import { contemDadoPessoal, cpfValido, luhnValido } from "../src/dados-pessoais.js";
import { hmacHex, hashArmazenado, segredoValido } from "../src/segredos.js";
import { createHmac } from "node:crypto";

test("cpfValido confere os dois dígitos verificadores e recusa sequências repetidas", () => {
  assert.equal(cpfValido("52998224725"), true);
  assert.equal(cpfValido("52998224726"), false);
  assert.equal(cpfValido("11111111111"), false);
  assert.equal(cpfValido("1234567890"), false);
});

test("luhnValido aceita cartões de teste conhecidos e recusa um dígito trocado ou sequência repetida", () => {
  for (const n of ["4111111111111111", "5555555555554444", "378282246310005"]) assert.equal(luhnValido(n), true, n);
  assert.equal(luhnValido("4111111111111112"), false);
  assert.equal(luhnValido("0000000000000"), false);
  assert.equal(luhnValido("411111111111"), false, "menos de 13 dígitos");
});

test("contemDadoPessoal acha CPF e cartão no meio de frase, com qualquer separador", () => {
  for (const t of ["529.982.247-25", "52998224725", "529 982 247 25", "529-982-247-25", "cpf: 529.982.247-25.", "4111 1111 1111 1111", "4111-1111-1111-1111", "x 378282246310005 y"]) {
    assert.equal(contemDadoPessoal(t), true, t);
  }
});

test("contemDadoPessoal não confunde número maior que contém 11 dígitos válidos, nem texto comum", () => {
  for (const t of ["", "12 tentativas em 3 min", "IP 203.0.113.7", "pedido 20261001", "529.982.247-26", "4111 1111 1111 1112", "123456789012345678901234"]) {
    assert.equal(contemDadoPessoal(t), false, t);
  }
  assert.equal(contemDadoPessoal(undefined), false);
});

test("hmacHex bate com o HMAC-SHA256 do node:crypto e é determinístico", async () => {
  const seg = "s".repeat(40);
  const esperado = createHmac("sha256", seg).update("mensagem").digest("hex");
  assert.equal(await hmacHex(seg, "mensagem"), esperado);
  assert.equal(await hmacHex(seg, "mensagem"), esperado);
  assert.notEqual(await hmacHex(seg + "x", "mensagem"), esperado);
});

test("hashArmazenado normaliza a caixa do hash do cliente antes do HMAC", async () => {
  const seg = "s".repeat(40);
  const h = "ab".repeat(32);
  assert.equal(await hashArmazenado(seg, h.toUpperCase()), await hashArmazenado(seg, h));
});

test("segredoValido exige string de 32 ou mais caracteres", () => {
  assert.equal(segredoValido("x".repeat(32)), true);
  for (const v of ["x".repeat(31), "", undefined, null, 42, ["x".repeat(40)]]) assert.equal(segredoValido(v), false);
});
