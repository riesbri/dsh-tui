---
'@dshline/dshline': minor
---

`/connect` can now declare a custom Harness route — a self-hosted server, a private gateway, a localhost OpenAI-compatible endpoint — through the `llm-pi-ai` configuration domain, matching the scope Harness's own Models web UI exposes. `+ Add custom provider` walks through endpoint, protocol, optional key, and model catalog (fetched via `ctx.llm.discoverModels()` or entered by hand); an existing declared route gains an `Edit endpoint and models` action. Connect now also converges on `settings/updated`, `settings/document-updated`, `credentials/reference-updated`, and `credentials/record-updated`, so an edit made from the web Models page or a hand-edited `settings.yaml` no longer needs `ctrl-r`. No provider-specific dshline code, no network requests, and no new secret store: every write goes through the same `ctx.settings`/`ctx.credentials` seams the rest of Connect already uses.
