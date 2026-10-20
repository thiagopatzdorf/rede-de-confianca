// Normalização e hash de indicadores (contrato v1, docs/CONTRATO.md).
// Dois lojistas que reportam o "mesmo" indicador escrito de jeitos diferentes
// precisam chegar ao mesmo hash; senão o relato de um nunca corrobora o do outro.
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { isIPv6 } from "node:net";

export const TIPOS = Object.freeze(["ip", "email", "dominio", "dispositivo"]);

export const CATEGORIAS = Object.freeze([
  "chargeback",
  "cartao_testado",
  "conta_falsa",
  "phishing",
  "bot_abuso",
  "outro",
]);

// Peso base (0 a 1) de cada categoria, como no contrato.
export const PESOS_CATEGORIA = Object.freeze({
  chargeback: 1.0,
  cartao_testado: 0.9,
  conta_falsa: 0.6,
  phishing: 0.8,
  bot_abuso: 0.5,
  outro: 0.2,
});

function invalido(mensagem) {
  const e = new Error(mensagem);
  e.codigo = "indicador_invalido";
  return e;
}

// ---------- ip ----------

// Faixas IPv4 que nunca identificam um cliente na internet pública.
// Aceitar essas faixas deixaria um lojista "banir" 10.0.0.1 e contaminar
// consultas de qualquer rede interna.
const FAIXAS_IPV4_RECUSADAS = [
  [0, 8], // "esta rede"
  [10 * 2 ** 24, 8], // privado
  [100 * 2 ** 24 + 64 * 2 ** 16, 10], // 100.64/10: CGNAT (espaço compartilhado)
  [127 * 2 ** 24, 8], // loopback
  [169 * 2 ** 24 + 254 * 2 ** 16, 16], // link-local
  [172 * 2 ** 24 + 16 * 2 ** 16, 12], // privado
  [192 * 2 ** 24, 24], // 192.0.0.0/24 protocolo IETF
  [192 * 2 ** 24 + 2 * 2 ** 8, 24], // documentação TEST-NET-1
  [192 * 2 ** 24 + 168 * 2 ** 16, 16], // privado
  [198 * 2 ** 24 + 18 * 2 ** 16, 15], // benchmark
  [198 * 2 ** 24 + 51 * 2 ** 16 + 100 * 2 ** 8, 24], // TEST-NET-2
  [203 * 2 ** 24 + 113 * 2 ** 8, 24], // TEST-NET-3
  [224 * 2 ** 24, 4], // multicast
  [240 * 2 ** 24, 4], // reservado + broadcast
];

function ipv4ParaInteiro(octetos) {
  return octetos.reduce((acc, o) => acc * 256 + o, 0);
}

function faixaRecusada(n) {
  return FAIXAS_IPV4_RECUSADAS.some(([base, bits]) => {
    const tamanho = 2 ** (32 - bits);
    return n >= base && n < base + tamanho;
  });
}

function parseIPv4(texto) {
  const partes = texto.split(".");
  if (partes.length !== 4) return null;
  const octetos = [];
  for (const p of partes) {
    // Zero à esquerda é ambíguo (octal em alguns parsers): recusar evita que
    // "010.0.0.1" e "10.0.0.1" virem indicadores diferentes ou furem o filtro de IP privado.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octetos.push(n);
  }
  return octetos;
}

function normalizarIPv4(texto) {
  const octetos = parseIPv4(texto);
  if (!octetos) throw invalido("IPv4 inválido");
  if (faixaRecusada(ipv4ParaInteiro(octetos))) {
    throw invalido("IP privado, reservado ou não roteável não pode ser indicador");
  }
  return octetos.join(".");
}

// Expande IPv6 para 8 grupos numéricos de 16 bits. Retorna null se malformado.
function expandirIPv6(texto) {
  let t = texto;
  // Cauda em IPv4 (ex.: ::ffff:1.2.3.4) vira dois grupos hex.
  const ult = t.lastIndexOf(":");
  if (t.slice(ult + 1).includes(".")) {
    const o = parseIPv4(t.slice(ult + 1));
    if (!o) return null;
    const g1 = (o[0] * 256 + o[1]).toString(16);
    const g2 = (o[2] * 256 + o[3]).toString(16);
    t = `${t.slice(0, ult + 1)}${g1}:${g2}`;
  }
  const dupla = t.split("::");
  if (dupla.length > 2) return null;
  const esq = dupla[0] ? dupla[0].split(":") : [];
  const dir = dupla.length === 2 && dupla[1] ? dupla[1].split(":") : [];
  let grupos;
  if (dupla.length === 2) {
    const faltam = 8 - esq.length - dir.length;
    if (faltam < 1) return null;
    grupos = [...esq, ...Array(faltam).fill("0"), ...dir];
  } else {
    grupos = esq;
  }
  if (grupos.length !== 8) return null;
  const nums = grupos.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

function normalizarIPv6(texto) {
  const g = expandirIPv6(texto);
  if (!g) throw invalido("IPv6 inválido");

  // ::ffff:a.b.c.d (IPv4 mapeado) é o primeiro envelope.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return normalizarIPv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join("."));
  }

  // IPv4 embrulhado em IPv6: o indicador é o IPv4, senão o mesmo cliente teria
  // dois hashes e o filtro de IPv4 privado seria contornado por um envelope.
  //  - 6to4 (2002::/16): os 32 bits seguintes ao prefixo são o IPv4;
  //  - NAT64 (64:ff9b::/96): os 32 bits finais são o IPv4.
  if (g[0] === 0x2002) {
    return normalizarIPv4([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255].join("."));
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return normalizarIPv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join("."));
  }

  // ::/8 inteiro: não especificado, loopback e IPv4-compatível (::1.2.3.4,
  // obsoleto). Sem recusar tudo, "::2", "::1.2.3.4" e "::5.6.7.8" caíam no
  // mesmo /64 e qualquer um poderia poluir um hash comum.
  const reservadoZero = (g[0] & 0xff00) === 0;
  const linkLocal = (g[0] & 0xffc0) === 0xfe80; // fe80::/10
  const unicoLocal = (g[0] & 0xfe00) === 0xfc00; // fc00::/7
  const multicast = (g[0] & 0xff00) === 0xff00;
  const documentacao = (g[0] === 0x2001 && g[1] === 0x0db8) || (g[0] === 0x3fff && g[1] < 0x1000);
  const descarte = g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0); // 100::/64
  // 2001::/23: protocolos IETF, inclusive Teredo (2001::/32), que embute IPv4 ofuscado.
  const protocolosIetf = g[0] === 0x2001 && g[1] < 0x0200;
  if (reservadoZero || linkLocal || unicoLocal || multicast || documentacao || descarte || protocolosIetf) {
    throw invalido("IP privado, reservado ou não roteável não pode ser indicador");
  }

  // Só o /64: o usuário de IPv6 controla o sufixo inteiro, então banir o /128
  // seria trivial de contornar trocando o endereço.
  const prefixo = g.slice(0, 4).map(hex4);
  return `${prefixo.join(":")}::/64`;
}

function hex4(n) {
  return n.toString(16).padStart(4, "0");
}

/**
 * Balde de rede de um IP, para limite de uso: IPv4 por /24, IPv6 por /64
 * (IPv4 mapeado em IPv6 conta como o IPv4). NÃO é o indicador e não recusa
 * nada: um IP privado ou reservado também precisa ter balde. Entrada ilegível
 * cai num balde único "desconhecido".
 */
export function baldeDeIp(texto) {
  const t = String(texto ?? "").trim().toLowerCase();
  if (!t || /[%/\s]/.test(t)) return "desconhecido";
  if (t.includes(":")) {
    if (!isIPv6(t)) return "desconhecido";
    const g = expandirIPv6(t);
    if (!g) return "desconhecido";
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `v4:${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.0/24`;
    return `v6:${g.slice(0, 4).map(hex4).join(":")}::/64`;
  }
  const o = parseIPv4(t);
  return o ? `v4:${o[0]}.${o[1]}.${o[2]}.0/24` : "desconhecido";
}

function normalizarIp(valor) {
  const t = valor.trim().toLowerCase();
  // Zona (%eth0) e prefixo (/24) alterariam o hash sem mudar o cliente.
  if (/[%/\s]/.test(t)) throw invalido("IP inválido");
  if (t.includes(":")) {
    if (!isIPv6(t)) throw invalido("IPv6 inválido");
    return normalizarIPv6(t);
  }
  return normalizarIPv4(t);
}

// ---------- dominio / email ----------

function normalizarHost(bruto) {
  let h = bruto.trim().toLowerCase();
  // O parser de URL corta em / : ? # silenciosamente; sem esta checagem
  // "loja.com/pagina" viraria "loja.com" e esconderia entrada malformada.
  if (/[\s/:?#@\\]/.test(h)) throw invalido("domínio inválido");
  h = h.replace(/\.$/, "");
  const ascii = domainToASCII(h);
  if (!ascii || ascii.length > 253) throw invalido("domínio inválido");
  const rotulos = ascii.split(".");
  const ok = rotulos.every((r) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(r));
  // TLD numérico é IP disfarçado de domínio ("1.2.3.4"): tem tipo próprio.
  if (!ok || rotulos.length < 2 || /^\d+$/.test(rotulos[rotulos.length - 1])) {
    throw invalido("domínio inválido");
  }
  return ascii;
}

function normalizarDominio(valor) {
  let h = normalizarHost(valor);
  // "www." é o mesmo site; sem remover, loja.com e www.loja.com teriam reputações separadas.
  if (h.startsWith("www.")) h = h.slice(4);
  if (!h.includes(".")) throw invalido("domínio inválido");
  return h;
}

function normalizarEmail(valor) {
  const t = valor.trim().toLowerCase();
  if (/\s/.test(t)) throw invalido("e-mail inválido");
  const arroba = t.lastIndexOf("@");
  if (arroba < 1 || arroba === t.length - 1) throw invalido("e-mail inválido");
  let local = t.slice(0, arroba);
  let dominio = normalizarHost(t.slice(arroba + 1));
  if (local.includes("@")) throw invalido("e-mail inválido");

  // +tag: a pessoa cria infinitos aliases; sem cortar, cada um escaparia do relato anterior.
  const mais = local.indexOf("+");
  if (mais !== -1) local = local.slice(0, mais);

  if (dominio === "gmail.com" || dominio === "googlemail.com") {
    // O Gmail ignora pontos na parte local: a.b@ e ab@ são a mesma caixa.
    dominio = "gmail.com";
    local = local.replaceAll(".", "");
  }
  if (!local) throw invalido("e-mail inválido");
  return `${local}@${dominio}`;
}

function normalizarDispositivo(valor) {
  // Sem trim nem caixa: é uma impressão opaca calculada pelo cliente.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(valor)) throw invalido("dispositivo inválido");
  return valor;
}

const NORMALIZADORES = {
  ip: normalizarIp,
  email: normalizarEmail,
  dominio: normalizarDominio,
  dispositivo: normalizarDispositivo,
};

export function normalizar(tipo, valor) {
  if (!Object.hasOwn(NORMALIZADORES, tipo)) throw invalido("tipo de indicador desconhecido");
  if (typeof valor !== "string") throw invalido("valor deve ser texto");
  return NORMALIZADORES[tipo](valor);
}

/**
 * Hash de um indicador, o mesmo que a rede calcula: hex de 64 caracteres de
 * `sha256("rdc:v1:" + tipo + ":" + normalizado)`.
 *
 * Feita para ser usada também pelos CLIENTES: calcule o hash na sua máquina e
 * mande só `{ tipo, hash }` para `POST /v1/consulta`, sem que o valor cru
 * (e-mail, IP) saia do seu sistema nem apareça em log de terceiros.
 *
 * @param {"ip"|"email"|"dominio"|"dispositivo"} tipo
 * @param {string} valor valor cru; é normalizado antes do hash
 * @returns {string} hex minúsculo de 64 caracteres
 * @throws {Error} com `.codigo === "indicador_invalido"` se o valor não vale para o tipo
 *   (a mensagem pode conter o valor: não a registre em log)
 */
// O prefixo "rdc:v1:" separa domínios de hash (um e-mail e um domínio iguais em
// texto não colidem) e permite trocar o esquema numa v2 sem misturar hashes.
export function hashIndicador(tipo, valor) {
  const n = normalizar(tipo, valor);
  return createHash("sha256").update(`rdc:v1:${tipo}:${n}`).digest("hex");
}

// Forma do hash aceita nas rotas de consulta e contestação. Só confere o
// formato: a rede não tem como saber se o cliente normalizou direito.
export function ehHashIndicador(texto) {
  return typeof texto === "string" && /^[0-9a-f]{64}$/i.test(texto);
}
