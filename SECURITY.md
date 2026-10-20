# Segurança

## Como reportar uma vulnerabilidade

Reporte **em privado**. Não abra issue pública nem PR com a falha.

- Use o recurso "Report a vulnerability" (aviso de segurança privado) da aba
  Security do repositório no GitHub; ou
- chame o mantenedor no WhatsApp (https://wa.me/5521995988404?text=Quero%20reportar%20uma%20vulnerabilidade%20da%20Rede%20de%20Confian%C3%A7a)
  e diga só que é "assunto de segurança": os detalhes seguem por um canal
  privado combinado ali, nunca no chat público nem numa issue.

Inclua: o que é, como reproduzir, o impacto que você enxerga e, se tiver, uma
sugestão de correção. Não inclua dado pessoal real nem segredo de terceiros.

## Prazos

| etapa | prazo |
|---|---|
| confirmação de recebimento | até 3 dias |
| avaliação inicial e severidade | até 7 dias |
| correção de falha grave | meta de 30 dias |

Se não pudermos cumprir, avisamos o motivo. Combinamos a divulgação pública
com você depois da correção, e damos o crédito se quiser.

## Escopo

Dentro do escopo:

- o código deste repositório (`src/`, `schema/`);
- a instância de referência operada pela Genesis Innovation;
- vazamento de dado (relatos, evidência, identidade de relator ou de
  contestante), burla de limite, burla de autenticação, injeção, manipulação do
  score fora das regras, enumeração em massa de indicadores.

Fora do escopo:

- instâncias de terceiros (avise o operador dela);
- negação de serviço por volume, engenharia social contra pessoas, ataque
  físico;
- relatório automático de scanner sem demonstração de impacto;
- a limitação já documentada: hash de IP e de e-mail comum é pseudonimização,
  não anonimato (veja [docs/PRIVACIDADE.md](docs/PRIVACIDADE.md)).

## Segredos de implantação

O Worker precisa de dois segredos de 32 ou mais caracteres: `ADMIN_TOKEN`
(moderação; com menos que isso a moderação fica fechada) e `PEPPER` (HMAC dos
hashes e das chaves de limite; sem ele o Worker responde `500 configuracao` em
tudo). O `PEPPER` nunca vai ao Git nem ao log. Trocá-lo invalida os hashes já
gravados, então guarde-o num cofre com cópia. Depois de 10 tentativas falhas de
moderação vindas do mesmo balde de rede (IPv4 `/24`, IPv6 `/64`), a moderação
responde `429` a esse balde por até uma hora.

## Boa-fé

Não acesse dado que não é seu além do necessário para demonstrar a falha, não
degrade o serviço e não divulgue antes da correção. Quem age assim não será
perseguido por causa do relatório.

## Se você achar um segredo no repositório

Trate como vulnerabilidade: avise em privado para que a chave seja trocada.
