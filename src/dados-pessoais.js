// Varredura de dado pessoal em texto livre (evidência, motivo, URL da loja).
// A rede promete nunca guardar CPF nem cartão (docs/PRIVACIDADE.md); aviso em
// documentação não impede ninguém de colar um, então a entrada é recusada.

// Mesmo dígito repetido passa na conta do CPF (111.111.111-11) e do Luhn
// (0000000000000), mas não é documento de ninguém: recusar daria falso positivo.
const repetido = (digitos) => /^(\d)\1+$/.test(digitos);

export function cpfValido(digitos) {
  if (!/^\d{11}$/.test(digitos) || repetido(digitos)) return false;
  const digito = (n) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(digitos[i]) * (n + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(digitos[9]) && digito(10) === Number(digitos[10]);
}

export function luhnValido(digitos) {
  if (!/^\d{13,19}$/.test(digitos) || repetido(digitos)) return false;
  let soma = 0;
  for (let i = 0; i < digitos.length; i++) {
    let d = Number(digitos[digitos.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    soma += d;
  }
  return soma % 10 === 0;
}

// Sequências delimitadas por não-dígito: sem isso, 11 dígitos no meio de um
// número de cartão de 16 viraria "CPF" e o contrário.
const CANDIDATO_CPF = /(?<!\d)\d{3}[.\- ]?\d{3}[.\- ]?\d{3}[.\- ]?\d{2}(?!\d)/g;
const CANDIDATO_CARTAO = /(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)/g;

/**
 * `true` se o texto parece conter CPF (com ou sem pontuação, dígito
 * verificador conferido) ou número de cartão (13 a 19 dígitos, Luhn).
 * Pode recusar um número de pedido que passe no Luhn por acaso (cerca de 1 em
 * 10): é o preço de não deixar cartão entrar; quem relata mascara o número.
 */
export function contemDadoPessoal(texto) {
  if (typeof texto !== "string") return false;
  // NFKC: dígitos de largura total (１２３) valem como dígitos e escapariam do \d.
  const t = texto.normalize("NFKC");
  for (const m of t.matchAll(CANDIDATO_CPF)) {
    if (cpfValido(m[0].replace(/\D/g, ""))) return true;
  }
  for (const m of t.matchAll(CANDIDATO_CARTAO)) {
    if (luhnValido(m[0].replace(/\D/g, ""))) return true;
  }
  return false;
}
