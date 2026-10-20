// Limites de uso (contrato). Em módulo próprio porque o worker os aplica e a
// expiração diária precisa saber a duração de cada janela para podar a tabela
// `limites`: duas cópias divergiriam.
export const MIN = 60_000;
export const HORA = 60 * MIN;
export const DIA = 24 * HORA;

// A chave gravada em `limites` é "<prefixo>:<hmac>"; o prefixo diz a janela.
//
// Consulta, contestação, solicitação e admin são contados por BALDE de rede
// (IPv4 /24, IPv6 /64), não por endereço: quem tem um /64 tem 2^64 endereços, e
// um /24 são 256 que o mesmo operador costuma controlar. Por isso os tetos são
// do balde inteiro. Foram escolhidos para a loja pequena atrás de NAT (poucas
// consultas por minuto, ~4 por pedido) não esbarrar neles, e ainda assim
// manter a varredura cara: 300/min são ~432 mil consultas por dia por balde.
export const LIMITES = {
  consulta: { max: 300, janela_ms: MIN },
  contestacao: { max: 10, janela_ms: HORA },
  relato: { max: 200, janela_ms: DIA },
  solicitacao: { max: 3, janela_ms: HORA },
  // Só TENTATIVAS FALHAS de autenticação de moderação contam.
  admin: { max: 10, janela_ms: HORA },
};
