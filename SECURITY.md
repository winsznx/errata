# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and what an attacker could do with it. The maintainer aims to acknowledge a report within three days and to share a plan or fix once the issue is understood.

## Supported versions

Only the `main` branch is maintained. Fixes land there and are deployed to the hosted demo.

## Scope

In scope:

- The agent runtime API in `apps/runtime`: authorization between demo workspaces, the read-only recorded run, idempotency, and the domain guards that decide what agents may record.
- The web app in `apps/web`, including the public research pages.
- Handling of SEC filings: source allow-listing, stored-byte hashing, and treating filing and note text as data rather than instructions.

Out of scope:

- Findings that need a stolen session cookie or access to the host.
- Rate limits of the third-party model provider.
- The synthetic research notes, publisher and recipients, which are fictional by design.

## How the project handles secrets

API keys and the SEC contact address live only in environment variables on the host. They are never committed; `.env` files are ignored and `.env.example` holds placeholders. Demo sessions are random tokens stored hashed, and the event stream uses short-lived signed tickets.
