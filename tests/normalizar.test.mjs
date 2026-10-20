import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizar,
  hashIndicador,
  CATEGORIAS,
  PESOS_CATEGORIA,
  TIPOS,
} from "../src/normalizar.js";

const recusa = (tipo, valor) =>
  assert.throws(
    () => normalizar(tipo, valor),
    (e) => e instanceof Error && e.codigo === "indicador_invalido",
    `${tipo} ${JSON.stringify(valor)} deveria ser recusado`,
  );

// ---------- ip ----------

test("IPv4 com espaços em volta gera o mesmo indicador que o limpo", () => {
  assert.equal(normalizar("ip", "  203.0.114.7 "), "203.0.114.7");
});

test("IPv4 com zero à esquerda é recusado em vez de virar outro indicador (octal)", () => {
  recusa("ip", "203.000.114.007");
  recusa("ip", "010.1.1.1");
});

test("IPv4 com octeto fora de 0..255 ou com partes faltando é recusado", () => {
  recusa("ip", "256.1.1.1");
  recusa("ip", "1.2.3");
  recusa("ip", "1.2.3.4.5");
  recusa("ip", "a.b.c.d");
});

test("IPv4 privado, loopback, link-local, CGNAT e reservado são recusados", () => {
  for (const ip of [
    "10.0.0.1",
    "172.16.5.5",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    recusa("ip", ip);
  }
});

test("IPv4 público vizinho de faixa privada não é recusado por engano", () => {
  assert.equal(normalizar("ip", "172.32.0.1"), "172.32.0.1");
  assert.equal(normalizar("ip", "172.15.0.1"), "172.15.0.1");
  assert.equal(normalizar("ip", "100.63.255.255"), "100.63.255.255");
});

test("IPv6 de um mesmo /64 colapsa no mesmo indicador, senão trocar o sufixo burla o banimento", () => {
  const a = normalizar("ip", "2804:14d:5c81:4b2a:1111:2222:3333:4444");
  const b = normalizar("ip", "2804:14D:5C81:4B2A::9");
  assert.equal(a, "2804:014d:5c81:4b2a::/64");
  assert.equal(a, b);
});

test("IPv6 com :: no começo do prefixo é expandido corretamente", () => {
  assert.equal(normalizar("ip", "2a00::1"), "2a00:0000:0000:0000::/64");
  assert.equal(normalizar("ip", "2a00:1::"), "2a00:0001:0000:0000::/64");
});

test("IPv6 de /64 diferente não colide", () => {
  assert.notEqual(
    normalizar("ip", "2804:14d:5c81:4b2a::1"),
    normalizar("ip", "2804:14d:5c81:4b2b::1"),
  );
});

test("IPv6 loopback, não especificado, link-local, ULA, multicast e documentação são recusados", () => {
  for (const ip of ["::1", "::", "fe80::1", "febf::1", "fd00::1", "fc12::1", "ff02::1", "2001:db8::1"]) {
    recusa("ip", ip);
  }
});

test("IPv6 mapeado de IPv4 vira o IPv4, e o mapeado privado continua recusado", () => {
  assert.equal(normalizar("ip", "::ffff:203.0.114.7"), "203.0.114.7");
  recusa("ip", "::ffff:10.0.0.1");
  recusa("ip", "::ffff:192.168.0.1");
});

test("IPv6 malformado, com zona ou com prefixo é recusado", () => {
  recusa("ip", "2804::1::2");
  recusa("ip", "2804:zzzz::1");
  recusa("ip", "fe80::1%eth0");
  recusa("ip", "2804:14d::/32");
  recusa("ip", "1:2:3:4:5:6:7:8:9");
});

// ---------- email ----------

test("e-mail em maiúsculas e com espaços gera o mesmo indicador do limpo", () => {
  assert.equal(normalizar("email", "  Ana.Silva@Exemplo.COM "), "ana.silva@exemplo.com");
});

test("+tag é removida: aliases do mesmo e-mail não escapam de relatos anteriores", () => {
  assert.equal(normalizar("email", "ana+loja1@exemplo.com"), "ana@exemplo.com");
  assert.equal(normalizar("email", "ana+a+b@exemplo.com"), "ana@exemplo.com");
});

test("gmail com pontos e +tag colapsa para a mesma caixa", () => {
  assert.equal(normalizar("email", "A.n.a+promo@gmail.com"), "ana@gmail.com");
});

test("googlemail.com é tratado como gmail.com", () => {
  assert.equal(normalizar("email", "a.na@googlemail.com"), "ana@gmail.com");
});

test("pontos em e-mail que não é gmail são preservados (são significativos)", () => {
  assert.equal(normalizar("email", "a.na@exemplo.com"), "a.na@exemplo.com");
});

test("domínio internacional do e-mail vai para punycode", () => {
  assert.equal(normalizar("email", "ana@exemplo.bücher.de"), "ana@exemplo.xn--bcher-kva.de");
});

test("e-mail sem arroba, sem parte local, sem domínio ou com espaço interno é recusado", () => {
  recusa("email", "semarroba.com");
  recusa("email", "@exemplo.com");
  recusa("email", "ana@");
  recusa("email", "ana @exemplo.com");
  recusa("email", "ana@semponto");
  recusa("email", "a@b@exemplo.com");
});

test("e-mail cuja parte local some depois de tirar a +tag é recusado", () => {
  recusa("email", "+tag@exemplo.com");
  recusa("email", "...+x@gmail.com");
});

// ---------- dominio ----------

test("domínio em maiúsculas, com www. e ponto final gera o mesmo indicador do limpo", () => {
  assert.equal(normalizar("dominio", "WWW.Loja-Falsa.com.br."), "loja-falsa.com.br");
});

test("domínio internacional vira punycode", () => {
  assert.equal(normalizar("dominio", "bücher.de"), "xn--bcher-kva.de");
  assert.equal(normalizar("dominio", "xn--bcher-kva.de"), "xn--bcher-kva.de");
});

test("só o primeiro www. é removido e subdomínio real é preservado", () => {
  assert.equal(normalizar("dominio", "pagamento.loja.com"), "pagamento.loja.com");
  assert.equal(normalizar("dominio", "www.www.loja.com"), "www.loja.com");
});

test("domínio sem ponto, só www, com caminho, porta ou TLD numérico (IP disfarçado) é recusado", () => {
  recusa("dominio", "localhost");
  recusa("dominio", "www.com");
  recusa("dominio", "loja.com/pagina");
  recusa("dominio", "loja.com:8080");
  recusa("dominio", "1.2.3.4");
  recusa("dominio", "-loja.com");
  recusa("dominio", "loja..com");
  recusa("dominio", "");
});

// ---------- dispositivo ----------

test("dispositivo opaco válido passa exatamente como veio, sem mudar caixa", () => {
  assert.equal(normalizar("dispositivo", "AbC123_-xyZ"), "AbC123_-xyZ");
});

test("dispositivo curto demais, longo demais ou com caracteres fora de [A-Za-z0-9_-] é recusado", () => {
  recusa("dispositivo", "curto12");
  recusa("dispositivo", "a".repeat(129));
  recusa("dispositivo", "abcdefgh ijkl");
  recusa("dispositivo", "abcdefgh!");
  recusa("dispositivo", " abcdefgh");
  assert.equal(normalizar("dispositivo", "a".repeat(128)), "a".repeat(128));
  assert.equal(normalizar("dispositivo", "a".repeat(8)), "a".repeat(8));
});

// ---------- entradas inválidas gerais ----------

test("tipo desconhecido ou herdado do protótipo é recusado", () => {
  recusa("telefone", "11999999999");
  recusa("__proto__", "x");
  recusa("constructor", "x");
});

test("valor que não é texto é recusado em vez de virar 'undefined' no hash", () => {
  recusa("ip", undefined);
  recusa("email", null);
  recusa("dominio", 123);
  recusa("dispositivo", {});
});

// ---------- hash ----------

test("hash tem 64 hex e é estável entre chamadas (valor fixo conhecido)", () => {
  const h = hashIndicador("dominio", "loja-falsa.com.br");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashIndicador("dominio", "loja-falsa.com.br"));
  // sha256("rdc:v1:dominio:loja-falsa.com.br"), calculado fora do código sob teste (python hashlib)
  assert.equal(h, "e96c47b9cdb82637f5464d2bf449b4e75d34620ed78e000a17d5891d42d49580");
});

test("hash não depende da forma escrita: variantes do mesmo indicador colidem de propósito", () => {
  assert.equal(
    hashIndicador("email", "A.N.A+x@Gmail.com"),
    hashIndicador("email", "ana@googlemail.com"),
  );
  assert.equal(hashIndicador("dominio", "WWW.Loja.com."), hashIndicador("dominio", "loja.com"));
});

test("hash separa tipos: o tipo entra no material do hash, então textos iguais de tipos diferentes não colidem", async () => {
  const { createHash } = await import("node:crypto");
  const comOutroTipo = createHash("sha256").update("rdc:v1:email:abcdefgh").digest("hex");
  assert.notEqual(hashIndicador("dispositivo", "abcdefgh"), comOutroTipo);
});

test("hash usa o prefixo de versão 'rdc:v1:' exatamente como no contrato", async () => {
  const { createHash } = await import("node:crypto");
  const esperado = createHash("sha256").update("rdc:v1:ip:203.0.114.7").digest("hex");
  assert.equal(hashIndicador("ip", "203.0.114.7"), esperado);
});

test("hash de indicador inválido lança em vez de gerar hash de lixo", () => {
  assert.throws(() => hashIndicador("ip", "10.0.0.1"), { codigo: "indicador_invalido" });
});

test("o valor cru não aparece no hash nem na mensagem de erro", () => {
  const h = hashIndicador("email", "segredo.pessoa@exemplo.com");
  assert.ok(!h.includes("segredo"));
  try {
    normalizar("email", "segredo pessoa@exemplo.com");
  } catch (e) {
    assert.ok(!e.message.includes("segredo"));
  }
});

// ---------- constantes ----------

test("categorias e pesos batem com o contrato e todo peso está entre 0 e 1", () => {
  assert.deepEqual([...CATEGORIAS].sort(), [
    "bot_abuso",
    "cartao_testado",
    "chargeback",
    "conta_falsa",
    "outro",
    "phishing",
  ]);
  assert.deepEqual(
    { ...PESOS_CATEGORIA },
    { chargeback: 1.0, cartao_testado: 0.9, conta_falsa: 0.6, phishing: 0.8, bot_abuso: 0.5, outro: 0.2 },
  );
  for (const c of CATEGORIAS) assert.ok(PESOS_CATEGORIA[c] > 0 && PESOS_CATEGORIA[c] <= 1);
  assert.deepEqual([...TIPOS], ["ip", "email", "dominio", "dispositivo"]);
});

// ---------- v1.2: IPv6 reservado e balde de rede ----------

import { baldeDeIp } from "../src/normalizar.js";

test("::2, ::1.2.3.4 e ::5.6.7.8 são recusados: não colidem mais no mesmo /64 de lixo", () => {
  for (const ip of ["::2", "::1.2.3.4", "::5.6.7.8", "::8.8.8.8", "0:0:0:1::1", "ff::1"]) recusa("ip", ip);
});

test("IPv6 IPv4-compatível, descarte (100::/64), Teredo e protocolos IETF (2001::/23) são recusados", () => {
  for (const ip of ["::0.0.0.2", "100::1", "100::ffff:1", "2001::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:1ff::1", "3fff::1"]) recusa("ip", ip);
});

test("6to4 embrulhando IPv4 privado é recusado, e embrulhando IPv4 público vira o IPv4 (um indicador só)", () => {
  recusa("ip", "2002:0a00:0001::1"); // 10.0.0.1
  recusa("ip", "2002:c0a8:0001::1"); // 192.168.0.1
  recusa("ip", "2002:7f00:0001::"); // 127.0.0.1
  assert.equal(normalizar("ip", "2002:0808:0808::1"), "8.8.8.8");
  assert.equal(normalizar("ip", "2002:0808:0808:1:2:3:4:5"), "8.8.8.8");
});

test("NAT64 (64:ff9b::/96) embrulhando IPv4 privado é recusado, e embrulhando público vira o IPv4", () => {
  recusa("ip", "64:ff9b::a00:1"); // 10.0.0.1
  recusa("ip", "64:ff9b::192.168.0.1");
  recusa("ip", "64:ff9b::7f00:1");
  assert.equal(normalizar("ip", "64:ff9b::808:808"), "8.8.8.8");
  assert.equal(normalizar("ip", "64:ff9b::8.8.8.8"), "8.8.8.8");
});

test("IPv6 global comum continua virando /64, inclusive o que começa com 2001:200 e 2002 fora do envelope", () => {
  assert.equal(normalizar("ip", "2001:200::1"), "2001:0200:0000:0000::/64");
  assert.equal(normalizar("ip", "2a00::1"), "2a00:0000:0000:0000::/64");
});

test("baldeDeIp: IPv4 por /24 e IPv6 por /64, com IPv4 mapeado contando como o IPv4", () => {
  assert.equal(baldeDeIp("198.51.100.7"), baldeDeIp("198.51.100.250"));
  assert.notEqual(baldeDeIp("198.51.100.7"), baldeDeIp("198.51.101.7"));
  assert.equal(baldeDeIp("2804:14d:5c81:4b2a:1::1"), baldeDeIp("2804:14D:5C81:4B2A:ffff:ffff:ffff:ffff"));
  assert.notEqual(baldeDeIp("2804:14d:5c81:4b2a::1"), baldeDeIp("2804:14d:5c81:4b2b::1"));
  assert.equal(baldeDeIp("::ffff:198.51.100.9"), baldeDeIp("198.51.100.200"));
});

test("baldeDeIp dá balde também a IP privado e reservado (o limite vale para todo mundo) e junta o ilegível num só", () => {
  assert.notEqual(baldeDeIp("10.0.0.1"), "desconhecido");
  assert.notEqual(baldeDeIp("::1"), "desconhecido");
  for (const ruim of [undefined, null, "", "lixo", "1.2.3", "fe80::1%eth0", "1.2.3.4/24"]) assert.equal(baldeDeIp(ruim), "desconhecido");
});

// ---------- v1.2: limite documentado do e-mail ----------

test("pontos só são ignorados em gmail.com: domínio próprio no Google Workspace mantém b.ad@ e bad@ distintos (limite documentado)", () => {
  assert.notEqual(normalizar("email", "b.ad@empresa.com.br"), normalizar("email", "bad@empresa.com.br"));
  assert.equal(normalizar("email", "b.ad@gmail.com"), normalizar("email", "bad@gmail.com"));
});
