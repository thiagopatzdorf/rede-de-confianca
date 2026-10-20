// Segredos do servidor (PEPPER e ADMIN_TOKEN) e o HMAC que os usa.
//
// Em módulo próprio porque o worker e os testes precisam da MESMA função: um
// teste que reimplementasse o HMAC passaria mesmo se o worker usasse outro.

// 32 caracteres: abaixo disso o segredo cabe em força bruta de dicionário, e
// o pepper existe justamente para que um banco vazado não seja reversível.
export const TAMANHO_MINIMO_SEGREDO = 32;

export function segredoValido(valor) {
  return typeof valor === "string" && valor.length >= TAMANHO_MINIMO_SEGREDO;
}

const encoder = new TextEncoder();
// importKey custa; o segredo não muda durante a vida do isolate.
const chaves = new Map();

async function chaveHmac(segredo) {
  if (!chaves.has(segredo)) {
    chaves.set(
      segredo,
      crypto.subtle.importKey("raw", encoder.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    );
  }
  return chaves.get(segredo);
}

/** HMAC-SHA256(segredo, mensagem) em hex minúsculo de 64 caracteres. */
export async function hmacHex(segredo, mensagem) {
  const assinatura = await crypto.subtle.sign("HMAC", await chaveHmac(segredo), encoder.encode(mensagem));
  return [...new Uint8Array(assinatura)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash que o servidor GUARDA para um indicador: HMAC-SHA256(PEPPER, hash do
 * cliente). O hash do cliente (`hashIndicador`, "rdc:v1:...") segue público e
 * é o que viaja na API; só o que está no banco depende do segredo.
 */
export function hashArmazenado(pepper, hashDoCliente) {
  return hmacHex(pepper, String(hashDoCliente).toLowerCase());
}
