import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pontuar,
  reputacaoDoRelator,
  habilitadoACorroborar,
  reputacoesDaRede,
  REPUTACAO_MINIMA_CORROBORADOR,
  IDADE_MINIMA_DIAS,
} from "../src/pontuacao.js";

const DIA = 86_400_000;
const AGORA = Date.UTC(2026, 9, 20);

let seq = 0;
function relato(sobre = {}) {
  seq += 1;
  return {
    id: `r${seq}`,
    tipo_indicador: "dominio",
    indicador_hash: "h".repeat(64),
    categoria: "chargeback",
    relator_id: "A",
    criado_em: AGORA,
    contestacao: null,
    ...sobre,
  };
}
const rep1 = () => 1;
// Relator padrão dos testes: antigo (400 dias) e, só o "R0", verificado. O
// alto_risco exige um verificado entre os qualificados (regra 6).
const veterano = (id) => ({ verificado: id === "R0", criado_em: AGORA - 400 * DIA });
const score = (relatos, reputacaoDe = rep1, relatorDe = veterano) => pontuar({ relatos, agora: AGORA, reputacaoDe, relatorDe });
// n relatores distintos (R0..Rn-1), todos com chargeback de hoje
const relatores = (n, sobre = {}) =>
  Array.from({ length: n }, (_, i) => relato({ relator_id: `R${i}`, ...sobre }));

// ---------- base ----------

test("sem relatos o indicador é desconhecido, score 0 e sem data de último relato", () => {
  const r = score([]);
  assert.equal(r.score, 0);
  assert.equal(r.nivel, "desconhecido");
  assert.equal(r.relatores_distintos, 0);
  assert.equal(r.ultimo_relato_em, null);
  assert.ok(Array.isArray(r.motivos));
});

test("um chargeback de hoje com reputação máxima para em 24: 1 relator sozinho nunca chega a suspeito", () => {
  // a curva daria 49 (soma 1.0); o teto de 1 relator é 24
  const r = score([relato()]);
  assert.equal(r.score, 24);
  assert.equal(r.nivel, "desconhecido");
});

// ---------- regra 1: meia-vida ----------

// A curva é medida com 3 relatores (sem o teto de 1 ou 2), cada um com o mesmo relato.
const curva3 = (soma) => Math.round(100 * (1 - Math.exp(-soma / 1.5)));

test("relato de 90 dias pesa metade: relato velho não vale o mesmo que o de hoje", () => {
  const velho = score(relatores(3, { criado_em: AGORA - 90 * DIA })).score;
  assert.equal(velho, curva3(1.5));
  assert.ok(velho < score(relatores(3)).score);
});

test("relato de 180 dias pesa um quarto: o peso continua caindo, não congela na meia-vida", () => {
  assert.equal(
    score([relato({ criado_em: AGORA - 180 * DIA })]).score,
    Math.round(100 * (1 - Math.exp(-0.25 / 1.5))),
  );
});

test("relato com data no futuro não pesa mais que um de hoje (relógio errado do relator)", () => {
  assert.equal(score([relato({ criado_em: AGORA + 400 * DIA })]).score, score([relato()]).score);
});

// ---------- regra 2: reputação ----------

test("reputação multiplica o peso: relator de reputação 0.5 vale metade", () => {
  assert.equal(score(relatores(3), () => 0.5).score, curva3(1.5));
});

test("relator com reputação 0 não move o score", () => {
  assert.equal(score([relato()], () => 0).score, 0);
});

test("reputação fora de 0..1, NaN ou exceção não vira peso inflado", () => {
  assert.equal(score(relatores(3), () => 50).score, score(relatores(3)).score);
  assert.equal(score([relato()], () => -3).score, 0);
  assert.equal(score([relato()], () => NaN).score, 0);
  assert.equal(
    score([relato()], () => {
      throw new Error("banco fora do ar");
    }).score,
    0,
  );
});

// ---------- regra 3: uma vez por relator e categoria ----------

test("um relator repetindo o mesmo relato não infla o score", () => {
  const um = score([relato()]).score;
  const cem = score(Array.from({ length: 100 }, () => relato())).score;
  assert.equal(cem, um);
});

test("relator repetindo a categoria conta pelo relato de maior peso, não pelo mais recente nem pela soma", () => {
  const novo = score([relato()]).score;
  const misto = score([relato({ criado_em: AGORA - 200 * DIA }), relato(), relato({ criado_em: AGORA - 30 * DIA })]).score;
  assert.equal(misto, novo);
});

test("o mesmo relator em categorias diferentes soma, mas continua sendo 1 relator distinto", () => {
  const r = score([relato({ categoria: "chargeback" }), relato({ categoria: "phishing" })]);
  assert.equal(r.relatores_distintos, 1);
  assert.ok(r.score > 0);
});

// ---------- regra 4: contestação ----------

test("relato com contestação procedente é ignorado por completo, inclusive na contagem de relatores", () => {
  const r = score(relatores(5, { contestacao: "procedente" }));
  assert.equal(r.score, 0);
  assert.equal(r.relatores_distintos, 0);
  assert.equal(r.ultimo_relato_em, null);
});

test("contestação aberta sem triagem não altera o score (senão qualquer um enfraquece relato verdadeiro)", () => {
  assert.equal(score([relato({ contestacao: "aberta" })]).score, score([relato()]).score);
});

test("contestação em_analise (prova de controle) NÃO tira peso: o fraudador controla o próprio e-mail", () => {
  // Antes cortava pela metade; mas a prova mede identidade, não inocência.
  assert.equal(score(relatores(3, { contestacao: "em_analise" })).score, score(relatores(3)).score);
});

test("contestação improcedente não tira peso do relato", () => {
  assert.equal(score([relato({ contestacao: "improcedente" })]).score, score([relato()]).score);
});

// ---------- regra 5: soma saturante ----------

test("a soma satura: muitos relatores nunca passam de 100 e o score é inteiro", () => {
  const r = score(relatores(200));
  assert.ok(Number.isInteger(r.score));
  assert.ok(r.score <= 100 && r.score >= 99);
});

test("score cresce com mais evidência, mas com ganho decrescente", () => {
  const s3 = score(relatores(3)).score;
  const s4 = score(relatores(4)).score;
  const s5 = score(relatores(5)).score;
  assert.ok(s3 < s4 && s4 < s5);
  assert.ok(s4 - s3 > s5 - s4);
});

// ---------- regra 6: teto por evidência ----------

test("1 relator nunca passa de 24 (abaixo de suspeito), mesmo acumulando todas as categorias", () => {
  const todas = ["chargeback", "cartao_testado", "conta_falsa", "phishing", "bot_abuso", "outro"];
  const r = score(todas.map((categoria) => relato({ categoria })));
  assert.equal(r.relatores_distintos, 1);
  assert.equal(r.score, 24);
  assert.equal(r.nivel, "desconhecido");
});

test("2 relatores nunca passam de 49 (suspeito), por mais pesados que sejam", () => {
  const cats = ["chargeback", "cartao_testado", "conta_falsa", "phishing", "bot_abuso", "outro"];
  const rel = relatores(2).flatMap((x) => cats.map((categoria) => ({ ...x, id: `${x.id}${categoria}`, categoria })));
  const r = score(rel);
  assert.equal(r.relatores_distintos, 2);
  assert.equal(r.score, 49);
  assert.equal(r.nivel, "suspeito");
});

test("3 relatores com reputação 1 e chargeback chegam a alto_risco", () => {
  const r = score(relatores(3));
  assert.equal(r.score, 86);
  assert.equal(r.nivel, "alto_risco");
});

test("alto_risco exige 3 relatores com reputação >= 0.3: um relator de 0.29 trava o nível em suspeito", () => {
  const rel = relatores(3);
  const r = score(rel, (id) => (id === "R2" ? 0.29 : 1));
  assert.equal(r.relatores_distintos, 3);
  assert.ok(r.score <= 74);
  assert.equal(r.nivel, "suspeito");
});

test("reputação exatamente 0.3 qualifica para alto_risco, e 0.29 no mesmo cenário não", () => {
  // 3 relatores, cada um com as 6 categorias: soma alta o bastante para passar de 75 só pela evidência
  const cats = ["chargeback", "cartao_testado", "conta_falsa", "phishing", "bot_abuso", "outro"];
  const rel = relatores(3).flatMap((x) => cats.map((categoria) => ({ ...x, id: `${x.id}${categoria}`, categoria })));
  const limite = score(rel, () => 0.3);
  assert.equal(limite.nivel, "alto_risco");
  const abaixo = score(rel, () => 0.29);
  assert.notEqual(abaixo.nivel, "alto_risco");
  assert.equal(abaixo.score, 74);
});

test("muitos relatores sem reputação não fabricam alto_risco: o que conta são os 3 qualificados", () => {
  // 3 qualificados de reputação ínfima ficam abaixo de 0.3; só 2 são qualificados
  const rel = relatores(10);
  const r = score(rel, (id) => (id === "R0" || id === "R1" ? 1 : 0.29));
  assert.notEqual(r.nivel, "alto_risco");
  assert.ok(r.score <= 74);
});

// ---------- regra 7: teto de IP ----------

test("IP com menos de 5 relatores distintos nunca chega a alto_risco (teto 74, abaixo do limiar de 75)", () => {
  // O teto era 79, ACIMA do limiar de alto_risco, e portanto nunca barrava nada.
  const r = score(relatores(4, { tipo_indicador: "ip" }));
  assert.equal(r.relatores_distintos, 4);
  assert.equal(r.score, 74);
  assert.equal(r.nivel, "suspeito");
});

test("o mesmo cenário em domínio não sofre o teto de IP", () => {
  assert.equal(score(relatores(4, { tipo_indicador: "dominio" })).nivel, "alto_risco");
});

test("IP com 5 relatores distintos deixa de ter o teto de IP e pode ser alto_risco", () => {
  assert.equal(score(relatores(5, { tipo_indicador: "ip" })).nivel, "alto_risco");
});

// ---------- regra 8: níveis ----------

test("níveis: abaixo de 25 desconhecido, de 25 a 74 suspeito, 75 ou mais alto_risco", () => {
  const baixo = score([relato()], () => 0.2); // 1 relator: soma 0.2 -> 12
  const meio = score(relatores(2), () => 0.5); // 2 relatores: soma 1.0 -> 49
  assert.equal(baixo.nivel, "desconhecido");
  assert.ok(baixo.score < 25);
  assert.equal(meio.nivel, "suspeito");
  assert.ok(meio.score >= 25 && meio.score < 75);
  assert.equal(score(relatores(3)).nivel, "alto_risco");
});

test("fronteira de 25: o score 25 já é suspeito e o 24 ainda é desconhecido", () => {
  // soma s -> round(100*(1-exp(-s/1.5))): 25 em s~0.4315, 24 abaixo disso
  // 3 relatores: com 1 ou 2 os tetos de evidência cortam antes do 25.
  const em = (rep) => score(relatores(3), () => rep);
  const achaRep = (alvo) => {
    for (let i = 0; i <= 1000; i++) if (em(i / 1000).score === alvo) return i / 1000;
    throw new Error("score alvo inalcançável");
  };
  assert.equal(em(achaRep(25)).nivel, "suspeito");
  assert.equal(em(achaRep(24)).nivel, "desconhecido");
});

// ---------- campos de saída ----------

test("ultimo_relato_em é o relato válido mais recente e ignora os procedentes", () => {
  const r = score([
    relato({ relator_id: "A", criado_em: AGORA - 10 * DIA }),
    relato({ relator_id: "B", criado_em: AGORA - 3 * DIA }),
    relato({ relator_id: "C", criado_em: AGORA - 1 * DIA, contestacao: "procedente" }),
  ]);
  assert.equal(r.ultimo_relato_em, AGORA - 3 * DIA);
});

test("categoria desconhecida não ganha peso inventado nem conta relator", () => {
  const r = score([relato({ categoria: "categoria_nova" })]);
  assert.equal(r.score, 0);
  assert.equal(r.relatores_distintos, 0);
});

test("a saída traz motivos legíveis quando um teto é aplicado", () => {
  const r = score([relato()]);
  assert.ok(r.motivos.length >= 1);
  assert.ok(r.motivos.every((m) => typeof m === "string" && m.length > 0));
});

// ---------- regra 9: pureza e determinismo ----------

test("mesma entrada, mesma saída, mesmo com a ordem dos relatos embaralhada", () => {
  const rel = [
    relato({ relator_id: "A", categoria: "chargeback", criado_em: AGORA - 5 * DIA }),
    relato({ relator_id: "B", categoria: "phishing", criado_em: AGORA - 40 * DIA }),
    relato({ relator_id: "C", categoria: "outro", criado_em: AGORA - 70 * DIA }),
    relato({ relator_id: "D", categoria: "bot_abuso", criado_em: AGORA - 120 * DIA, contestacao: "em_analise" }),
    relato({ relator_id: "A", categoria: "conta_falsa", criado_em: AGORA - 1 * DIA }),
  ];
  const rep = (id) => ({ A: 0.9, B: 0.45, C: 0.7, D: 0.31 })[id];
  const esperado = score(rel, rep);
  for (const ordem of [[...rel].reverse(), [rel[2], rel[4], rel[0], rel[3], rel[1]]]) {
    assert.deepEqual(score(ordem, rep), esperado);
  }
  assert.deepEqual(score(rel, rep), esperado);
});

test("pontuar não muda os relatos recebidos", () => {
  const rel = relatores(3);
  const copia = structuredClone(rel);
  score(rel);
  assert.deepEqual(rel, copia);
});

test("o resultado depende de 'agora' recebido, não do relógio da máquina", () => {
  const rel = [relato({ criado_em: AGORA })];
  const trio = relatores(3);
  const hoje = pontuar({ relatos: trio, agora: AGORA, reputacaoDe: rep1, relatorDe: veterano }).score;
  const depois = pontuar({ relatos: trio, agora: AGORA + 90 * DIA, reputacaoDe: rep1, relatorDe: veterano }).score;
  assert.ok(depois < hoje);
  assert.equal(pontuar({ relatos: trio, agora: AGORA, reputacaoDe: rep1, relatorDe: veterano }).score, hoje);
  void rel;
});

// ---------- reputacaoDoRelator ----------

test("relator novo começa com reputação 0.2, abaixo do mínimo para alto_risco", () => {
  const r = reputacaoDoRelator({ confirmados: 0, refutados: 0, idade_dias: 0 });
  assert.equal(r, 0.2);
  assert.ok(r < 0.3);
});

test("cada relato corroborado por outro relator sobe a reputação, e um já basta para passar de 0.3", () => {
  const r0 = reputacaoDoRelator({ confirmados: 0, refutados: 0, idade_dias: 0 });
  const r1 = reputacaoDoRelator({ confirmados: 1, refutados: 0, idade_dias: 0 });
  const r5 = reputacaoDoRelator({ confirmados: 5, refutados: 0, idade_dias: 0 });
  assert.ok(r0 < r1 && r1 < r5);
  assert.ok(r1 >= 0.3);
});

test("contestação procedente derruba a reputação mais do que uma confirmação sobe", () => {
  const sem = reputacaoDoRelator({ confirmados: 3, refutados: 0, idade_dias: 0 });
  const com = reputacaoDoRelator({ confirmados: 3, refutados: 1, idade_dias: 0 });
  assert.ok(com < sem);
  assert.equal(com, (0.2 + 3) / (1 + 3 + 2));
});

test("bônus de antiguidade (relator já corroborado) é linear em 180 dias e para em +0.1", () => {
  const rep = (idade_dias) => reputacaoDoRelator({ confirmados: 1, refutados: 0, idade_dias });
  const base = rep(0);
  assert.ok(Math.abs(rep(90) - base - 0.05) < 1e-12);
  assert.ok(Math.abs(rep(180) - base - 0.1) < 1e-12);
  assert.equal(rep(5000), rep(180));
});

test("a reputação nunca sai do intervalo 0..1, nem com entradas absurdas", () => {
  assert.equal(reputacaoDoRelator({ confirmados: 1e9, refutados: 0, idade_dias: 1e9 }), 1);
  const baixa = reputacaoDoRelator({ confirmados: 0, refutados: 1e9, idade_dias: 0 });
  assert.ok(baixa >= 0 && baixa < 0.001);
  for (const v of [-5, NaN, undefined, Infinity]) {
    const r = reputacaoDoRelator({ confirmados: v, refutados: v, idade_dias: v });
    assert.ok(r >= 0 && r <= 1 && Number.isFinite(r));
  }
});

test("reputação é determinística: mesma entrada, mesmo número", () => {
  const e = { confirmados: 4, refutados: 1, idade_dias: 77 };
  assert.equal(reputacaoDoRelator(e), reputacaoDoRelator({ ...e }));
});

// ---------- v1.1: corroboração ----------

test("relator sem corroboração nunca chega a 0.3 nem com anos de conta (bônus de antiguidade exige corroboração)", () => {
  const velho = reputacaoDoRelator({ confirmados: 0, refutados: 0, idade_dias: 5000 });
  assert.equal(velho, 0.2);
  assert.ok(velho < 0.3);
});

test("uma corroboração já leva o relator acima de 0.3", () => {
  assert.ok(reputacaoDoRelator({ confirmados: 1, refutados: 0, idade_dias: 0 }) > 0.3);
});

test("só relator verificado, ou corroborado por verificado com reputação >= 0.3, pode corroborar", () => {
  assert.equal(REPUTACAO_MINIMA_CORROBORADOR, 0.3);
  const maduro = { idade_dias: 30 };
  // conta nova, sem verificado por perto: não corrobora ninguém
  assert.equal(habilitadoACorroborar({ ...maduro }), false);
  assert.equal(habilitadoACorroborar({ verificado: true, idade_dias: 0 }), true);
  assert.equal(habilitadoACorroborar({ verificado: true, impedido: true }), false);
  assert.equal(habilitadoACorroborar({ ...maduro, corroboradoresVerificados: 1 }), true);
  // corroborado por verificado, mas com menos de 7 dias: ainda não
  assert.equal(habilitadoACorroborar({ corroboradoresVerificados: 1, idade_dias: IDADE_MINIMA_DIAS - 1 }), false);
  assert.equal(habilitadoACorroborar({ corroboradoresVerificados: 1, idade_dias: IDADE_MINIMA_DIAS }), true);
  // refutado duas vezes: a reputação (0.2 + bônus) cai abaixo de 0.3
  assert.equal(habilitadoACorroborar({ ...maduro, corroboradoresVerificados: 1, refutados: 2 }), false);
  assert.equal(habilitadoACorroborar({ ...maduro, impedido: true, corroboradoresVerificados: 1 }), false);
});

test("a fórmula da reputação não multiplica por constante: refutados pesa exatamente o dobro", () => {
  assert.equal(reputacaoDoRelator({ confirmados: 2, refutados: 1, idade_dias: 0 }), (0.2 + 2) / (1 + 2 + 2));
});

// ---------- v1.2: sybil, conta nova e verificado ----------

const comIdade = (dias, verificado = (id) => id === "R0") => (id) => ({ verificado: verificado(id), criado_em: AGORA - dias * DIA });

test("conta com menos de 7 dias pesa 0 no score: 3 contas de ontem não movem nada", () => {
  const r = score(relatores(3), rep1, comIdade(6.9));
  assert.equal(r.score, 0);
  assert.equal(r.nivel, "desconhecido");
  assert.equal(r.relatores_distintos, 3, "continuam contando como relatores, só não pesam");
});

test("conta com exatamente 7 dias já pesa", () => {
  assert.ok(score(relatores(3), rep1, comIdade(IDADE_MINIMA_DIAS)).score > 0);
});

test("criado_em ausente ou ilegível trata o relator como conta nova (peso 0), não como veterano", () => {
  assert.equal(score(relatores(3), rep1, () => ({ verificado: true })).score, 0);
  assert.equal(score(relatores(3), rep1, () => { throw new Error("banco"); }).score, 0);
});

test("contas novas não furam o teto de 1 relator: 1 veterano + 5 contas de ontem é 1 relator efetivo", () => {
  const veterano1 = relato({ relator_id: "R0" });
  const jovens = Array.from({ length: 5 }, (_, i) => relato({ relator_id: `N${i}` }));
  const idade = (id) => ({ verificado: id === "R0", criado_em: id === "R0" ? AGORA - 400 * DIA : AGORA - 1 * DIA });
  const r = score([veterano1, ...jovens, ...jovens.map((j) => ({ ...j, categoria: "phishing" }))], rep1, idade);
  assert.equal(r.relatores_distintos, 6);
  assert.ok(r.score <= 24, `score ${r.score}`);
});

test("alto_risco exige 1 verificado entre os 3 qualificados: 3 relatores antigos de reputação alta, nenhum verificado, ficam em 74", () => {
  const cats = ["chargeback", "cartao_testado", "phishing"];
  const rel = relatores(3).flatMap((x) => cats.map((categoria) => ({ ...x, id: `${x.id}${categoria}`, categoria })));
  const semVerificado = score(rel, rep1, comIdade(400, () => false));
  assert.equal(semVerificado.score, 74);
  assert.equal(semVerificado.nivel, "suspeito");
  assert.equal(score(rel, rep1, comIdade(400)).nivel, "alto_risco");
});

test("o verificado precisa ser um dos 3 qualificados: verificado com reputação 0.2 não conta", () => {
  const cats = ["chargeback", "cartao_testado", "phishing"];
  const rel = relatores(4).flatMap((x) => cats.map((categoria) => ({ ...x, id: `${x.id}${categoria}`, categoria })));
  // R0 verificado mas sem reputação; R1..R3 qualificados e não verificados
  const r = score(rel, (id) => (id === "R0" ? 0.2 : 1), comIdade(400));
  assert.equal(r.score, 74);
});

// Rede de N contas falsas que se corroboram entre si, todas com 30 dias de conta
// (esperaram os 7 dias) e nenhuma verificada: o ataque de a_sybil.mjs.
function enxame(n, { idade = 30 } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `S${i}`);
  const relatores = new Map(ids.map((id) => [id, { verificado: false, criado_em: AGORA - idade * DIA, impedido: false, refutados: 0, corroboradores_verificados: 0 }]));
  const pares = ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => [a, b]));
  const reps = reputacoesDaRede({ relatores, pares, agora: AGORA });
  const cats = ["chargeback", "cartao_testado", "phishing", "conta_falsa", "bot_abuso", "outro"];
  const rel = ids.flatMap((id) => cats.map((categoria) => relato({ relator_id: id, categoria })));
  return pontuar({ relatos: rel, agora: AGORA, reputacaoDe: (id) => reps.get(id), relatorDe: (id) => ({ verificado: false, criado_em: relatores.get(id).criado_em }) });
}

test("N contas falsas sem nenhum verificado nunca passam de suspeito, para qualquer N", () => {
  for (const n of [1, 2, 3, 4, 5, 10, 25, 100]) {
    const r = enxame(n);
    assert.notEqual(r.nivel, "alto_risco", `N=${n}: score ${r.score}`);
    assert.ok(r.score <= 74, `N=${n}: score ${r.score}`);
  }
  // 1 conta sozinha nem chega a suspeito; 2 ficam em suspeito no máximo
  assert.ok(enxame(1).score <= 24);
  assert.ok(enxame(2).score <= 49);
});

test("o mesmo enxame de contas de ontem pesa 0 para qualquer N", () => {
  for (const n of [3, 10, 100]) assert.equal(enxame(n, { idade: 1 }).score, 0, `N=${n}`);
});

test("sem verificado ninguém é habilitado a corroborar: reputação de todas as contas do enxame segue em 0.2", () => {
  const ids = ["A", "B", "C"];
  const relatores = new Map(ids.map((id) => [id, { verificado: false, criado_em: AGORA - 400 * DIA, impedido: false, refutados: 0, corroboradores_verificados: 0 }]));
  const pares = ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => [a, b]));
  const reps = reputacoesDaRede({ relatores, pares, agora: AGORA });
  for (const id of ids) assert.equal(reps.get(id), 0.2);
});

test("confirmados conta relatores distintos, não linhas: o mesmo corroborador em 50 indicadores vale 1", () => {
  const info = (extra = {}) => ({ verificado: false, criado_em: AGORA - 400 * DIA, impedido: false, refutados: 0, corroboradores_verificados: 0, ...extra });
  const relatores = new Map([["A", info()], ["V", info({ verificado: true })], ["W", info({ verificado: true })]]);
  const muitas = Array.from({ length: 50 }, () => ["A", "V"]);
  const umCorroborador = reputacoesDaRede({ relatores, pares: muitas, agora: AGORA }).get("A");
  assert.equal(umCorroborador, reputacaoDoRelator({ confirmados: 1, idade_dias: 400 }));
  const doisCorroboradores = reputacoesDaRede({ relatores, pares: [...muitas, ["A", "W"]], agora: AGORA }).get("A");
  assert.equal(doisCorroboradores, reputacaoDoRelator({ confirmados: 2, idade_dias: 400 }));
});

test("corroborador suspenso ou desativado não promove ninguém, nem sendo verificado", () => {
  const base = { criado_em: AGORA - 400 * DIA, refutados: 0, corroboradores_verificados: 0 };
  const relatores = new Map([
    ["A", { ...base, verificado: false, impedido: false }],
    ["V", { ...base, verificado: true, impedido: true }],
  ]);
  assert.equal(reputacoesDaRede({ relatores, pares: [["A", "V"]], agora: AGORA }).get("A"), 0.2);
});

test("conta corroborada por um verificado vira corroboradora: a promoção tem um passo só, vindo de verificado", () => {
  const base = { criado_em: AGORA - 400 * DIA, refutados: 0, impedido: false };
  const relatores = new Map([
    ["V", { ...base, verificado: true, corroboradores_verificados: 0 }],
    ["B", { ...base, verificado: false, corroboradores_verificados: 1 }], // corroborada por V
    ["C", { ...base, verificado: false, corroboradores_verificados: 0 }], // só conhece B
  ]);
  const reps = reputacoesDaRede({ relatores, pares: [["B", "V"], ["V", "B"], ["C", "B"], ["B", "C"]], agora: AGORA });
  assert.ok(reps.get("B") >= 0.3);
  assert.ok(reps.get("C") >= 0.3, "C é corroborada por B, que foi habilitada por V");
  // mas C não habilita ninguém: não foi corroborada por verificado
  const reps2 = reputacoesDaRede({ relatores: new Map([...relatores, ["D", { ...base, verificado: false, corroboradores_verificados: 0 }]]), pares: [["D", "C"]], agora: AGORA });
  assert.equal(reps2.get("D"), 0.2);
});
