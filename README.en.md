<div align="center">

<img src="docs/img/banner.svg" alt="Rede de Confiança (Trust Network): verified merchants report fraud, anyone queries an explainable score" width="100%">

# Rede de Confiança (Trust Network)

**Fraud that one merchant finds out alone, the network finds out together.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node 22](https://img.shields.io/badge/node-22-339933)](https://nodejs.org)

[Português](README.md)

</div>

An open network where **registered merchants report e-commerce fraud**
(chargeback, tested cards, fake accounts, phishing, bots) by **IP, email, domain
or device**, and **anyone can query** a 0-100 score built from public, tested
rules. An initiative of [Genesis Innovation](https://genesisinnovation.io), open
source. The documentation is in Brazilian Portuguese; the code and API are
language-neutral.

## How it works

- **Merchants with a reporter key report** an indicator (`ip`, `email`, `dominio`,
  `dispositivo`) with a category. A moderator reviews and issues each key.
- **The server stores only a hash**: `HMAC-SHA256(PEPPER, sha256("rdc:v1:" + type + ":" + normalized))`.
  The raw value is never stored or logged and never travels in a URL. No national
  ID numbers (CPF), no card numbers: they are rejected on input.
- **Anyone queries** and gets `score`, `nivel` (`desconhecido` / `suspeito` /
  `alto_risco`), distinct reporter count and last report date. Never the reports
  or the reporters.
- **Anyone can contest** a flag. Only a moderator's `procedente` decision removes
  reports from the score.

### The score

`score = round(100 * (1 - exp(-sum / 1.5)))`, where each report weighs
category weight x 90-day half-life decay x reporter reputation. A pure, deterministic
function in `src/pontuacao.js`, one test per rule.

- Accounts under **7 days old weigh 0**.
- A new reporter starts at reputation **0.2** and only rises past 0.3 once
  corroborated by a **verified** reporter. New accounts cannot corroborate new accounts.
- **One effective reporter caps the score at 24; two cap it at 49.**
- `alto_risco` (75+) needs **3 reporters** with reputation of 0.3 or more,
  **at least one verified by a moderator**; otherwise the cap is 74. For IPs it
  needs 5 effective reporters.
- Result: any number of fake accounts without a verified reporter stays at
  `suspeito` at most (tested in `tests/pontuacao.test.mjs` and `tests/redteam.test.mjs`).

Full spec: [docs/CONTRATO.md](docs/CONTRATO.md) (Portuguese).

## Try it

```sh
curl -X POST https://YOUR-INSTANCE/v1/consulta \
  -H "Content-Type: application/json" \
  -d '{"tipo":"email","valor":"someone@example.com"}'
```

There is **no public reference instance yet**; run your own (Cloudflare Workers + D1,
Node 22, no npm dependencies) by following "Rodar local" in the [README](README.md#rodar-local),
and run the tests with `node --test`.

## Use it with your AI agent (MCP)

`mcp/server.mjs` is a zero-dependency [MCP](https://modelcontextprotocol.io) server so your assistant can query, report and contest for you; the queried value is hashed locally and only the hash leaves your machine. Setup (in Portuguese): [mcp/README.md](mcp/README.md). Still open: remote HTTP server, hash-only reporting, npm package.

## What it is not

Not a blocklist of guilty people, never proof, never an automatic block. An
indicator is not a person: an IP can be shared, an email can be stolen. We
recommend human review before any refusal. It is not a firewall or a complete
antifraud product either: it is a signal source.

## How to help

- **Merchants:** request a reporter key; more independent merchants make the score more trustworthy.
- **Developers:** open an issue or a small PR with a test that fails without the
  change. See [CONTRIBUTING.md](CONTRIBUTING.md). Open roadmap items include a
  client SDK, a store-platform plugin, a reference instance, and validation
  against a real D1 database (see the roadmap in the [Portuguese README](README.md#roadmap)).
- **Moderators, privacy/legal people:** see [docs/MODERACAO.md](docs/MODERACAO.md),
  [docs/GOVERNANCA.md](docs/GOVERNANCA.md) and [docs/PRIVACIDADE.md](docs/PRIVACIDADE.md).
  The legal basis is still marked "to be validated with a lawyer".
- **Talk to us:** [WhatsApp](https://wa.me/5521995988404) (Thiago, Genesis Innovation).
  Good ideas become public issues.

English is welcome in issues and PRs ([CONTRIBUTING.md](CONTRIBUTING.md)). Security
reports: [SECURITY.md](SECURITY.md).

## License

Code (`src/`, `mcp/`, `tests/`, `schema/`, `wrangler.toml`): [Apache-2.0](LICENSE).
Documentation (`docs/`, READMEs): [CC0 1.0](LICENSE-DOCS).
Copyright 2026 Genesis Innovation.
