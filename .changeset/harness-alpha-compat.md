---
'@dshline/dshline': patch
---

dshline now truthfully supports Harness `0.1.2-alpha.2`, proven by a dedicated `Harness compatibility · Alpha` CI lane (npm `alpha`, alongside Minimum/Released/Edge) rather than inferred from version strings. Peer ranges for the Harness line widen to `^0.1.1-rc.2 || ^0.1.2-alpha.2`; Minimum stays `0.1.1-rc.2`.

The settings seam (`@deepseek-ai/dsh-settings`) moved its registration from a free function to an instance method between these lines; the theme's settings wiring now bridges both shapes at runtime, the same way the existing user-questions bridge does, and preserves the original "an invalid stored value falls back to the composition entry" behaviour under both. `@deepseek-ai/dsh-atomic-write` stays a direct dependency unchanged — it carries no runtime import of cordis or dsh-invariants, so it is not cohort-sensitive.
