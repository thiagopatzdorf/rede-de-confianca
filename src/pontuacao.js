// Pontuação de risco (contrato v1.2). Funções puras: nada de Date.now(), nada de
// I/O, para que a mesma entrada dê sempre a mesma saída e o resultado seja
// auditável.
import { PESOS_CATEGORIA } from "./normalizar.js";

const MS_POR_DIA = 86_400_000;
const MEIA_VIDA_DIAS = 90;
const LIMITE_SUSPEITO = 25;
const LIMITE_ALTO_RISCO = 75;

// Conta com menos de 7 dias pesa 0: criar contas custa segundos, esperar uma
// semana custa uma semana. Barra o ataque "abro N contas e reporto agora".
export const IDADE_MINIMA_DIAS = 7;
// Reputação mínima para contar como relator "qualificado" (alto_risco) e para
// poder corroborar outro relator.
export const REPUTACAO_MINIMA_ALTO_RISCO = 0.3;
export const REPUTACAO_MINIMA_CORROBORADOR = 0.3;
export const MIN_QUALIFICADOS_ALTO_RISCO = 3;
export const MIN_RELATORES_IP_ALTO_RISCO = 5;
// Tetos por evidência. 1 relator sozinho fica abaixo do limiar de `suspeito`
// (25): a palavra de uma conta só nunca marca ninguém. 2 relatores, no máximo
// `suspeito`. Sem a condição de alto_risco, 74.
export const TETO_1_RELATOR = LIMITE_SUSPEITO - 1;
export const TETO_2_RELATORES = 49;
export const TETO_SEM_ALTO_RISCO = LIMITE_ALTO_RISCO - 1;

const limitar01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function nivelDe(score) {
  if (score >= LIMITE_ALTO_RISCO) return "alto_risco";
  if (score >= LIMITE_SUSPEITO) return "suspeito";
  return "desconhecido";
}

// Sem `relatorDe`, ninguém é verificado e todos são antigos: é o que um
// chamador de teste puro espera. O worker SEMPRE passa `relatorDe` e trata
// relator desconhecido como novo e não verificado (falha para o lado seguro).
const RELATOR_PADRAO = Object.freeze({ verificado: false, criado_em: -Infinity });

/**
 * @param {object} p
 * @param {Array} p.relatos relatos do indicador (ver contrato)
 * @param {number} p.agora ms epoch
 * @param {(id: string) => number} p.reputacaoDe reputação 0..1 do relator
 * @param {(id: string) => {verificado: boolean, criado_em: number}} [p.relatorDe]
 */
export function pontuar({ relatos, agora, reputacaoDe, relatorDe = () => RELATOR_PADRAO }) {
  // Maior peso por (relator, categoria): repetir o mesmo relato não infla o score.
  const melhor = new Map(); // chave -> peso
  const relatores = new Map(); // id -> { rep, verificado, jovem }
  const tipos = new Set();
  let ultimo = null;

  for (const r of relatos ?? []) {
    // Relato derrubado (contestação procedente) sai por completo. Só ESTE
    // estado mexe no score: aberta, em_analise e improcedente não alteram peso.
    // Em análise significa "provou controle do indicador", e o fraudador
    // controla o e-mail dele; essa prova mede identidade, não inocência.
    if (r.contestacao === "procedente") continue;
    const base = Object.hasOwn(PESOS_CATEGORIA, r.categoria) ? PESOS_CATEGORIA[r.categoria] : null;
    // Categoria desconhecida não ganha peso inventado.
    if (base === null) continue;

    if (!relatores.has(r.relator_id)) {
      let rep = 0;
      try {
        rep = limitar01(reputacaoDe(r.relator_id));
      } catch {
        rep = 0; // reputação ilegível não pode virar confiança total
      }
      let info = RELATOR_PADRAO;
      try {
        info = relatorDe(r.relator_id) ?? RELATOR_PADRAO;
      } catch {
        info = { verificado: false, criado_em: agora }; // ilegível: tratado como conta nova
      }
      const idadeDias = (agora - Number(info.criado_em)) / MS_POR_DIA;
      // NaN (criado_em ausente) também cai em "jovem".
      const jovem = !(idadeDias >= IDADE_MINIMA_DIAS);
      relatores.set(r.relator_id, { rep, verificado: info.verificado === true, jovem });
    }
    const rel = relatores.get(r.relator_id);

    // Data no futuro (relógio errado) não pode pesar mais que um relato de hoje.
    const idadeDias = Math.max(0, (agora - r.criado_em) / MS_POR_DIA);
    const peso = rel.jovem ? 0 : base * Math.pow(0.5, idadeDias / MEIA_VIDA_DIAS) * rel.rep;

    if (r.tipo_indicador) tipos.add(r.tipo_indicador);
    if (ultimo === null || r.criado_em > ultimo) ultimo = r.criado_em;

    const chave = `${r.relator_id}\u0000${r.categoria}`;
    if (!melhor.has(chave) || peso > melhor.get(chave)) melhor.set(chave, peso);
  }

  // Soma em ordem fixa: ponto flutuante não é associativo, e a ordem dos relatos
  // de entrada não pode mudar o resultado.
  const soma = [...melhor.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .reduce((acc, [, p]) => acc + p, 0);

  let score = Math.round(100 * (1 - Math.exp(-soma / 1.5)));
  const motivos = [];
  const distintos = relatores.size;
  // Efetivo = relator que de fato pesa (conta com 7 dias ou mais e reputação
  // acima de zero). Os tetos usam ESTE número, não `distintos`: senão 1 relator
  // real mais 5 contas de ontem pareceriam "6 relatores" e escapariam do teto.
  const todos = [...relatores.values()];
  const efetivos = todos.filter((x) => !x.jovem && x.rep > 0).length;
  const qualificados = todos.filter((x) => !x.jovem && x.rep >= REPUTACAO_MINIMA_ALTO_RISCO);
  const temVerificadoQualificado = qualificados.some((x) => x.verificado);

  if (distintos === 0) {
    motivos.push("nenhum relato válido");
  } else {
    motivos.push(`${distintos} relator(es) distinto(s)`);
    const jovens = todos.filter((x) => x.jovem).length;
    if (jovens > 0) motivos.push(`${jovens} relator(es) com menos de ${IDADE_MINIMA_DIAS} dias de conta não pesam`);
  }

  // Um relator sozinho nunca marca ninguém; dois, no máximo `suspeito`.
  if (efetivos <= 1 && score > TETO_1_RELATOR) {
    score = TETO_1_RELATOR;
    motivos.push(`limitado a ${TETO_1_RELATOR}: apenas 1 relator efetivo`);
  } else if (efetivos === 2 && score > TETO_2_RELATORES) {
    score = TETO_2_RELATORES;
    motivos.push(`limitado a ${TETO_2_RELATORES}: apenas 2 relatores efetivos`);
  }

  // alto_risco: 3 relatores com reputação mínima, pelo menos 1 verificado por
  // moderador. Sem verificado, qualquer número de contas que se corroboram
  // para no `suspeito`.
  let podeAltoRisco = qualificados.length >= MIN_QUALIFICADOS_ALTO_RISCO && temVerificadoQualificado;
  // IP compartilhado (CGNAT, VPN, escritório) é sinal fraco: exige mais fontes.
  // O teto era 79, ACIMA do limiar de alto_risco (75), e portanto nunca barrava nada.
  if (tipos.has("ip") && efetivos < MIN_RELATORES_IP_ALTO_RISCO) podeAltoRisco = false;
  if (!podeAltoRisco && score > TETO_SEM_ALTO_RISCO) {
    score = TETO_SEM_ALTO_RISCO;
    motivos.push(
      `limitado a ${TETO_SEM_ALTO_RISCO}: alto risco exige ${MIN_QUALIFICADOS_ALTO_RISCO} relatores com reputação mínima de ${REPUTACAO_MINIMA_ALTO_RISCO}, ao menos 1 verificado` +
        (tipos.has("ip") ? `, e ${MIN_RELATORES_IP_ALTO_RISCO} relatores quando o indicador é IP` : ""),
    );
  }

  return {
    score,
    nivel: nivelDe(score),
    relatores_distintos: distintos,
    ultimo_relato_em: ultimo,
    motivos,
  };
}

// Reputação do relator (0..1). Relator novo começa em 0.2 de propósito e só
// passa de 0.3 depois de ser corroborado: conta recém-criada não derruba ninguém.
//
// `confirmados` = número de relatores DISTINTOS e habilitados que reportaram o
// mesmo indicador que ele (ver `reputacoesDaRede`). Não é número de relatos nem
// de categorias: contar linhas deixava duas contas se bombearem com seis
// categorias cada. `refutados` conta os relatos dele derrubados.
export function reputacaoDoRelator({ confirmados = 0, refutados = 0, idade_dias = 0 } = {}) {
  const c = Math.max(0, Number(confirmados) || 0);
  const r = Math.max(0, Number(refutados) || 0);
  const idade = Math.max(0, Number(idade_dias) || 0);
  // Refutação pesa o dobro da confirmação: relato falso custa mais que relato certo ajuda.
  const base = limitar01((0.2 + c) / (1 + c + 2 * r));
  // O bônus de antiguidade só vale depois de uma corroboração. Sem isso, 180
  // dias de conta pagariam os 0.1 que levam o relator a 0.3 sozinho, e a
  // promessa "só passa de 0.3 após corroboração" seria falsa.
  const bonus = c > 0 ? 0.1 * Math.min(1, idade / 180) : 0;
  return limitar01(base + bonus);
}

/**
 * Este relator pode corroborar outro? Só se for verificado por moderador, ou
 * se tiver reputação >= 0.3 obtida por corroboração de verificado.
 *
 * A definição não é circular de propósito: a reputação que habilita é medida
 * só com corroboradores VERIFICADOS (`corroboradoresVerificados`). Se conta
 * nova corroborasse conta nova, 3 contas falsas se promoveriam entre si; do
 * jeito que está, um grupo sem nenhum verificado por perto nunca habilita
 * ninguém, para qualquer número de contas.
 *
 * @param {object} x
 * @param {boolean} x.verificado
 * @param {boolean} x.impedido suspenso ou com a chave desativada
 * @param {number} x.corroboradoresVerificados relatores verificados distintos que o corroboram
 * @param {number} x.refutados
 * @param {number} x.idade_dias
 */
export function habilitadoACorroborar({ verificado = false, impedido = false, corroboradoresVerificados = 0, refutados = 0, idade_dias = 0 } = {}) {
  if (impedido) return false;
  if (verificado) return true;
  if (!(idade_dias >= IDADE_MINIMA_DIAS) || !(corroboradoresVerificados > 0)) return false;
  return (
    reputacaoDoRelator({ confirmados: corroboradoresVerificados, refutados, idade_dias }) >= REPUTACAO_MINIMA_CORROBORADOR
  );
}

/**
 * Reputação de cada relator a partir de dados agregados (a leitura do banco
 * fica no worker; aqui só há conta).
 *
 * @param {object} p
 * @param {Map<string, {verificado:boolean, criado_em:number, impedido:boolean, refutados:number, corroboradores_verificados:number}>} p.relatores
 * @param {Array<[string, string]>} p.pares (relator, outro relator) que reportaram o mesmo indicador, sem relato derrubado nem removido
 * @param {number} p.agora
 * @returns {Map<string, number>}
 */
export function reputacoesDaRede({ relatores, pares, agora }) {
  const idadeDe = (info) => Math.max(0, (agora - Number(info.criado_em)) / MS_POR_DIA) || 0;
  const habilitados = new Set();
  for (const [id, info] of relatores) {
    if (
      habilitadoACorroborar({
        verificado: info.verificado,
        impedido: info.impedido,
        corroboradoresVerificados: info.corroboradores_verificados,
        refutados: info.refutados,
        idade_dias: idadeDe(info),
      })
    ) {
      habilitados.add(id);
    }
  }
  // Conjunto, não lista: o mesmo corroborador em dez indicadores vale 1.
  const corroboradores = new Map();
  for (const [id, outro] of pares) {
    if (id === outro || !habilitados.has(outro)) continue;
    if (!corroboradores.has(id)) corroboradores.set(id, new Set());
    corroboradores.get(id).add(outro);
  }
  const mapa = new Map();
  for (const [id, info] of relatores) {
    mapa.set(
      id,
      reputacaoDoRelator({
        confirmados: corroboradores.get(id)?.size ?? 0,
        refutados: info.refutados,
        idade_dias: idadeDe(info),
      }),
    );
  }
  return mapa;
}
