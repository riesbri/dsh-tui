---
"@dshline/dshline": minor
---

Remember the theme in Harness's own settings document.

`/theme` now registers a `dshline` settings namespace and writes the choice into its user layer, so the theme is stored where every other Harness setting is. A deployment composes a default in the `dshline` row of `cordis.patch.yml`, a reader's `settings.yaml` overrides it, and Harness owns the layering, the schema, the validation, and the change feed.

**It applies live.** Editing that section by hand while a session runs repaints the window; rows already committed keep the colours they were printed with, as everything committed does.

A theme id no shipped palette has is refused by the schema rather than stored, so a session cannot reopen on a palette that does not exist. A profile that mounts no settings provider still runs on whatever it was composed with — only saving is unavailable, and the command says so.

Adds `@deepseek-ai/dsh-settings` as a peer dependency and `@deepseek-ai/schemastery` as a dependency, matching how `@deepseek-ai/dsh-agent-presets` consumes the same service.
