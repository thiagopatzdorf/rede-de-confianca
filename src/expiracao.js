// Expiração diária (handler `scheduled`). Existe por privacidade: dado de
// fraude de mais de 24 meses não protege ninguém e só aumenta o dano de um
// vazamento ou de um relato errado esquecido (docs/PRIVACIDADE.md).
import { DIA, LIMITES } from "./limites.js";

// 24 meses fixados em 730 dias: um número exato é testável, "24 meses de
// calendário" varia com o mês em que o cron roda.
export const RETENCAO_DIAS = 730;
// Dados pessoais de quem PEDE chave (nome, contato, URL da loja) e de relator
// com a chave desativada: 90 dias. Passado isso não servem à moderação.
export const RETENCAO_PESSOAL_DIAS = 90;
// Marca o que foi apagado sem perder a linha (relatos apontam para o relator).
export const APAGADO = "[apagado]";

// Função pura: só calcula os cortes. O relógio entra como parâmetro.
export function prazosDeExpiracao(agora) {
  const corte = agora - RETENCAO_DIAS * DIA;
  const corte_pessoal = agora - RETENCAO_PESSOAL_DIAS * DIA;
  return {
    relatos_criados_antes_de: corte,
    contestacoes_decididas_antes_de: corte,
    solicitacoes_pendentes_criadas_antes_de: corte_pessoal,
    solicitacoes_decididas_antes_de: corte_pessoal,
    relatores_desativados_antes_de: corte_pessoal,
    // Janela atual de cada prefixo de `limites`; tudo antes dela está vencido.
    janela_atual: Object.fromEntries(
      Object.entries(LIMITES).map(([prefixo, { janela_ms }]) => [prefixo, Math.floor(agora / janela_ms)]),
    ),
  };
}

const mudancas = (r) => r.meta?.changes ?? 0;

// Devolve só contagens (nunca dado removido) para o log do cron.
export async function expirar(db, agora) {
  const p = prazosDeExpiracao(agora);

  // Primeiro as linhas que apontam para relatos: a chave estrangeira recusaria
  // apagar o relato antes delas.
  const derrubados = await db
    .prepare(
      `DELETE FROM relatos_derrubados
        WHERE relato_id IN (SELECT id FROM relatos WHERE criado_em < ?)`,
    )
    .bind(p.relatos_criados_antes_de)
    .run();
  const relatos = await db
    .prepare("DELETE FROM relatos WHERE criado_em < ?")
    .bind(p.relatos_criados_antes_de)
    .run();
  // Só as DECIDIDAS: contestação em aberto ou em análise ainda tem gente esperando.
  const contestacoes = await db
    .prepare(
      `DELETE FROM contestacoes
        WHERE estado IN ('procedente', 'improcedente') AND decidido_em IS NOT NULL AND decidido_em < ?`,
    )
    .bind(p.contestacoes_decididas_antes_de)
    .run();

  // Solicitação de chave: pendente há 90 dias ninguém vai mais decidir, e
  // recusada não tem por que guardar nome, contato nem URL. Apaga a linha.
  const solicitacoesPendentes = await db
    .prepare("DELETE FROM solicitacoes_relator WHERE estado = 'pendente' AND criado_em < ?")
    .bind(p.solicitacoes_pendentes_criadas_antes_de)
    .run();
  const solicitacoesRecusadas = await db
    .prepare("DELETE FROM solicitacoes_relator WHERE estado = 'recusada' AND decidido_em IS NOT NULL AND decidido_em < ?")
    .bind(p.solicitacoes_decididas_antes_de)
    .run();
  // Aprovada: o relator criado guarda nome e contato; a cópia na solicitação
  // (inclusive a URL da loja) segue o mesmo prazo. A linha fica, sem dado pessoal.
  const solicitacoesAprovadas = await db
    .prepare(
      `UPDATE solicitacoes_relator SET nome = ?1, contato = ?1, loja_url = ?1
        WHERE estado = 'aprovada' AND decidido_em IS NOT NULL AND decidido_em < ?2 AND loja_url <> ?1`,
    )
    .bind(APAGADO, p.solicitacoes_decididas_antes_de)
    .run();

  // Relator desativado: chave revogada fora da rota (direto no banco) não tem
  // data; o relógio começa quando o cron a vê, em vez de nunca contar.
  await db
    .prepare("UPDATE relatores SET desativado_em = ? WHERE ativo = 0 AND desativado_em IS NULL")
    .bind(agora)
    .run();
  // Nome e contato somem, a linha fica: os relatos (e a reputação de quem os
  // corroborou) apontam para ela. `chave_hash` é UNIQUE, então vira um valor
  // único e que nenhum sha256 produz.
  const relatores = await db
    .prepare(
      `UPDATE relatores SET nome = ?1, contato = ?1, chave_hash = 'apagado:' || id
        WHERE ativo = 0 AND desativado_em < ?2 AND (nome <> ?1 OR contato <> ?1)`,
    )
    .bind(APAGADO, p.relatores_desativados_antes_de)
    .run();

  // consumirLimite não poda mais a própria chave (a consulta pública não
  // escreve no banco além do contador): a limpeza é só esta, uma vez por dia.
  let limites = 0;
  for (const [prefixo, janela] of Object.entries(p.janela_atual)) {
    const r = await db
      .prepare("DELETE FROM limites WHERE chave LIKE ? AND janela < ?")
      .bind(prefixo + ":%", janela)
      .run();
    limites += mudancas(r);
  }

  return {
    relatos: mudancas(relatos),
    relatos_derrubados: mudancas(derrubados),
    contestacoes: mudancas(contestacoes),
    solicitacoes: mudancas(solicitacoesPendentes) + mudancas(solicitacoesRecusadas),
    solicitacoes_anonimizadas: mudancas(solicitacoesAprovadas),
    relatores_anonimizados: mudancas(relatores),
    limites,
  };
}
