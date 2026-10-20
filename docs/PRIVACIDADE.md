# Privacidade e LGPD

Este documento descreve, sem enfeite, o que a rede faz com dados e o que ela
não consegue prometer. Não é parecer jurídico.

## O que guardamos

- **Indicador: só o hash, e com segredo.** O cliente calcula
  `sha256("rdc:v1:" + tipo + ":" + normalizado)`; o servidor grava
  `HMAC-SHA256(PEPPER, esse hash)`, com um segredo que não está no banco. O
  valor cru de IP, e-mail, domínio ou dispositivo nunca é gravado nem aparece
  em log.
- **Relato:** tipo do indicador, hash, categoria, identificador do relator, data
  e, opcionalmente, uma evidência de texto de até 280 caracteres.
- **Relator:** nome, contato e o hash da chave de acesso.
- **Contestação:** tipo, hash, motivo, contato opcional, estado e nota da decisão.
- **Limites de uso:** contadores por balde de rede (IPv4 `/24`, IPv6 `/64`) e
  janela, para impedir abuso. A chave é um HMAC com o mesmo segredo, não o IP
  nem um sha256 dele.

A **evidência nunca é pública**: nenhuma rota pública a devolve, e quem relata
é orientado a não colocar dado pessoal nela. Só moderadores a leem, para decidir
contestações. Além do aviso, a entrada **recusa** (`400 dado_pessoal`) evidência,
motivo de contestação e URL de loja que contenham sequência parecida com CPF
(com ou sem pontuação, dígito verificador conferido) ou com número de cartão
(Luhn). A varredura não pega nome, telefone nem endereço: para esses a defesa
continua sendo o aviso e a remoção pelo moderador.

O valor consultado ou contestado **nunca vai na URL**. Quem não quer enviá-lo
calcula o hash no cliente (`hashIndicador`, exemplo no README) e manda só
`{tipo, hash}`; quem envia `{tipo, valor}` no corpo de um POST faz o servidor
hashear e descartar o valor, sem registro em log. O endereço IP de quem consulta
nunca é guardado: só um HMAC do balde de rede dele (`/24` ou `/64`), nos
contadores de limite, podados todo dia.

Relatos com mais de 24 meses e contestações decididas há mais de 24 meses são
apagados automaticamente (cron diário), assim como os dados pessoais de quem
pediu chave ou teve a chave desativada (ver Retenção). Um moderador também pode remover um
relato antes disso (a pedido do titular, por abuso ou por expiração): a
evidência é apagada e o relato deixa de contar.

## O que nunca guardamos

- **CPF**, número de cartão ou qualquer dado de pagamento, em nenhuma hipótese.
  A entrada recusa o que parece um (ver acima); se escapar na evidência, o
  moderador apaga o campo.
- Conteúdo de mensagens, nome de comprador, endereço, telefone.
- Dispositivo: a rede nunca vê o dispositivo, só a impressão digital calculada
  pelo cliente.

## O limite do hash

Hash é **pseudonimização, não anonimato**. O espaço de IPv4 e de e-mails comuns
é pequeno o bastante para quem tem o hash tentar adivinhar o valor por força
bruta. O `PEPPER` encarece muito isso para quem só tem o banco (um vazamento do
D1, um backup), mas não para quem também tem o segredo, nem para quem
consulta a API: a consulta é, por desenho, um oráculo de "este valor foi
reportado?", e o que a limita é o limite por balde de rede. Por isso:

- o dado hasheado continua sendo tratado como dado pessoal;
- **não existe exportação em massa** de hashes nem de relatos, em nenhuma rota;
- a consulta pública devolve só score, nível, contagem de relatores distintos e
  data do último relato, nunca relatos nem relatores;
- a consulta tem limite por balde de rede (300 por minuto), contado em
  `/24` (IPv4) e `/64` (IPv6): trocar de endereço dentro do bloco não escapa
  dele.

Não prometemos que uma pessoa com acesso ao banco jamais consiga reidentificar
um indicador. Prometemos reduzir essa chance e não dar a ninguém um jeito
fácil de fazê-lo.

## Base legal provável

> **A validar com advogado.** O que segue é a hipótese de trabalho, não
> afirmação.

A base provável é o **legítimo interesse** na **prevenção à fraude** e à
segurança do titular e do comércio (LGPD, art. 7º, IX, e art. 10), com
tratamento limitado ao necessário, transparência e possibilidade de oposição.
Estão pendentes de validação jurídica: o teste de balanceamento (relatório de
impacto), a definição de quem é controlador numa rede com várias instâncias e
o enquadramento de lojistas que relatam. Até a validação, evitamos qualquer
dado além do descrito acima.

## Retenção

- O relato perde peso com **meia-vida de 90 dias** (regra de score) e **é
  apagado depois de 24 meses**, mesmo que ainda tenha algum peso.
- Contestação decidida guarda o mínimo (estado, data, nota) pelo mesmo prazo de
  24 meses. Apagar o `contato` e o `motivo` antes disso, a pedido, ainda é
  feito à mão por um moderador direto no banco: **não existe rota para isso
  ainda** (issue aberta para implementar; até lá o prazo de resposta de 15 dias
  da moderação vale).
- Evidência segue o prazo do relato.
- **Pedido de chave de relator** (nome, contato, URL da loja): se ninguém decidir
  em 90 dias, é apagado; se recusado, é apagado 90 dias depois da recusa; se
  aprovado, os três campos da solicitação são apagados 90 dias depois (o relator
  criado guarda nome e contato enquanto a chave estiver ativa).
- **Chave de relator desativada** (`/v1/admin/relatores/:id/desativar`): nome e
  contato são apagados 90 dias depois da desativação, pelo cron diário. Ficam
  o identificador, a data de criação e os relatos dele, sem nome nem contato,
  porque a reputação de outros relatores depende deles.

## Seus direitos

- **Contestação:** se um indicador seu foi apontado, conteste (veja
  [MODERACAO.md](MODERACAO.md)). Decisão em até 7 dias.
- **Exclusão:** peça a exclusão dos relatos sobre um indicador seu quando
  ficar demonstrado que o relato é indevido, e a exclusão dos seus dados
  de relator ou de contestante. Atendemos em até 15 dias, ressalvada a
  retenção que a lei exigir.
- **Acesso e informação:** diremos se há relatos sobre o indicador que você
  provar ser seu e a quantidade, sem revelar quem relatou.
- **Oposição ao legítimo interesse:** avaliada caso a caso, na contestação.

Para provar que o indicador é seu, o moderador pode pedir um sinal simples de
controle (por exemplo, responder a partir do e-mail ou publicar um registro
TXT no domínio). Não pedimos documento de identidade.

Pedidos de exclusão, acesso ou correção: chame o mantenedor no WhatsApp
(https://wa.me/5521995988404?text=Pedido%20de%20privacidade%20da%20Rede%20de%20Confian%C3%A7a). Não
mande o dado pessoal na primeira mensagem: o canal para enviá-lo é combinado
ali. O prazo de resposta é o da moderação (veja `docs/MODERACAO.md`).

## Instâncias de terceiros

Cada instância tem seu operador, que responde por ela. Este documento vale
para a instância de referência da Genesis Innovation e é o padrão mínimo
recomendado às demais.
