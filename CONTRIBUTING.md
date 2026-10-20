# Como contribuir

Obrigado por ajudar. Este projeto é um bem comum; as regras abaixo existem para
que qualquer pessoa consiga revisar o que entra.

## Antes de começar

- Leia [docs/CONTRATO.md](docs/CONTRATO.md). Nomes, regras de score e rotas
  vêm de lá. Se o contrato estiver errado, o PR corrige o contrato junto.
- Para mudança grande ou de regra de score, abra primeiro uma issue com o
  modelo `proposta`.
- Vulnerabilidade não vai em issue pública: veja [SECURITY.md](SECURITY.md).

## Regras de PR

1. **Uma coisa por PR.** Um PR resolve uma issue ou uma proposta. Refatoração
   que ninguém pediu vira outro PR.
2. **Pequeno.** Mire em até ~300 linhas e ~10 arquivos. Passou disso, divida.
3. **Teste obrigatório que falha sem a mudança.** Antes de abrir o PR,
   confira que o teste novo quebra sem o seu código.
4. **O nome do teste descreve a falha**, não a função. Bom:
   `relato_procedente_nao_entra_no_score`. Ruim: `testa_pontuar`.
5. **Não afrouxe nem desligue teste** para o PR passar.
6. **Rode a suíte inteira** e cole o resultado no PR:

       node --test

7. **Nunca** coloque no repositório: segredo, token, dado pessoal real, valor
   cru de IP ou e-mail de caso verdadeiro. Use exemplos fictícios
   (`203.0.113.0/24`, `exemplo.com`).

## Mudança nas regras de score

Precisa de teste, de justificativa com números (o que muda para casos reais ou
simulados) e de **7 dias** de comentários antes do merge. Detalhes em
[docs/GOVERNANCA.md](docs/GOVERNANCA.md).

## Commits

Formato `tipo(escopo): descrição`, no imperativo e curto.

- `tipo`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
- `escopo`: área afetada, por exemplo `pontuacao`, `normalizar`, `api`, `docs`.

Exemplos:

    fix(normalizar): remover ponto da parte local só em gmail.com
    test(pontuacao): conta com menos de 7 dias pesa zero
    docs(moderacao): detalhar prazo do recurso

## Idioma

Português do Brasil, com acento, para documentação, issues, PRs e commits.
Identificadores de código seguem o arquivo vizinho. Inglês é bem-vindo quando
é o que faz a ideia chegar em quem vai ler (por exemplo, para quem está de fora
do Brasil): não deixe de contribuir por causa do idioma.

## Código de conduta

Ao participar, você concorda com o [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
