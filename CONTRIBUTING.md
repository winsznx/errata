# Contributing to Errata

Thanks for taking a look. Issues and pull requests are welcome.

## Set up

Requirements: Node 24, pnpm 12 (through Corepack) and Docker.

```bash
cp .env.example .env      # add GROQ_API_KEY to run the agents
pnpm install
docker compose up -d db
pnpm --filter @errata/runtime dev
pnpm --filter @errata/web dev
```

## Before you open a pull request

Run the same checks CI runs:

```bash
pnpm lint
pnpm -r typecheck
pnpm --filter @errata/runtime test
pnpm test:integration     # needs the database from docker compose
pnpm test:e2e             # starts both apps; needs the database
pnpm errata verify-sources
```

None of these call a model provider.

## What a good change looks like

- Financial values stay exact decimals. Derived figures go through the formula engine, never floating point.
- Agents propose and code decides. A new agent capability should be a tool that calls a domain function, and the domain function enforces the rule.
- Every figure shown to readers is tied to verified evidence. Draft text uses `{{claim:<id>}}` placeholders, never typed numbers.
- Filing and note text is data. Do not add prompts that follow instructions found in it.
- Keep commits focused, and write the message about why the change is needed.

## Data

Filings in `datasets` are exact public bytes from sec.gov with hashes in `datasets/provenance.json`. Research notes, publishers and recipients are synthetic. Please do not add real people, real research or non-public data.

## Code of conduct

Taking part in this project means following the [code of conduct](CODE_OF_CONDUCT.md).
