# Governança

A rede é um bem comum. A regra que decide o score de uma pessoa ou empresa
precisa ser pública, discutida e mudável por processo, não por vontade de um só.

## Papéis

- **Mantenedor.** Revisa e faz merge, cuida das versões e responde por
  segurança. Não decide sozinho mudança de regra de score (veja abaixo).
  Hoje o mantenedor inicial é indicado pela Genesis Innovation.
- **Moderador.** Decide contestações e suspende chaves de relator, conforme
  [MODERACAO.md](MODERACAO.md). Tem acesso ao token administrativo da instância
  que modera.
- **Relator.** Lojista ou pessoa com chave que reporta fraude. Não vê relatos
  de outros.
- **Contribuidor.** Qualquer pessoa que abre issue, PR ou comentário.
- **Consultante.** Qualquer pessoa que consulta o score.

Uma pessoa pode ter mais de um papel, mas não decide caso em que é parte.

## Mudança de regra de score

Regra de score (pesos, meia-vida, tetos, reputação, níveis) afeta pessoas
reais. Por isso:

1. **PR com teste**: a mudança vem com teste que falha sem ela e, quando
   possível, com simulação de números antes e depois.
2. **Período de comentários de 7 dias corridos**, contado da abertura do PR
   com a etiqueta `regra-de-score`. Mudou o PR de forma relevante, o prazo
   reinicia.
3. **Revisão**: aprovação de pelo menos dois mantenedores ou moderadores
   independentes (não da mesma organização).
4. **Contrato atualizado no mesmo PR** (`docs/CONTRATO.md`).
5. **Registro**: a mudança entra no histórico de decisões do projeto, com o
   motivo, e vira nota de versão.

Correção de bug que só aproxima o código do contrato não precisa do
período de 7 dias, mas continua precisando de teste e de revisão.

## Transparência

- Código, regras e testes são abertos.
- Publicamos, ao menos a cada trimestre, **decisões de moderação agregadas**:
  contestações abertas, procedentes, improcedentes, tempo médio, chaves
  suspensas, por categoria. Nunca identificamos relator, contestante nem
  indicador.
- Decisões de governança e mudanças de regra ficam em issues e PRs públicos.

## Como entra um moderador novo

1. A pessoa se candidata ou é indicada, em issue com o modelo `proposta`.
2. Precisa de histórico no projeto (contribuições, revisões ou atuação como
   relator com boa reputação) e declarar conflitos de interesse.
3. Os moderadores atuais votam; é preciso maioria e nenhum veto fundamentado.
4. Começa em período de 30 dias acompanhando decisões, com segunda revisão.
5. Assina o [código de conduta](../CODE_OF_CONDUCT.md) e o compromisso de
   sigilo sobre dado de relatores e contestantes.

Moderador pode sair quando quiser e pode ser removido por violação do código de
conduta ou inatividade de 6 meses.

## O que fica com a Genesis Innovation

- **Hospedar a instância de referência** e arcar com o custo dela.
- Indicar o mantenedor inicial e cuidar da continuidade operacional e de
  segurança dessa instância.
- Representar a instância de referência perante terceiros e autoridades.

## O que é da comunidade

- O código, as regras de score e a documentação.
- As decisões de mudança de regra, que seguem o rito acima.
- A moderação, com o poder dos moderadores limitado pelos critérios públicos.
- O direito de fazer fork e de rodar a própria instância.

A Genesis não tem voto de qualidade sobre regra de score: tem o mesmo peso de
qualquer participante, além da responsabilidade pela instância que hospeda.

## Rodar a própria instância

Qualquer pessoa ou empresa pode rodar uma instância própria (veja o README).
O operador responde por ela, inclusive pela LGPD. Instância própria define
a sua moderação, mas recomendamos manter os critérios e o prazo de contestação
deste repositório como padrão mínimo.

## Mudar esta governança

Mudança neste documento segue o mesmo rito de regra de score: PR, 7 dias de
comentários e revisão independente.
