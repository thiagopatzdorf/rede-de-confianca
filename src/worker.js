// Rede de Confiança: API em Cloudflare Worker + D1 (binding `DB`).
// O contrato (docs/CONTRATO.md) manda em rotas, tabelas e formas.
//
// Regras que este arquivo existe para garantir:
//  - o valor cru de um indicador nunca é gravado nem logado: só o hash;
//  - rota pública nunca devolve evidência, relatos nem relator_id;
//  - chave de relator aparece uma única vez e fica guardada só como sha256;
//  - tokens são comparados em tempo constante;
//  - o valor cru não viaja na URL (que vai para log de borda): a consulta é
//    POST com valor ou hash, ou GET só com hash;
//  - o banco guarda HMAC(PEPPER, hash do cliente), nunca o sha256 público, e
//    as chaves dos limites de uso são HMAC do balde de rede, nunca o IP;
//  - sem PEPPER de 32+ caracteres o worker responde 500 `configuracao` em tudo.

import { hashIndicador, ehHashIndicador, baldeDeIp } from "./normalizar.js";
import { pontuar, reputacoesDaRede } from "./pontuacao.js";
import { DIA, LIMITES } from "./limites.js";
import { expirar } from "./expiracao.js";
import { hmacHex, hashArmazenado, segredoValido } from "./segredos.js";
import { contemDadoPessoal } from "./dados-pessoais.js";

const VERSAO = "1";
const TIPOS = ["ip", "email", "dominio", "dispositivo"];
const CATEGORIAS = ["chargeback", "cartao_testado", "conta_falsa", "phishing", "bot_abuso", "outro"];

const DEDUPE_MS = 30 * DIA;
const ESTADOS_CONTESTACAO = ["aberta", "em_analise", "procedente", "improcedente"];
const ESTADOS_SOLICITACAO = ["pendente", "aprovada", "recusada"];
const MOTIVOS_REMOCAO = ["malicioso", "titular", "expirado"];
// Teto de linhas por listagem de moderação: a fila é lida por gente.
const MAX_LISTAGEM = 100;
// Teto de relatos que uma decisão pode nomear.
const MAX_RELATO_IDS = 100;

// Corpo pequeno de propósito: nenhuma rota precisa de mais que isso, e um
// teto impede que alguém use o worker para engolir memória.
const MAX_CORPO = 8 * 1024;
// Teto de relatos lidos por consulta: o score satura muito antes disso, e sem
// teto um indicador "popular" faria cada consulta pública varrer a tabela.
// Os verificados entram primeiro (ver SELECAO_RELATOS): inundar o indicador com
// relatos novos não pode empurrar para fora quem sustenta o alto_risco.
const MAX_RELATOS_POR_CONSULTA = 100;
// Corroboradores considerados por relator. A reputação satura rápido
// ((0.2+c)/(1+c) passa de 0.9 com c = 8), então mais que isso só custaria leitura.
const MAX_CORROBORADORES = 10;

class ErroHttp extends Error {
  constructor(status, erro, mensagem, extras = {}) {
    super(mensagem);
    this.status = status;
    this.erro = erro;
    this.extras = extras;
  }
}

function json(corpo, status = 200, cabecalhos = {}) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Consulta de risco muda a cada relato; cache intermediário serviria dado velho.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...cabecalhos,
    },
  });
}

function respostaErro(e) {
  const cab = e.extras.retry_after ? { "retry-after": String(e.extras.retry_after) } : {};
  return json({ erro: e.erro, mensagem: e.message }, e.status, cab);
}

// ---------- criptografia ----------

const encoder = new TextEncoder();

async function sha256Bytes(texto) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(texto)));
}

function paraHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(texto) {
  return paraHex(await sha256Bytes(texto));
}

// Compara os dois valores depois de passá-los por sha256: os resumos têm
// sempre 32 bytes, então nem o tamanho do token vaza pelo tempo da comparação,
// e o laço não sai cedo no primeiro byte diferente.
async function iguaisEmTempoConstante(a, b) {
  const [ha, hb] = await Promise.all([sha256Bytes(a), sha256Bytes(b)]);
  let diferenca = 0;
  for (let i = 0; i < ha.length; i++) diferenca |= ha[i] ^ hb[i];
  return diferenca === 0;
}

function chaveNova() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 256 bits
  return "rdc_" + paraHex(bytes);
}

// ---------- entrada ----------

function tokenBearer(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") || "");
  return m ? m[1] : null;
}

// Só `application/json`. Com text/plain uma página qualquer dispara POST pelo
// navegador do visitante sem preflight (CSRF): queimaria a cota de limite
// dele ou distribuiria uma varredura por muitos IPs. Chamada ANTES de gastar
// limite, para o POST forjado não consumir a cota de quem foi enganado.
function exigirJson(request) {
  const tipo = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (tipo !== "application/json") {
    throw new ErroHttp(415, "tipo_de_conteudo", "Envie o corpo como application/json.");
  }
}

// Lê o corpo por pedaços e para ao passar do teto: bufferizar tudo para só
// então medir deixava um corpo de 5 MB ocupar a memória do worker antes do 413.
// O teto é em BYTES (length de string conta unidades UTF-16).
async function lerTextoLimitado(request) {
  const declarado = Number(request.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > MAX_CORPO) {
    throw new ErroHttp(413, "corpo_grande", `O corpo passa de ${MAX_CORPO} bytes.`);
  }
  if (!request.body) return "";
  const leitor = request.body.getReader();
  const partes = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CORPO) {
      await leitor.cancel().catch(() => {});
      throw new ErroHttp(413, "corpo_grande", `O corpo passa de ${MAX_CORPO} bytes.`);
    }
    partes.push(value);
  }
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const parte of partes) {
    bytes.set(parte, pos);
    pos += parte.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ErroHttp(400, "corpo_invalido", "O corpo não é UTF-8 válido.");
  }
}

async function lerJson(request) {
  exigirJson(request);
  const texto = await lerTextoLimitado(request);
  let corpo;
  try {
    corpo = JSON.parse(texto);
  } catch {
    throw new ErroHttp(400, "corpo_invalido", "O corpo não é JSON válido.");
  }
  if (corpo === null || typeof corpo !== "object" || Array.isArray(corpo)) {
    throw new ErroHttp(400, "corpo_invalido", "O corpo deve ser um objeto JSON.");
  }
  return corpo;
}

// Caracteres que o olho não vê: controle (Cc), formatação (Cf: espaço de
// largura zero, bidi como U+202E que inverte o texto na tela do moderador,
// BOM, hífen suave), separadores de linha e parágrafo, e os "espaços" que não
// são \s para o trim (preenchimentos Hangul, Braille em branco). Passavam no
// mínimo de caracteres e criavam contestação vazia na fila.
const INVISIVEL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/u;
// Texto de várias linhas (evidência, motivo, nota) aceita \n e \t; nome,
// contato e URL são de uma linha só.
const INVISIVEL_MENOS_QUEBRA = /(?![\n\r\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/u;

// `multilinha`: aceita \n e \t. `semDadoPessoal`: recusa CPF e cartão (a rede
// promete nunca guardá-los; aviso em documentação não basta).
function exigirTexto(corpo, campo, { min = 1, max, opcional = false, multilinha = false, semDadoPessoal = false } = {}) {
  const v = corpo[campo];
  if (v === undefined || v === null) {
    if (opcional) return null;
    throw new ErroHttp(400, "campo_invalido", `Falta o campo "${campo}".`);
  }
  if (typeof v !== "string") {
    throw new ErroHttp(400, "campo_invalido", `O campo "${campo}" deve ser texto.`);
  }
  if ((multilinha ? INVISIVEL_MENOS_QUEBRA : INVISIVEL).test(v)) {
    throw new ErroHttp(400, "campo_invalido", `O campo "${campo}" tem caracteres invisíveis ou de controle.`);
  }
  const t = v.trim();
  if (t.length === 0 && opcional) return null;
  if (t.length < min || t.length > max) {
    throw new ErroHttp(400, "campo_invalido", `O campo "${campo}" deve ter de ${min} a ${max} caracteres.`);
  }
  // Mensagem fixa: nunca repete o que foi encontrado.
  if (semDadoPessoal && contemDadoPessoal(t)) {
    throw new ErroHttp(
      400,
      "dado_pessoal",
      `O campo "${campo}" parece conter CPF ou número de cartão. Remova ou mascare antes de enviar.`,
    );
  }
  return t;
}

function exigirTipo(tipo) {
  if (typeof tipo !== "string" || !TIPOS.includes(tipo)) {
    throw new ErroHttp(400, "tipo_invalido", `Tipo deve ser um de: ${TIPOS.join(", ")}.`);
  }
  return tipo;
}

// Devolve { tipo, hash }, onde `hash` é o que vai para o BANCO:
// HMAC(PEPPER, hash do cliente). A mensagem de erro é fixa de propósito: a do
// normalizador poderia repetir o valor cru que recebeu.
async function indicadorDe(env, tipo, valor) {
  exigirTipo(tipo);
  if (typeof valor !== "string" || valor.length === 0 || valor.length > 512) {
    throw new ErroHttp(400, "indicador_invalido", "Valor do indicador ausente ou inválido para o tipo.");
  }
  let hashDoCliente;
  try {
    hashDoCliente = await hashIndicador(tipo, valor);
  } catch (e) {
    if (e && e.codigo === "indicador_invalido") {
      throw new ErroHttp(400, "indicador_invalido", "Valor do indicador inválido para o tipo.");
    }
    throw e;
  }
  return { tipo, hash: await hashArmazenado(env.PEPPER, hashDoCliente) };
}

// Aceita { tipo, valor } OU { tipo, hash }, nunca os dois nem nenhum: o
// cliente que não quer enviar o valor calcula o hash dele (hashIndicador).
// O hash que chega é o público (sha256); o servidor o troca pelo HMAC antes de
// tocar no banco. A mensagem de erro nunca ecoa o que veio.
async function indicadorDoPedido(env, tipo, valor, hash) {
  const temValor = valor !== undefined && valor !== null;
  const temHash = hash !== undefined && hash !== null;
  if (temValor === temHash) {
    throw new ErroHttp(400, "indicador_invalido", 'Envie "valor" ou "hash" (um dos dois).');
  }
  if (temValor) return indicadorDe(env, tipo, valor);
  exigirTipo(tipo);
  if (!ehHashIndicador(hash)) {
    throw new ErroHttp(400, "indicador_invalido", "Hash deve ter 64 caracteres hexadecimais.");
  }
  return { tipo, hash: await hashArmazenado(env.PEPPER, hash) };
}

// ---------- limites de uso ----------

// Chave de limite do solicitante: HMAC(PEPPER, balde de rede). Balde é IPv4 /24
// ou IPv6 /64, não o endereço: quem tem um /64 tem 2^64 endereços e, contando
// por endereço, nunca esbarraria no limite. O HMAC (e não sha256 puro) impede
// recuperar o IP de quem só consultou a partir do banco: o espaço IPv4 é pequeno.
async function chaveDeRede(request, env) {
  const balde = baldeDeIp(request.headers.get("cf-connecting-ip"));
  return hmacHex(env.PEPPER, "limite-rede:" + balde);
}

function erroLimite(janela, janela_ms, agora) {
  const restante = Math.max(1, Math.ceil(((janela + 1) * janela_ms - agora) / 1000));
  return new ErroHttp(429, "limite_excedido", "Limite de uso atingido; tente de novo mais tarde.", {
    retry_after: restante,
  });
}

// Janela fixa por upsert atômico: sem ler-e-depois-gravar, dois pedidos
// simultâneos não furam o limite. É a ÚNICA escrita de uma consulta pública:
// contadores velhos são podados pelo cron diário (src/expiracao.js), não a cada
// chamada, senão cada consulta custaria duas escritas no D1.
async function consumirLimite(db, chave, { max, janela_ms }, agora) {
  const janela = Math.floor(agora / janela_ms);
  const linha = await db
    .prepare(
      `INSERT INTO limites (chave, janela, contagem) VALUES (?, ?, 1)
       ON CONFLICT (chave, janela) DO UPDATE SET contagem = contagem + 1
       RETURNING contagem`,
    )
    .bind(chave, janela)
    .first();
  if (linha.contagem > max) throw erroLimite(janela, janela_ms, agora);
}

// ---------- pontuação a partir do banco ----------

// Relatos que entram na consulta: de pé (nem removidos nem derrubados), os de
// relator verificado primeiro e depois os mais recentes. Os três SELECTs abaixo
// partem DESTE mesmo trecho, para a reputação ser calculada sobre os mesmos
// relatores que a pontuação lê.
const SELECAO_RELATOS = `
  SELECT r.id, r.tipo_indicador, r.indicador_hash, r.categoria, r.relator_id, r.criado_em
    FROM relatos r
    LEFT JOIN relatos_derrubados d ON d.relato_id = r.id
    LEFT JOIN relatores l ON l.id = r.relator_id
   WHERE r.tipo_indicador = ?1 AND r.indicador_hash = ?2 AND r.removido_em IS NULL AND d.relato_id IS NULL
   ORDER BY COALESCE(l.verificado, 0) DESC, r.criado_em DESC, r.id
   LIMIT ?3`;

// Relato "de pé" de um lado e do outro do par: nenhum removido, nenhum derrubado.
const PAR_DE_PE = `
  r.removido_em IS NULL AND o.removido_em IS NULL
  AND NOT EXISTS (SELECT 1 FROM relatos_derrubados d WHERE d.relato_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM relatos_derrubados d WHERE d.relato_id = o.id)`;

// Pares (relator, outro relator) que reportaram o mesmo indicador, para os
// relatores da seleção. No máximo MAX_CORROBORADORES por relator, verificados
// primeiro e depois os mais antigos: conta velha custa mais que conta nova.
const SQL_PARES = `
  WITH sel AS (${SELECAO_RELATOS}),
  alvo AS (SELECT DISTINCT relator_id FROM sel),
  pares AS (
    SELECT DISTINCT r.relator_id AS rid, o.relator_id AS xid
      FROM relatos r
      JOIN relatos o ON o.tipo_indicador = r.tipo_indicador
                    AND o.indicador_hash = r.indicador_hash
                    AND o.relator_id <> r.relator_id
     WHERE r.relator_id IN (SELECT relator_id FROM alvo) AND ${PAR_DE_PE}
  )
  SELECT rid, xid FROM (
    SELECT p.rid, p.xid,
           ROW_NUMBER() OVER (PARTITION BY p.rid
                              ORDER BY COALESCE(x.verificado, 0) DESC, COALESCE(x.criado_em, 0), p.xid) AS rn
      FROM pares p LEFT JOIN relatores x ON x.id = p.xid
  ) WHERE rn <= ?4
  ORDER BY rid, xid`;

// Dados de cada relator envolvido (os da seleção e os corroboradores), numa
// leitura só: o que `reputacoesDaRede` precisa e nada além. `json_each` leva a
// lista numa única variável (o D1 limita a 100 variáveis por comando).
const SQL_RELATORES = `
  SELECT l.id, l.verificado, l.criado_em, l.ativo, l.suspenso_em,
         (SELECT COUNT(*) FROM relatos x
           WHERE x.relator_id = l.id
             AND (x.removido_motivo = 'malicioso'
                  OR EXISTS (SELECT 1 FROM relatos_derrubados d WHERE d.relato_id = x.id))) AS refutados,
         (SELECT COUNT(DISTINCT o.relator_id)
            FROM relatos r
            JOIN relatos o ON o.tipo_indicador = r.tipo_indicador
                          AND o.indicador_hash = r.indicador_hash
                          AND o.relator_id <> r.relator_id
            JOIN relatores v ON v.id = o.relator_id
                            AND v.verificado = 1 AND v.ativo = 1 AND v.suspenso_em IS NULL
           WHERE r.relator_id = l.id AND ${PAR_DE_PE}) AS corroboradores_verificados
    FROM relatores l
   WHERE l.id IN (SELECT value FROM json_each(?1))`;

// Custo fixo de leitura: 3 consultas agregadas, qualquer que seja o número de
// relatores (a versão anterior fazia 3 por relator: 304 com 100 relatores).
async function pontuarIndicador(db, tipo, hash, agora) {
  const { results: relatos } = await db.prepare(SELECAO_RELATOS).bind(tipo, hash, MAX_RELATOS_POR_CONSULTA).all();
  if (relatos.length === 0) return pontuar({ relatos: [], agora, reputacaoDe: () => 0 });

  const { results: pares } = await db
    .prepare(SQL_PARES)
    .bind(tipo, hash, MAX_RELATOS_POR_CONSULTA, MAX_CORROBORADORES)
    .all();
  const envolvidos = new Set([...relatos.map((r) => r.relator_id), ...pares.flatMap((p) => [p.rid, p.xid])]);
  const { results: linhas } = await db.prepare(SQL_RELATORES).bind(JSON.stringify([...envolvidos])).all();

  const info = new Map();
  for (const l of linhas) {
    info.set(l.id, {
      verificado: l.verificado === 1,
      criado_em: l.criado_em,
      // Suspenso ou com a chave desativada não ajuda a promover ninguém, mas os
      // relatos dele seguem contando (contrato).
      impedido: l.ativo !== 1 || l.suspenso_em != null,
      refutados: l.refutados,
      corroboradores_verificados: l.corroboradores_verificados,
    });
  }
  const reputacoes = reputacoesDaRede({ relatores: info, pares: pares.map((p) => [p.rid, p.xid]), agora });

  return pontuar({
    relatos: relatos.map((r) => ({ ...r, contestacao: null })),
    agora,
    // Relator que sumiu do banco: reputação inicial, conta nova, sem verificação.
    reputacaoDe: (id) => reputacoes.get(id) ?? 0.2,
    relatorDe: (id) => {
      const i = info.get(id);
      return i ? { verificado: i.verificado, criado_em: i.criado_em } : { verificado: false, criado_em: agora };
    },
  });
}

// ---------- rotas ----------

async function consultar(request, env, agora, tipo, valor, hash) {
  // Limite antes de validar: sondagem com valores inválidos também gasta cota.
  await consumirLimite(env.DB, "consulta:" + (await chaveDeRede(request, env)), LIMITES.consulta, agora);
  const ind = await indicadorDoPedido(env, tipo, valor, hash);
  const r = await pontuarIndicador(env.DB, ind.tipo, ind.hash, agora);
  // Lista branca explícita: se a pontuação ganhar campos novos (motivos etc.),
  // eles não vazam sem alguém decidir.
  return json({
    score: r.score,
    nivel: r.nivel,
    relatores_distintos: r.relatores_distintos,
    ultimo_relato_em: r.ultimo_relato_em,
  });
}

// GET só aceita hash. Se chegar "valor" na URL, ele já passou por log de
// borda e de proxy: recusa e não o repete na resposta. Antes do limite de
// uso, para a recusa não gastar cota de quem só errou o formato.
async function rotaConsultaGet(request, env, agora) {
  const q = new URL(request.url).searchParams;
  if (q.has("valor")) {
    throw new ErroHttp(
      400,
      "valor_na_url",
      "O valor cru não pode ir na URL. Envie POST /v1/consulta com {tipo, valor} ou use GET com ?tipo=&hash=.",
    );
  }
  return consultar(request, env, agora, q.get("tipo"), undefined, q.get("hash") ?? undefined);
}

async function rotaConsultaPost(request, env, agora) {
  exigirJson(request);
  const corpo = await lerJson(request);
  return consultar(request, env, agora, corpo.tipo, corpo.valor, corpo.hash);
}

async function autenticarRelator(request, env) {
  const chave = tokenBearer(request);
  if (!chave) throw new ErroHttp(401, "nao_autorizado", "Chave de relator ausente.");
  // Busca pelo hash: a chave tem 256 bits aleatórios, então não há o que
  // adivinhar por tempo de resposta, e o banco nunca vê a chave.
  const relator = await env.DB.prepare("SELECT id, ativo, suspenso_em FROM relatores WHERE chave_hash = ?")
    .bind(await sha256Hex(chave))
    .first();
  if (!relator || !relator.ativo) throw new ErroHttp(401, "nao_autorizado", "Chave de relator inválida.");
  // 403 e não 401: a chave é válida, o relator é que está impedido de
  // reportar. Os relatos que ele já fez seguem contando (ver CONTRATO).
  if (relator.suspenso_em != null) throw new ErroHttp(403, "relator_suspenso", "Relator suspenso.");
  return relator;
}

async function rotaRelato(request, env, agora) {
  const relator = await autenticarRelator(request, env);
  const corpo = await lerJson(request);
  const categoria = corpo.categoria;
  if (typeof categoria !== "string" || !CATEGORIAS.includes(categoria)) {
    throw new ErroHttp(400, "categoria_invalida", `Categoria deve ser uma de: ${CATEGORIAS.join(", ")}.`);
  }
  const evidencia = exigirTexto(corpo, "evidencia", { max: 280, opcional: true, multilinha: true, semDadoPessoal: true });
  const { tipo, hash } = await indicadorDe(env, corpo.tipo, corpo.valor);

  // Dedupe antes do limite: repetir o mesmo relato por engano não deve gastar
  // a cota diária de quem reporta de boa-fé.
  const repetido = await env.DB.prepare(
    `SELECT 1 AS x FROM relatos
      WHERE relator_id = ? AND tipo_indicador = ? AND indicador_hash = ? AND categoria = ? AND criado_em > ?
        AND removido_em IS NULL
      LIMIT 1`,
  )
    .bind(relator.id, tipo, hash, categoria, agora - DEDUPE_MS)
    .first();
  if (repetido) {
    throw new ErroHttp(409, "duplicado", "Você já reportou este indicador nesta categoria nos últimos 30 dias.");
  }

  await consumirLimite(env.DB, "relato:" + relator.id, LIMITES.relato, agora);

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO relatos (id, tipo_indicador, indicador_hash, categoria, relator_id, evidencia, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, tipo, hash, categoria, relator.id, evidencia, agora)
    .run();
  return json({ id }, 201);
}

async function rotaContestacao(request, env, agora) {
  exigirJson(request);
  await consumirLimite(env.DB, "contestacao:" + (await chaveDeRede(request, env)), LIMITES.contestacao, agora);
  const corpo = await lerJson(request);
  const motivo = exigirTexto(corpo, "motivo", { min: 10, max: 500, multilinha: true, semDadoPessoal: true });
  const contato = exigirTexto(corpo, "contato", { max: 200, opcional: true });
  const { tipo, hash } = await indicadorDoPedido(env, corpo.tipo, corpo.valor, corpo.hash);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO contestacoes (id, tipo_indicador, indicador_hash, motivo, contato, estado, criado_em)
     VALUES (?, ?, ?, ?, ?, 'aberta', ?)`,
  )
    .bind(id, tipo, hash, motivo, contato, agora)
    .run();
  return json({ id }, 201);
}

// Moderação: token de 32+ caracteres e limite de TENTATIVAS FALHAS por balde de
// rede. A mensagem é a mesma para token ausente, curto, errado ou não
// configurado: dizer qual deles seria mapa do deploy para quem sonda.
async function exigirAdmin(request, env, agora) {
  const chave = "admin:" + (await chaveDeRede(request, env));
  const { max, janela_ms } = LIMITES.admin;
  const janela = Math.floor(agora / janela_ms);
  // Lê antes de comparar: depois de `max` falhas nem o token certo é testado,
  // senão o limite não impediria adivinhar, só atrasaria a resposta.
  const atual = await env.DB.prepare("SELECT contagem FROM limites WHERE chave = ? AND janela = ?").bind(chave, janela).first();
  if (atual && atual.contagem >= max) throw erroLimite(janela, janela_ms, agora);

  const esperado = env.ADMIN_TOKEN;
  const dado = tokenBearer(request);
  // Sem segredo configurado (ou fraco), nada passa: comparar com "" aceitaria
  // um "Bearer" vazio em implantação mal feita.
  if (segredoValido(esperado) && dado && (await iguaisEmTempoConstante(dado, esperado))) return;
  await consumirLimite(env.DB, chave, LIMITES.admin, agora);
  throw new ErroHttp(401, "nao_autorizado", "Token de moderação inválido.");
}

// Cria o relator e devolve a chave, que só existe aqui e na resposta.
async function criarRelator(env, nome, contato, agora) {
  const id = crypto.randomUUID();
  const chave = chaveNova();
  await env.DB.prepare("INSERT INTO relatores (id, nome, contato, chave_hash, criado_em, ativo) VALUES (?, ?, ?, ?, ?, 1)")
    .bind(id, nome, contato, await sha256Hex(chave), agora)
    .run();
  return { relator_id: id, chave };
}

async function rotaCriarRelator(request, env, agora) {
  await exigirAdmin(request, env, agora);
  const corpo = await lerJson(request);
  const nome = exigirTexto(corpo, "nome", { max: 120 });
  const contato = exigirTexto(corpo, "contato", { max: 200 });
  return json(await criarRelator(env, nome, contato, agora), 201);
}

function estadoDaQuery(request, validos) {
  const estado = new URL(request.url).searchParams.get("estado");
  if (estado === null) return null;
  if (!validos.includes(estado)) {
    throw new ErroHttp(400, "campo_invalido", `O filtro "estado" deve ser um de: ${validos.join(", ")}.`);
  }
  return estado;
}

async function rotaListarContestacoes(request, env, agora) {
  await exigirAdmin(request, env, agora);
  const estado = estadoDaQuery(request, ESTADOS_CONTESTACAO);
  const { results } = await env.DB.prepare(
    `SELECT id, tipo_indicador, indicador_hash, motivo, contato, estado, criado_em, decidido_em, nota
       FROM contestacoes WHERE (?1 IS NULL OR estado = ?1)
      ORDER BY criado_em ASC, id ASC LIMIT ?2`,
  )
    .bind(estado, MAX_LISTAGEM)
    .all();
  return json({ contestacoes: results });
}

// Triagem: o moderador conferiu (fora da API) se quem contesta controla o
// indicador. Com prova a contestação vira `em_analise` e FICA habilitada a
// virar `procedente`; sem prova é encerrada como improcedente. Nenhum dos dois
// mexe no score: provar controle mede identidade, não inocência (o fraudador
// controla o e-mail dele), então só a decisão `procedente` derruba relatos.
async function rotaTriagem(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const corpo = await lerJson(request);
  if (typeof corpo.prova_de_controle !== "boolean") {
    throw new ErroHttp(400, "campo_invalido", 'O campo "prova_de_controle" deve ser true ou false.');
  }
  const novo = corpo.prova_de_controle ? "em_analise" : "improcedente";
  const atual = await env.DB.prepare("SELECT estado FROM contestacoes WHERE id = ?").bind(id).first();
  if (!atual) throw new ErroHttp(404, "nao_encontrado", "Contestação não encontrada.");
  const r = await env.DB.prepare(
    `UPDATE contestacoes SET estado = ?1, decidido_em = CASE WHEN ?1 = 'improcedente' THEN ?2 END,
            nota = CASE WHEN ?1 = 'improcedente' THEN 'Sem prova de controle do indicador.' END
      WHERE id = ?3 AND estado = 'aberta'`,
  )
    .bind(novo, agora, id)
    .run();
  if (!r.meta || r.meta.changes !== 1) {
    throw new ErroHttp(409, "estado_invalido", "Só contestação aberta passa por triagem.");
  }
  return json({ id, estado: novo });
}

async function rotaDecidir(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const corpo = await lerJson(request);
  const decisao = corpo.decisao;
  if (decisao !== "procedente" && decisao !== "improcedente") {
    throw new ErroHttp(400, "campo_invalido", 'A decisão deve ser "procedente" ou "improcedente".');
  }
  const nota = exigirTexto(corpo, "nota", { max: 500, multilinha: true });
  let relatoIds = null;
  if (corpo.relato_ids !== undefined) {
    const ids = corpo.relato_ids;
    if (
      decisao !== "procedente" ||
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_RELATO_IDS ||
      !ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)
    ) {
      throw new ErroHttp(
        400,
        "campo_invalido",
        `"relato_ids" vale só para decisão procedente e deve ser uma lista de 1 a ${MAX_RELATO_IDS} ids.`,
      );
    }
    relatoIds = [...new Set(ids)];
  }
  const atual = await env.DB.prepare(
    "SELECT estado, tipo_indicador, indicador_hash FROM contestacoes WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!atual) throw new ErroHttp(404, "nao_encontrado", "Contestação não encontrada.");
  if (atual.estado === "procedente" || atual.estado === "improcedente") {
    throw new ErroHttp(409, "ja_decidida", "Esta contestação já foi decidida.");
  }
  // Derrubar relato exige a triagem: sem prova de controle, qualquer um
  // apagaria relato alheio só por contestar.
  if (decisao === "procedente" && atual.estado !== "em_analise") {
    throw new ErroHttp(409, "sem_triagem", "Decisão procedente exige triagem com prova de controle antes.");
  }
  if (relatoIds) {
    const marcas = relatoIds.map(() => "?").join(",");
    const achados = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM relatos
        WHERE tipo_indicador = ? AND indicador_hash = ? AND removido_em IS NULL AND id IN (${marcas})`,
    )
      .bind(atual.tipo_indicador, atual.indicador_hash, ...relatoIds)
      .first();
    // Tudo ou nada: aceitar parte esconderia um id errado do moderador.
    if (achados.n !== relatoIds.length) {
      throw new ErroHttp(400, "relato_invalido", "Algum relato não existe ou não é deste indicador.");
    }
  }
  // Decidir só uma vez: reabrir silenciosamente reescreveria a história
  // sobre a qual a reputação dos relatores já foi calculada.
  const r = await env.DB.prepare(
    "UPDATE contestacoes SET estado = ?, decidido_em = ?, nota = ? WHERE id = ? AND estado = ?",
  )
    .bind(decisao, agora, nota, id, atual.estado)
    .run();
  if (!r.meta || r.meta.changes !== 1) {
    throw new ErroHttp(409, "ja_decidida", "Esta contestação já foi decidida.");
  }
  if (decisao === "procedente") {
    if (relatoIds) {
      for (const rid of relatoIds) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO relatos_derrubados (relato_id, contestacao_id, derrubado_em) VALUES (?, ?, ?)",
        )
          .bind(rid, id, agora)
          .run();
      }
    } else {
      // Sem lista: todos os relatos até o instante da decisão. Quem reporta
      // depois traz fato novo e não é atingido.
      await env.DB.prepare(
        `INSERT OR IGNORE INTO relatos_derrubados (relato_id, contestacao_id, derrubado_em)
         SELECT id, ?, ? FROM relatos
          WHERE tipo_indicador = ? AND indicador_hash = ? AND removido_em IS NULL AND criado_em <= ?`,
      )
        .bind(id, agora, atual.tipo_indicador, atual.indicador_hash, agora)
        .run();
    }
  }
  return json({ id, estado: decisao });
}

async function rotaSuspensao(request, env, agora, id, suspender) {
  await exigirAdmin(request, env, agora);
  const r = await env.DB.prepare("UPDATE relatores SET suspenso_em = ? WHERE id = ?")
    .bind(suspender ? agora : null, id)
    .run();
  if (!r.meta || r.meta.changes !== 1) throw new ErroHttp(404, "nao_encontrado", "Relator não encontrado.");
  return json({ id, suspenso: suspender });
}

// Verificação: o moderador checou que a loja existe e é quem diz ser (fora da
// API). É o único jeito de um relator passar a corroborar os outros sem
// depender de outra conta; por isso não há rota pública nem automática.
async function rotaVerificacao(request, env, agora, id, verificar) {
  await exigirAdmin(request, env, agora);
  const r = await env.DB.prepare("UPDATE relatores SET verificado = ? WHERE id = ?").bind(verificar ? 1 : 0, id).run();
  if (!r.meta || r.meta.changes !== 1) throw new ErroHttp(404, "nao_encontrado", "Relator não encontrado.");
  return json({ id, verificado: verificar });
}

// Revoga a chave (401 daí em diante) e começa o prazo de 90 dias para apagar
// nome e contato. Idempotente: repetir não renova o prazo.
async function rotaDesativar(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const r = await env.DB.prepare(
    "UPDATE relatores SET ativo = 0, desativado_em = COALESCE(desativado_em, ?) WHERE id = ?",
  )
    .bind(agora, id)
    .run();
  if (!r.meta || r.meta.changes !== 1) throw new ErroHttp(404, "nao_encontrado", "Relator não encontrado.");
  return json({ id, ativo: false });
}

// Tombstone: o relato sai do score e a evidência é apagada, mas a linha fica
// (com o motivo) para o dedupe e a auditoria.
async function rotaRemoverRelato(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const corpo = await lerJson(request);
  if (!MOTIVOS_REMOCAO.includes(corpo.motivo)) {
    throw new ErroHttp(400, "campo_invalido", `O motivo deve ser um de: ${MOTIVOS_REMOCAO.join(", ")}.`);
  }
  const atual = await env.DB.prepare("SELECT removido_em FROM relatos WHERE id = ?").bind(id).first();
  if (!atual) throw new ErroHttp(404, "nao_encontrado", "Relato não encontrado.");
  if (atual.removido_em != null) throw new ErroHttp(409, "ja_removido", "Este relato já foi removido.");
  await env.DB.prepare(
    "UPDATE relatos SET removido_em = ?, removido_motivo = ?, evidencia = NULL WHERE id = ? AND removido_em IS NULL",
  )
    .bind(agora, corpo.motivo, id)
    .run();
  return json({ id, removido: true, motivo: corpo.motivo });
}

async function rotaApagarEvidencia(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const r = await env.DB.prepare("UPDATE relatos SET evidencia = NULL WHERE id = ?").bind(id).run();
  if (!r.meta || r.meta.changes !== 1) throw new ErroHttp(404, "nao_encontrado", "Relato não encontrado.");
  return json({ id, evidencia_apagada: true });
}

// URL da loja: só http(s), para o moderador abrir sem surpresa (nada de
// javascript: ou file:).
function exigirUrlLoja(corpo) {
  const bruto = exigirTexto(corpo, "loja_url", { max: 300, semDadoPessoal: true });
  let url;
  try {
    url = new URL(bruto);
  } catch {
    throw new ErroHttp(400, "campo_invalido", 'O campo "loja_url" deve ser uma URL http(s) válida.');
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ErroHttp(400, "campo_invalido", 'O campo "loja_url" deve ser uma URL http(s) válida.');
  }
  return bruto;
}

async function rotaSolicitar(request, env, agora) {
  // Limite antes de validar: é rota pública que grava, e sem limite viraria
  // fila de spam para o moderador.
  exigirJson(request);
  await consumirLimite(env.DB, "solicitacao:" + (await chaveDeRede(request, env)), LIMITES.solicitacao, agora);
  const corpo = await lerJson(request);
  const nome = exigirTexto(corpo, "nome", { max: 120 });
  const contato = exigirTexto(corpo, "contato", { max: 200 });
  const lojaUrl = exigirUrlLoja(corpo);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO solicitacoes_relator (id, nome, contato, loja_url, estado, criado_em)
     VALUES (?, ?, ?, ?, 'pendente', ?)`,
  )
    .bind(id, nome, contato, lojaUrl, agora)
    .run();
  return json({ id }, 201);
}

async function rotaListarSolicitacoes(request, env, agora) {
  await exigirAdmin(request, env, agora);
  const estado = estadoDaQuery(request, ESTADOS_SOLICITACAO);
  const { results } = await env.DB.prepare(
    `SELECT id, nome, contato, loja_url, estado, criado_em, decidido_em, relator_id, nota
       FROM solicitacoes_relator WHERE (?1 IS NULL OR estado = ?1)
      ORDER BY criado_em ASC, id ASC LIMIT ?2`,
  )
    .bind(estado, MAX_LISTAGEM)
    .all();
  return json({ solicitacoes: results });
}

async function rotaAprovarSolicitacao(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const sol = await env.DB.prepare("SELECT nome, contato FROM solicitacoes_relator WHERE id = ?").bind(id).first();
  if (!sol) throw new ErroHttp(404, "nao_encontrado", "Solicitação não encontrada.");
  // Reservar antes de criar: duas aprovações simultâneas não geram dois relatores.
  const r = await env.DB.prepare(
    "UPDATE solicitacoes_relator SET estado = 'aprovada', decidido_em = ? WHERE id = ? AND estado = 'pendente'",
  )
    .bind(agora, id)
    .run();
  if (!r.meta || r.meta.changes !== 1) {
    throw new ErroHttp(409, "ja_decidida", "Esta solicitação já foi decidida.");
  }
  try {
    const novo = await criarRelator(env, sol.nome, sol.contato, agora);
    await env.DB.prepare("UPDATE solicitacoes_relator SET relator_id = ? WHERE id = ?").bind(novo.relator_id, id).run();
    // Única vez em que a chave existe fora do cliente.
    return json(novo);
  } catch (e) {
    // Sem relator criado, a solicitação volta à fila em vez de ficar
    // "aprovada" sem ninguém com chave.
    await env.DB.prepare("UPDATE solicitacoes_relator SET estado = 'pendente', decidido_em = NULL WHERE id = ?")
      .bind(id)
      .run();
    throw e;
  }
}

async function rotaRecusarSolicitacao(request, env, agora, id) {
  await exigirAdmin(request, env, agora);
  const corpo = await lerJson(request);
  const nota = exigirTexto(corpo, "nota", { max: 500, opcional: true, multilinha: true });
  const existe = await env.DB.prepare("SELECT 1 AS x FROM solicitacoes_relator WHERE id = ?").bind(id).first();
  if (!existe) throw new ErroHttp(404, "nao_encontrado", "Solicitação não encontrada.");
  const r = await env.DB.prepare(
    "UPDATE solicitacoes_relator SET estado = 'recusada', decidido_em = ?, nota = ? WHERE id = ? AND estado = 'pendente'",
  )
    .bind(agora, nota, id)
    .run();
  if (!r.meta || r.meta.changes !== 1) {
    throw new ErroHttp(409, "ja_decidida", "Esta solicitação já foi decidida.");
  }
  return json({ id, estado: "recusada" });
}

// ---------- roteamento ----------

async function rotear(request, env, agora) {
  const { pathname } = new URL(request.url);
  const metodo = request.method;
  const exigir = (m) => {
    if (metodo !== m) throw new ErroHttp(405, "metodo_nao_permitido", `Use ${m} nesta rota.`);
  };

  if (pathname === "/v1/saude") {
    exigir("GET");
    return json({ ok: true, versao: VERSAO });
  }
  if (pathname === "/v1/consulta") {
    if (metodo === "POST") return rotaConsultaPost(request, env, agora);
    exigir("GET");
    return rotaConsultaGet(request, env, agora);
  }
  if (pathname === "/v1/relatos") {
    exigir("POST");
    return rotaRelato(request, env, agora);
  }
  if (pathname === "/v1/contestacoes") {
    exigir("POST");
    return rotaContestacao(request, env, agora);
  }
  if (pathname === "/v1/relatores/solicitacoes") {
    exigir("POST");
    return rotaSolicitar(request, env, agora);
  }
  if (pathname === "/v1/admin/relatores") {
    exigir("POST");
    return rotaCriarRelator(request, env, agora);
  }
  if (pathname === "/v1/admin/contestacoes") {
    exigir("GET");
    return rotaListarContestacoes(request, env, agora);
  }
  if (pathname === "/v1/admin/solicitacoes") {
    exigir("GET");
    return rotaListarSolicitacoes(request, env, agora);
  }
  const ID = "([A-Za-z0-9-]{1,64})";
  let m;
  if ((m = new RegExp(`^/v1/admin/contestacoes/${ID}/(decidir|triagem)$`).exec(pathname))) {
    exigir("POST");
    return m[2] === "decidir" ? rotaDecidir(request, env, agora, m[1]) : rotaTriagem(request, env, agora, m[1]);
  }
  if ((m = new RegExp(`^/v1/admin/relatores/${ID}/(suspender|reativar)$`).exec(pathname))) {
    exigir("POST");
    return rotaSuspensao(request, env, agora, m[1], m[2] === "suspender");
  }
  if ((m = new RegExp(`^/v1/admin/relatores/${ID}/(verificar|desverificar)$`).exec(pathname))) {
    exigir("POST");
    return rotaVerificacao(request, env, agora, m[1], m[2] === "verificar");
  }
  if ((m = new RegExp(`^/v1/admin/relatores/${ID}/desativar$`).exec(pathname))) {
    exigir("POST");
    return rotaDesativar(request, env, agora, m[1]);
  }
  if ((m = new RegExp(`^/v1/admin/relatos/${ID}/(remover|apagar-evidencia)$`).exec(pathname))) {
    exigir("POST");
    return m[2] === "remover" ? rotaRemoverRelato(request, env, agora, m[1]) : rotaApagarEvidencia(request, env, agora, m[1]);
  }
  if ((m = new RegExp(`^/v1/admin/solicitacoes/${ID}/(aprovar|recusar)$`).exec(pathname))) {
    exigir("POST");
    return m[2] === "aprovar" ? rotaAprovarSolicitacao(request, env, agora, m[1]) : rotaRecusarSolicitacao(request, env, agora, m[1]);
  }
  throw new ErroHttp(404, "nao_encontrado", "Rota não encontrada.");
}

// `agora` é parâmetro para o teste controlar o relógio (janelas e dedupe).
export async function tratar(request, env, agora = Date.now()) {
  try {
    // Falha fechada: sem pepper o worker gravaria o sha256 público (reversível
    // para IPv4 inteiro) e chaves de limite sem segredo. Melhor não responder.
    if (!segredoValido(env.PEPPER)) {
      console.error("erro_configuracao");
      return json({ erro: "configuracao", mensagem: "Configuração do servidor incompleta." }, 500);
    }
    return await rotear(request, env, agora);
  } catch (e) {
    if (e instanceof ErroHttp) return respostaErro(e);
    // Só o nome do erro: a mensagem de um erro de banco ou de normalização
    // poderia carregar dado do pedido.
    console.error("erro_interno", e && e.name);
    return json({ erro: "erro_interno", mensagem: "Erro interno." }, 500);
  }
}

export default {
  fetch(request, env) {
    return tratar(request, env);
  },
  // Cron diário (wrangler.toml): expiração de 24 meses e poda de `limites`.
  // Só o nome do erro vai para o log, como no resto do worker.
  scheduled(_evento, env, ctx) {
    ctx.waitUntil(
      expirar(env.DB, Date.now()).catch((e) => {
        console.error("erro_expiracao", e && e.name);
      }),
    );
  },
};
