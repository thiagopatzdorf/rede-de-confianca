-- Rede de Confiança, esquema v1 (SQLite / Cloudflare D1).
-- Nunca há coluna para o valor cru de um indicador: só tipo + hash.
-- `indicador_hash` guarda HMAC-SHA256(PEPPER, hash do cliente), não o hash
-- público. Ainda não havia dado em produção quando `verificado`,
-- `desativado_em` e o HMAC entraram: por isso estas mudanças estão editadas
-- aqui e no 002, sem migração. Depois do primeiro deploy, mudança de esquema
-- vira arquivo novo.

CREATE TABLE IF NOT EXISTS relatores (
  id         TEXT PRIMARY KEY,
  nome       TEXT NOT NULL,
  contato    TEXT NOT NULL,
  -- sha256 da chave (256 bits aleatórios, não precisa de pepper); a chave em si
  -- é mostrada uma única vez e não é guardada.
  chave_hash TEXT NOT NULL UNIQUE,
  criado_em  INTEGER NOT NULL,            -- ms epoch
  ativo      INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  -- Dado só pelo moderador (POST /v1/admin/relatores/:id/verificar), depois de
  -- checar que a loja existe. Só verificado, ou quem foi corroborado por um,
  -- corrobora outros relatores: sem isso, contas falsas se promovem entre si.
  verificado INTEGER NOT NULL DEFAULT 0 CHECK (verificado IN (0, 1)),
  -- Quando a chave foi desativada (ativo = 0). Dispara a retenção de 90 dias
  -- de nome e contato (src/expiracao.js).
  desativado_em INTEGER
);

CREATE TABLE IF NOT EXISTS relatos (
  id             TEXT PRIMARY KEY,
  tipo_indicador TEXT NOT NULL CHECK (tipo_indicador IN ('ip', 'email', 'dominio', 'dispositivo')),
  indicador_hash TEXT NOT NULL,
  categoria      TEXT NOT NULL CHECK (categoria IN
                   ('chargeback', 'cartao_testado', 'conta_falsa', 'phishing', 'bot_abuso', 'outro')),
  relator_id     TEXT NOT NULL REFERENCES relatores (id),
  evidencia      TEXT,                    -- nunca devolvida em rota pública
  criado_em      INTEGER NOT NULL         -- ms epoch
);

-- Consulta pública: busca por indicador.
CREATE INDEX IF NOT EXISTS idx_relatos_indicador ON relatos (tipo_indicador, indicador_hash, criado_em);
-- Dedupe de 30 dias: mesmo relator + indicador + categoria.
CREATE INDEX IF NOT EXISTS idx_relatos_dedupe ON relatos (relator_id, indicador_hash, categoria, criado_em);

CREATE TABLE IF NOT EXISTS contestacoes (
  id             TEXT PRIMARY KEY,
  tipo_indicador TEXT NOT NULL CHECK (tipo_indicador IN ('ip', 'email', 'dominio', 'dispositivo')),
  indicador_hash TEXT NOT NULL,
  motivo         TEXT NOT NULL,
  contato        TEXT,
  estado         TEXT NOT NULL DEFAULT 'aberta' CHECK (estado IN ('aberta', 'procedente', 'improcedente')),
  decidido_em    INTEGER,                 -- ms epoch; NULL enquanto aberta
  nota           TEXT
);

CREATE INDEX IF NOT EXISTS idx_contestacoes_indicador ON contestacoes (tipo_indicador, indicador_hash);

-- Contadores de janela fixa para limites de uso. A chave nunca contém IP cru
-- (o worker grava o hash).
CREATE TABLE IF NOT EXISTS limites (
  chave    TEXT NOT NULL,
  janela   INTEGER NOT NULL,              -- número da janela (tempo / duração)
  contagem INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chave, janela)
);
