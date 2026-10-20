// Guardas de documentação: o que o README manda copiar tem que funcionar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { hashIndicador } from "../src/normalizar.js";

const raiz = new URL("../", import.meta.url);
const docs = [
  "README.md",
  "README.en.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "mcp/README.md",
  ".github/pull_request_template.md",
  // só .md: docs/img/ é pasta de imagens, não documento de texto
  ...readdirSync(new URL("docs/", raiz)).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
];

test("nenhum comando copiável manda rodar `node --test tests/`, que falha no Node 22", () => {
  for (const arquivo of docs) {
    const linhas = readFileSync(new URL(arquivo, raiz), "utf8").split("\n");
    const ruins = linhas.filter((l) => /^\s*node --test tests\/?\s*$/.test(l));
    assert.deepEqual(ruins, [], `${arquivo} manda rodar node --test tests/`);
  }
});

test("o exemplo de hash em shell do README dá o mesmo hash que hashIndicador para valor já normalizado", () => {
  const readme = readFileSync(new URL("README.md", raiz), "utf8");
  const m = /printf '%s' "(rdc:v1:email:[^"]+)"/.exec(readme);
  assert.ok(m, "README perdeu o exemplo de hash em shell");
  const pelaFormula = createHash("sha256").update(m[1]).digest("hex");
  assert.equal(pelaFormula, hashIndicador("email", "fulano@exemplo.com"));
});
