#!/usr/bin/env node
// Servidor MCP (Model Context Protocol) da Rede de Confiança, por stdio.
// Zero dependências: JSON-RPC 2.0 em linhas (uma mensagem JSON por linha).
//
// Regras que este arquivo existe para garantir (cada uma tem teste em
// tests/mcp.test.mjs):
//  - consulta e contestação mandam só { tipo, hash }: o valor cru não sai da máquina;
//  - reportar não envia nada sem `confirmar: true`;
//  - evidência com cara de CPF/cartão é recusada ANTES de qualquer request;
//  - a chave (RDC_CHAVE) e o valor cru nunca aparecem em resposta, erro nem stderr;
//  - stdout só carrega mensagens do protocolo; log vai para stderr.
import { createInterface } from "node:readline";
import { hashIndicador, TIPOS, CATEGORIAS } from "../src/normalizar.js";
import { contemDadoPessoal } from "../src/dados-pessoais.js";

const VERSAO_SERVIDOR = "0.1.0";
// Da mais nova para a mais antiga que sabemos servir. Se o cliente pedir uma
// destas, ecoamos; senão respondemos com a estável conhecida e ele decide se segue.
const VERSOES_SUPORTADAS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSAO_ESTAVEL = "2025-06-18";
const TIMEOUT_MS = 10_000;
const MAX_LOTE = 10;
const MAX_RESPOSTA_BYTES = 256 * 1024;

const log = (...partes) => process.stderr.write(`[rede-de-confianca-mcp] ${partes.join(" ")}\n`);

// ---------- erros ----------

// Erro de execução de tool: vira `isError: true` com texto acionável, nunca stack trace.
class ErroTool extends Error {}
const falha = (mensagem) => new ErroTool(mensagem);

// Tira de qualquer texto que vá para o modelo a chave e os valores crus que este
// processo conhece. Defesa em profundidade: as mensagens já são montadas sem eles,
// mas texto vindo da API ou de exceção não é nosso.
function redigir(texto, segredos = []) {
  let t = String(texto);
  const chave = process.env.RDC_CHAVE?.trim();
  for (const s of [chave, ...segredos]) {
    if (typeof s === "string" && s.length >= 4) t = t.split(s).join("[oculto]");
  }
  return t;
}

// ---------- configuração ----------

function configuracao() {
  const bruta = (process.env.RDC_API_URL ?? "").trim();
  if (!bruta) {
    throw falha(
      "A Rede de Confiança ainda não está configurada: falta a variável de ambiente RDC_API_URL " +
        "(o endereço da instância da API, por exemplo https://rede.exemplo.com.br). " +
        "Peça o endereço a quem opera a instância e coloque-o na configuração deste servidor MCP " +
        "(veja mcp/README.md). Não existe endereço padrão: a instância de referência ainda não está no ar.",
    );
  }
  let url;
  try {
    url = new URL(bruta);
  } catch {
    throw falha("RDC_API_URL não é um endereço válido. Use algo como https://rede.exemplo.com.br.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw falha(
      "RDC_API_URL precisa começar com https:// (http:// só vale para localhost, em testes). " +
        "Sem https a consulta e a chave viajariam sem proteção.",
    );
  }
  if (url.username || url.password) {
    throw falha("RDC_API_URL não pode conter usuário nem senha. A chave de relator vai em RDC_CHAVE.");
  }
  return { base: url.origin + url.pathname.replace(/\/+$/, ""), chave: process.env.RDC_CHAVE?.trim() || null };
}

// ---------- HTTP ----------

async function chamarApi(cfg, metodo, caminho, corpo, { autenticado = false, segredos = [] } = {}) {
  const headers = { accept: "application/json", "user-agent": `rede-de-confianca-mcp/${VERSAO_SERVIDOR}` };
  if (corpo !== undefined) headers["content-type"] = "application/json";
  if (autenticado) headers.authorization = `Bearer ${cfg.chave}`;
  let res;
  try {
    res = await fetch(cfg.base + caminho, {
      method: metodo,
      headers,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      // Seguir redirecionamento levaria a chave para outro endereço.
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw falha(
        "A API da Rede de Confiança não respondeu em 10 segundos. Nada foi repetido automaticamente; " +
          "tente de novo em alguns instantes.",
      );
    }
    // A mensagem da exceção pode conter a URL; não a repassamos.
    throw falha(
      "Não consegui falar com a API da Rede de Confiança (rede fora do ar ou endereço RDC_API_URL errado). " +
        "Confira o endereço e a conexão.",
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw falha(
      "A API respondeu com um redirecionamento, que não seguimos para não mandar a chave a outro endereço. " +
        "Confira se RDC_API_URL aponta para o endereço final (https).",
    );
  }
  let dados = null;
  try {
    const texto = (await res.text()).slice(0, MAX_RESPOSTA_BYTES);
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    dados = null;
  }
  if (!res.ok) throw erroDeHttp(res.status, dados, res.headers.get("retry-after"), segredos);
  if (dados === null || typeof dados !== "object") {
    throw falha("A API respondeu algo que não é JSON. Confira se RDC_API_URL aponta para uma instância da Rede de Confiança.");
  }
  return dados;
}

function erroDeHttp(status, dados, retryAfter, segredos) {
  const codigo = typeof dados?.erro === "string" ? dados.erro : "";
  const detalhe = typeof dados?.mensagem === "string" ? ` Detalhe da API: ${redigir(dados.mensagem, segredos).slice(0, 300)}` : "";
  const espera = /^\d+$/.test(retryAfter ?? "") ? ` Tente de novo em cerca de ${retryAfter} segundos.` : " Tente de novo mais tarde.";
  switch (status) {
    case 400:
      if (codigo === "dado_pessoal") {
        return falha("A API recusou o texto porque ele parece conter CPF ou número de cartão. Remova ou mascare esses números e tente de novo." + detalhe);
      }
      return falha(`A API recusou o pedido como inválido${codigo ? ` (${codigo})` : ""}. Revise os campos.` + detalhe);
    case 401:
      return falha("A chave de relator foi recusada (401): está errada ou foi desativada. Confira RDC_CHAVE ou peça uma nova chave com a ferramenta pedir_chave_de_relator.");
    case 403:
      if (codigo === "relator_suspenso") {
        return falha("A chave de relator está suspensa (403): não é possível reportar até a moderação reativá-la. Fale com quem opera a instância.");
      }
      return falha("A API negou a permissão (403)." + detalhe);
    case 409:
      if (codigo === "duplicado") {
        return falha("Esse relato já foi enviado por esta chave nos últimos 30 dias (409). Não é preciso repetir; nada foi alterado.");
      }
      return falha(`A API recusou por conflito de estado (409${codigo ? `, ${codigo}` : ""}).` + detalhe);
    case 413:
      return falha("O pedido ficou grande demais para a API (limite de 8 KB). Encurte o texto.");
    case 415:
      return falha("A API recusou o formato do pedido (415). Isso é um defeito deste servidor MCP; avise quem o mantém.");
    case 429:
      return falha("A API limitou o volume de pedidos (429): muitas chamadas em pouco tempo a partir desta rede." + espera);
    default:
      if (status >= 500) {
        return falha(`A API da Rede de Confiança está com problema (${status}${codigo ? `, ${codigo}` : ""}). Tente de novo mais tarde; se persistir, avise quem opera a instância.`);
      }
      return falha(`A API respondeu com erro ${status}${codigo ? ` (${codigo})` : ""}.` + detalhe);
  }
}

// ---------- interpretação ----------

const ROTULO_NIVEL = { desconhecido: "desconhecido", suspeito: "suspeito", alto_risco: "alto risco" };

function interpretar(nivel) {
  const base =
    "Isto é uma pista, não uma prova: o score resume relatos de outras lojas e não diz nada sobre a pessoa. Nunca bloqueie ou recuse um cliente só por causa dele.";
  if (nivel === "alto_risco") {
    return `${base} Vários lojistas independentes já relataram problemas com este indicador. Faça uma revisão manual do pedido e, se possível, confirme a compra por outro canal (ligação, WhatsApp, documento) antes de enviar a mercadoria.`;
  }
  if (nivel === "suspeito") {
    return `${base} Há relatos de mais de uma loja. Vale uma olhada manual no pedido e uma confirmação por outro canal antes de despachar.`;
  }
  return `${base} "Desconhecido" não significa "confiável": só quer dizer que a rede não tem relatos suficientes sobre este indicador. Siga seus controles de sempre.`;
}

function dataIso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

// ---------- validação de entrada ----------

const textoObrigatorio = (args, campo, max) => {
  const v = args[campo];
  if (typeof v !== "string" || !v.trim()) throw falha(`O campo "${campo}" é obrigatório e deve ser texto.`);
  if (v.length > max) throw falha(`O campo "${campo}" passa de ${max} caracteres.`);
  return v;
};
const textoOpcional = (args, campo, max) => (args[campo] === undefined || args[campo] === null || args[campo] === "" ? undefined : textoObrigatorio(args, campo, max));

function tipoValido(tipo) {
  if (!TIPOS.includes(tipo)) throw falha(`Tipo inválido. Use um destes: ${TIPOS.join(", ")}.`);
  return tipo;
}

// Calcula o hash local. A mensagem do normalizador pode conter o valor, então
// montamos uma fixa a partir do tipo.
function hashLocal(tipo, valor) {
  tipoValido(tipo);
  if (typeof valor !== "string" || !valor.trim()) throw falha('O campo "valor" é obrigatório e deve ser texto.');
  try {
    return hashIndicador(tipo, valor);
  } catch (e) {
    if (e?.codigo === "indicador_invalido") {
      throw falha(
        `O valor não é um(a) ${tipo} válido(a) ou não pode ser indicador (IP privado/reservado, e-mail ou domínio malformado, dispositivo fora do formato). Corrija e tente de novo.`,
      );
    }
    throw falha("Não consegui normalizar o valor informado.");
  }
}


function validarResultado(r) {
  if (!r || typeof r.score !== "number" || typeof r.nivel !== "string") {
    throw falha("A API respondeu num formato inesperado. Confira se RDC_API_URL aponta para uma instância da Rede de Confiança.");
  }
  return r;
}

function resumoConsulta(tipo, hash, r) {
  const rel = Number.isInteger(r.relatores_distintos) ? r.relatores_distintos : 0;
  const ultimo = dataIso(r.ultimo_relato_em);
  const interpretacao = interpretar(r.nivel);
  return {
    estruturado: {
      tipo,
      hash_parcial: hash.slice(0, 8),
      score: r.score,
      nivel: r.nivel,
      relatores_distintos: rel,
      ultimo_relato_em: ultimo,
      interpretacao,
    },
    texto:
      `${tipo} (hash ${hash.slice(0, 8)}…): score ${r.score} de 100, nível ${ROTULO_NIVEL[r.nivel] ?? r.nivel}, ` +
      `${rel} lojista(s) distinto(s) com relato${ultimo ? `, último em ${ultimo}` : ""}. ${interpretacao}`,
  };
}

// ---------- tools ----------

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    tipo: { type: "string", enum: [...TIPOS], description: "Que tipo de indicador é o valor." },
    valor: { type: "string", description: "O valor a consultar (e-mail, IP, domínio ou impressão digital do dispositivo)." },
  },
  required: ["tipo", "valor"],
  additionalProperties: false,
};

const AVISO_LGPD =
  "LGPD: relate só o indicador técnico (e-mail, IP, domínio, dispositivo) ligado a uma fraude que você viveu. " +
  "Não envie CPF, número de cartão, nome completo nem outro dado pessoal na evidência.";

const TOOLS = [
  {
    name: "consultar_indicador",
    title: "Consultar um indicador na Rede de Confiança",
    description:
      "Consulta se um e-mail, IP, domínio ou dispositivo foi relatado por outros lojistas como fraude (chargeback, cartão testado, conta falsa, phishing, bot). " +
      "Use quando o dono do negócio quiser saber se vale desconfiar de um pedido, cadastro ou visitante. " +
      "O valor é transformado em um código (hash) aqui na máquina e só o código sai: o e-mail ou IP em si nunca é enviado. " +
      "Devolve score de 0 a 100, nível (desconhecido, suspeito, alto_risco) e quantos lojistas distintos relataram. " +
      "O resultado é uma pista, não uma prova: nunca recuse um cliente só por ele.",
    inputSchema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: [...TIPOS], description: "ip, email, dominio ou dispositivo." },
        valor: { type: "string", description: "O valor a consultar, como o dono informou." },
      },
      required: ["tipo", "valor"],
      additionalProperties: false,
    },
    annotations: { title: "Consultar indicador", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async executar(args) {
      const cfg = configuracao();
      const hash = hashLocal(args.tipo, args.valor);
      const r = validarResultado(await chamarApi(cfg, "POST", "/v1/consulta", { tipo: args.tipo, hash }, { segredos: [args.valor] }));
      const { estruturado, texto } = resumoConsulta(args.tipo, hash, r);
      return { texto, estruturado };
    },
  },
  {
    name: "consultar_varios",
    title: "Consultar vários indicadores de uma vez",
    description:
      `Consulta até ${MAX_LOTE} indicadores de uma vez (por exemplo o e-mail, o IP e o domínio de um mesmo pedido). ` +
      "Funciona como consultar_indicador para cada item: só o hash sai da máquina. Se um item for inválido, só ele dá erro e os outros seguem. " +
      "O resultado é uma pista, não uma prova.",
    inputSchema: {
      type: "object",
      properties: { itens: { type: "array", items: ITEM_SCHEMA, minItems: 1, maxItems: MAX_LOTE, description: `De 1 a ${MAX_LOTE} indicadores.` } },
      required: ["itens"],
      additionalProperties: false,
    },
    annotations: { title: "Consultar vários indicadores", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async executar(args) {
      const cfg = configuracao();
      if (!Array.isArray(args.itens) || args.itens.length === 0) throw falha('O campo "itens" deve ser uma lista com pelo menos 1 item.');
      if (args.itens.length > MAX_LOTE) throw falha(`No máximo ${MAX_LOTE} itens por chamada; recebi ${args.itens.length}. Divida em duas chamadas.`);
      const resultados = [];
      const linhas = [];
      let comErro = 0;
      for (const [i, item] of args.itens.entries()) {
        const n = i + 1;
        try {
          if (!item || typeof item !== "object") throw falha("O item deve ter tipo e valor.");
          const hash = hashLocal(item.tipo, item.valor);
          const r = validarResultado(await chamarApi(cfg, "POST", "/v1/consulta", { tipo: item.tipo, hash }, { segredos: [item.valor] }));
          const { estruturado, texto } = resumoConsulta(item.tipo, hash, r);
          resultados.push({ item: n, ...estruturado });
          linhas.push(`${n}. ${texto}`);
        } catch (e) {
          if (!(e instanceof ErroTool)) throw e;
          comErro++;
          const msg = redigir(e.message, [item?.valor]);
          resultados.push({ item: n, tipo: typeof item?.tipo === "string" ? item.tipo : null, erro: msg });
          linhas.push(`${n}. Erro: ${msg}`);
        }
      }
      return {
        texto: `${args.itens.length} item(ns) consultado(s), ${comErro} com erro.\n${linhas.join("\n")}`,
        estruturado: { resultados },
        erro: comErro === args.itens.length,
      };
    },
  },
  {
    name: "reportar_fraude",
    title: "Reportar uma fraude (exige chave e confirmação)",
    description:
      "Reporta à Rede de Confiança que um e-mail, IP, domínio ou dispositivo esteve ligado a uma fraude real que o lojista viveu (por exemplo um chargeback confirmado). " +
      "Exige a chave de relator (RDC_CHAVE). Uma denúncia errada prejudica uma pessoa de verdade, então: " +
      "SEM `confirmar: true` esta ferramenta NÃO envia nada e só mostra o que enviaria; mostre isso ao dono do negócio, explique e só chame de novo com `confirmar: true` depois de ele dizer sim. " +
      "Nunca coloque CPF, cartão, nome completo ou outro dado pessoal na evidência. Nunca use para vingança ou para uma suspeita sem fato.",
    inputSchema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: [...TIPOS] },
        valor: { type: "string", description: "O indicador a reportar." },
        categoria: { type: "string", enum: [...CATEGORIAS], description: "chargeback, cartao_testado, conta_falsa, phishing, bot_abuso ou outro." },
        evidencia: { type: "string", maxLength: 280, description: "Opcional, até 280 caracteres, sem dado pessoal (ex.: 'chargeback do pedido 1234 em 03/10')." },
        confirmar: { type: "boolean", description: "Só true depois que o dono do negócio aprovou o envio. Sem isso, nada é enviado." },
      },
      required: ["tipo", "valor", "categoria"],
      additionalProperties: false,
    },
    annotations: { title: "Reportar fraude", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async executar(args) {
      const cfg = configuracao();
      if (!cfg.chave) {
        throw falha(
          "Reportar exige uma chave de relator, e RDC_CHAVE não está configurada. " +
            "Para pedir uma, use a ferramenta pedir_chave_de_relator; depois de aprovada, coloque a chave em RDC_CHAVE na configuração deste servidor MCP.",
        );
      }
      const hash = hashLocal(args.tipo, args.valor);
      if (!CATEGORIAS.includes(args.categoria)) throw falha(`Categoria inválida. Use uma destas: ${CATEGORIAS.join(", ")}.`);
      const evidencia = textoOpcional(args, "evidencia", 280);
      if (evidencia !== undefined && contemDadoPessoal(evidencia)) {
        throw falha(
          "A evidência parece conter CPF ou número de cartão e não foi enviada nem guardada. " +
            "Dado pessoal não entra na Rede de Confiança (LGPD): reescreva sem esses números, só com o fato (ex.: 'chargeback do pedido 1234').",
        );
      }
      if (args.confirmar !== true) {
        const previa = {
          enviado: false,
          tipo: args.tipo,
          categoria: args.categoria,
          hash_parcial: hash.slice(0, 8),
          tem_evidencia: evidencia !== undefined,
          aviso_lgpd: AVISO_LGPD,
        };
        return {
          texto:
            `NADA FOI ENVIADO. Isto é o que seria reportado: ${args.tipo}, categoria ${args.categoria}, código ${hash.slice(0, 8)}…` +
            `${evidencia !== undefined ? ", com a evidência informada" : ", sem evidência"}. ` +
            `A API recebe o valor do indicador para calcular o código e guarda só um hash protegido, nunca o valor. ${AVISO_LGPD} ` +
            "Mostre isto ao dono do negócio e pergunte se confirma. Se ele disser sim, chame reportar_fraude de novo com `confirmar: true`.",
          estruturado: previa,
        };
      }
      const corpo = { tipo: args.tipo, valor: args.valor, categoria: args.categoria };
      if (evidencia !== undefined) corpo.evidencia = evidencia;
      // Sem retry: um relato repetido por timeout ambíguo cairia em 409, mas não vale arriscar.
      const r = await chamarApi(cfg, "POST", "/v1/relatos", corpo, { autenticado: true, segredos: [args.valor] });
      return {
        texto: `Relato enviado e registrado (${args.tipo}, ${args.categoria}, código ${hash.slice(0, 8)}…). Protocolo: ${typeof r.id === "string" ? r.id : "sem id"}. Ele passa a contar no score, com o peso da sua reputação.`,
        estruturado: { enviado: true, id: typeof r.id === "string" ? r.id : null, tipo: args.tipo, categoria: args.categoria, hash_parcial: hash.slice(0, 8) },
      };
    },
  },
  {
    name: "contestar_indicador",
    title: "Contestar um indicador marcado por engano",
    description:
      "Para quem acha que seu e-mail, IP, domínio ou dispositivo foi marcado por engano (um cliente barrado, o dono de um site, alguém que perdeu o acesso à própria conta). " +
      "Abre uma contestação que um moderador humano analisa; abrir não muda o score por si só. Só o código (hash) do valor é enviado, nunca o valor. " +
      "Explique o motivo com fatos (mínimo 10 caracteres) e, se quiser resposta, deixe um contato. Não use para disputar cobrança.",
    inputSchema: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: [...TIPOS] },
        valor: { type: "string", description: "O indicador contestado." },
        motivo: { type: "string", minLength: 10, maxLength: 500, description: "Por que a marcação está errada (10 a 500 caracteres, sem CPF nem cartão)." },
        contato: { type: "string", maxLength: 200, description: "Opcional: e-mail ou telefone para a moderação responder." },
      },
      required: ["tipo", "valor", "motivo"],
      additionalProperties: false,
    },
    annotations: { title: "Contestar indicador", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async executar(args) {
      const cfg = configuracao();
      const hash = hashLocal(args.tipo, args.valor);
      const motivo = textoObrigatorio(args, "motivo", 500);
      if (motivo.trim().length < 10) throw falha('O "motivo" precisa ter pelo menos 10 caracteres.');
      if (contemDadoPessoal(motivo)) {
        throw falha("O motivo parece conter CPF ou número de cartão e não foi enviado. Reescreva sem esses números.");
      }
      const contato = textoOpcional(args, "contato", 200);
      const corpo = { tipo: args.tipo, hash, motivo };
      if (contato !== undefined) corpo.contato = contato;
      const r = await chamarApi(cfg, "POST", "/v1/contestacoes", corpo, { segredos: [args.valor] });
      return {
        texto: `Contestação aberta (protocolo ${typeof r.id === "string" ? r.id : "sem id"}). Um moderador vai analisar; enquanto isso o score não muda por causa dela.`,
        estruturado: { aberta: true, id: typeof r.id === "string" ? r.id : null, tipo: args.tipo, hash_parcial: hash.slice(0, 8) },
      };
    },
  },
  {
    name: "pedir_chave_de_relator",
    title: "Pedir uma chave para poder reportar fraudes",
    description:
      "Pede à moderação da instância uma chave de relator, necessária para reportar fraudes (consultar não precisa de chave). " +
      "Envia o nome, o contato e o endereço da loja do dono; confirme com ele antes, pois são dados de contato. " +
      "Um moderador avalia o pedido; nenhuma chave é criada na hora. Quando aprovada, a chave chega pelo contato informado e vai na variável RDC_CHAVE.",
    inputSchema: {
      type: "object",
      properties: {
        nome: { type: "string", maxLength: 200, description: "Nome da loja ou do responsável." },
        contato: { type: "string", maxLength: 200, description: "E-mail ou telefone para a moderação responder." },
        loja_url: { type: "string", maxLength: 300, description: "Endereço http(s) da loja, para a moderação conferir que ela existe." },
      },
      required: ["nome", "contato", "loja_url"],
      additionalProperties: false,
    },
    annotations: { title: "Pedir chave de relator", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async executar(args) {
      const cfg = configuracao();
      const nome = textoObrigatorio(args, "nome", 200);
      const contato = textoObrigatorio(args, "contato", 200);
      const lojaUrl = textoObrigatorio(args, "loja_url", 300);
      let u;
      try {
        u = new URL(lojaUrl);
      } catch {
        u = null;
      }
      if (!u || !["http:", "https:"].includes(u.protocol)) throw falha('"loja_url" precisa ser um endereço http:// ou https://.');
      if (contemDadoPessoal(lojaUrl)) throw falha('"loja_url" parece conter CPF ou número de cartão.');
      const r = await chamarApi(cfg, "POST", "/v1/relatores/solicitacoes", { nome, contato, loja_url: lojaUrl });
      return {
        texto: `Pedido enviado (protocolo ${typeof r.id === "string" ? r.id : "sem id"}). Um moderador vai avaliar; a chave não é criada na hora e chega pelo contato informado. Limite: 3 pedidos por hora por rede.`,
        estruturado: { enviado: true, id: typeof r.id === "string" ? r.id : null },
      };
    },
  },
  {
    name: "como_interpretar_o_score",
    title: "Como interpretar o score",
    description:
      "Explica em linguagem simples como ler o score da Rede de Confiança: faixas, tetos, meia-vida, limites e o que ele NÃO é. " +
      "Use quando o dono perguntar 'o que significa esse número?' ou antes de agir com base em um resultado. Não faz chamada de rede.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Como interpretar o score", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async executar() {
      return { texto: GUIA, estruturado: { faixas: { desconhecido: "0 a 24", suspeito: "25 a 74", alto_risco: "75 a 100" } } };
    },
  },
];

const GUIA = [
  "Como ler o score da Rede de Confiança (0 a 100):",
  "- 0 a 24, desconhecido: poucos ou nenhum relato. NÃO significa confiável; significa só que a rede não sabe.",
  "- 25 a 74, suspeito: relatos de mais de um lojista. Vale revisão manual e confirmação por outro canal.",
  "- 75 a 100, alto risco: exige pelo menos 3 lojistas diferentes, ao menos 1 verificado pela moderação (para IP, 5). Mesmo assim, revise antes de recusar.",
  "Tetos contra abuso: com 1 lojista confiável o score não passa de 24; com 2, não passa de 49. Contas com menos de 7 dias não pesam. Muitas contas falsas sem ninguém verificado ficam no máximo em suspeito.",
  "Os relatos esvaziam com o tempo: metade do peso a cada 90 dias, e somem após 24 meses.",
  "O que NÃO é: não é lista de culpados, não é prova, não é decisão automática. Um IP pode ser compartilhado (empresa, 4G, VPN) e um e-mail pode ter sido roubado: o indicador não é a pessoa.",
  "Boa prática: use como um dos sinais, junte com o resto do pedido, e na dúvida confirme com o cliente por outro canal. Quem acha que foi marcado por engano pode contestar.",
].join("\n");

// ---------- JSON-RPC ----------

const erroRpc = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const okRpc = (id, result) => ({ jsonrpc: "2.0", id, result });

async function chamarTool(params) {
  if (!params || typeof params !== "object" || typeof params.name !== "string") {
    return { rpcErro: [-32602, 'Parâmetros inválidos: falta "name".'] };
  }
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return { rpcErro: [-32602, `Ferramenta desconhecida: ${params.name}`] };
  const args = params.arguments ?? {};
  if (typeof args !== "object" || Array.isArray(args)) return { rpcErro: [-32602, '"arguments" deve ser um objeto.'] };
  try {
    const r = await tool.executar(args);
    const res = { content: [{ type: "text", text: r.texto }], structuredContent: r.estruturado };
    if (r.erro) res.isError = true;
    return { result: res };
  } catch (e) {
    const texto = e instanceof ErroTool ? redigir(e.message) : "Erro interno inesperado no servidor MCP. Nada foi enviado se o erro veio antes da chamada à API; tente de novo.";
    if (!(e instanceof ErroTool)) log("erro interno em", tool.name, redigir(e?.name ?? "Error"));
    return { result: { content: [{ type: "text", text: texto }], isError: true } };
  }
}

async function tratarMensagem(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return erroRpc(msg && typeof msg === "object" && "id" in msg ? msg.id ?? null : null, -32600, "Requisição JSON-RPC inválida.");
  }
  const ehNotificacao = !("id" in msg);
  const { id, method, params } = msg;
  if (ehNotificacao) return null; // notifications/initialized, cancelled etc.: nada a responder
  switch (method) {
    case "initialize": {
      const pedida = params?.protocolVersion;
      const versao = VERSOES_SUPORTADAS.includes(pedida) ? pedida : VERSAO_ESTAVEL;
      return okRpc(id, {
        protocolVersion: versao,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rede-de-confianca", title: "Rede de Confiança", version: VERSAO_SERVIDOR },
        instructions:
          "Consulte indicadores (e-mail, IP, domínio, dispositivo) antes de aprovar pedidos suspeitos. O resultado é pista, não prova: nunca bloqueie sozinho. " +
          "Reportar exige chave e a confirmação explícita do dono do negócio.",
      });
    }
    case "ping":
      return okRpc(id, {});
    case "tools/list":
      return okRpc(id, {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const r = await chamarTool(params);
      return r.rpcErro ? erroRpc(id, r.rpcErro[0], r.rpcErro[1]) : okRpc(id, r.result);
    }
    default:
      return erroRpc(id, -32601, `Método não encontrado: ${method}`);
  }
}

function escrever(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function tratarLinha(linha) {
  let msg;
  try {
    msg = JSON.parse(linha);
  } catch {
    escrever(erroRpc(null, -32700, "JSON inválido."));
    return;
  }
  if (Array.isArray(msg)) {
    if (msg.length === 0) return escrever(erroRpc(null, -32600, "Lote vazio."));
    const respostas = (await Promise.all(msg.map(tratarMensagem))).filter(Boolean);
    if (respostas.length) escrever(respostas);
    return;
  }
  const resposta = await tratarMensagem(msg);
  if (resposta) escrever(resposta);
}

const pendentes = new Set();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (linha) => {
  if (!linha.trim()) return;
  const p = tratarLinha(linha).catch((e) => log("falha ao tratar mensagem:", e?.name ?? "Error")).finally(() => pendentes.delete(p));
  pendentes.add(p);
});
rl.on("close", async () => {
  await Promise.allSettled([...pendentes]);
  process.exit(0);
});
log(`pronto (v${VERSAO_SERVIDOR}); a API só é lida de RDC_API_URL quando uma ferramenta é chamada`);
