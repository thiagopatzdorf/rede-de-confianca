-- Rede de Confiança, esquema v1.1 (migração sobre 001_inicial.sql).
-- Arquivo separado, e não edição do 001, para quem já aplicou o v1 poder subir.
-- (Sem dado em produção até a v1.2: `verificado` e `desativado_em` foram para o 001.)

-- Relator suspenso (403 ao reportar) é diferente de chave revogada
-- (`ativo = 0`, 401): suspender é reversível e não invalida a chave.
ALTER TABLE relatores ADD COLUMN suspenso_em INTEGER;

-- Tombstone: o relato removido continua na tabela (para o dedupe e a
-- auditoria saberem que existiu), mas sai do score e perde a evidência.
ALTER TABLE relatos ADD COLUMN removido_em INTEGER;
ALTER TABLE relatos ADD COLUMN removido_motivo TEXT
  CHECK (removido_motivo IS NULL OR removido_motivo IN ('malicioso', 'titular', 'expirado'));

-- Contestação ganha o estado `em_analise` e `criado_em`. O SQLite não altera
-- CHECK, então a tabela é recriada e copiada.
CREATE TABLE contestacoes_v11 (
  id             TEXT PRIMARY KEY,
  tipo_indicador TEXT NOT NULL CHECK (tipo_indicador IN ('ip', 'email', 'dominio', 'dispositivo')),
  indicador_hash TEXT NOT NULL,
  motivo         TEXT NOT NULL,
  contato        TEXT,
  estado         TEXT NOT NULL DEFAULT 'aberta'
                 CHECK (estado IN ('aberta', 'em_analise', 'procedente', 'improcedente')),
  criado_em      INTEGER NOT NULL DEFAULT 0,   -- ms epoch; 0 = anterior à v1.1 (desconhecido)
  decidido_em    INTEGER,                      -- ms epoch; NULL enquanto não decidida
  nota           TEXT
);
INSERT INTO contestacoes_v11 (id, tipo_indicador, indicador_hash, motivo, contato, estado, criado_em, decidido_em, nota)
  SELECT id, tipo_indicador, indicador_hash, motivo, contato, estado, COALESCE(decidido_em, 0), decidido_em, nota
    FROM contestacoes;
DROP TABLE contestacoes;
ALTER TABLE contestacoes_v11 RENAME TO contestacoes;
CREATE INDEX IF NOT EXISTS idx_contestacoes_indicador ON contestacoes (tipo_indicador, indicador_hash);
CREATE INDEX IF NOT EXISTS idx_contestacoes_estado ON contestacoes (estado, criado_em);

-- Decisão por relato: guardar aqui, e não em `relatos`, mantém o relato
-- original intacto (auditável) e deixa a decisão valer só para os relatos
-- escolhidos pelo moderador.
CREATE TABLE IF NOT EXISTS relatos_derrubados (
  relato_id      TEXT PRIMARY KEY REFERENCES relatos (id),
  contestacao_id TEXT NOT NULL,
  derrubado_em   INTEGER NOT NULL           -- ms epoch
);

-- Pedido público de chave de relator, à espera de aprovação humana.
CREATE TABLE IF NOT EXISTS solicitacoes_relator (
  id          TEXT PRIMARY KEY,
  nome        TEXT NOT NULL,
  contato     TEXT NOT NULL,
  loja_url    TEXT NOT NULL,
  estado      TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente', 'aprovada', 'recusada')),
  criado_em   INTEGER NOT NULL,
  decidido_em INTEGER,
  relator_id  TEXT,                          -- preenchido na aprovação
  nota        TEXT
);
CREATE INDEX IF NOT EXISTS idx_solicitacoes_estado ON solicitacoes_relator (estado, criado_em);
