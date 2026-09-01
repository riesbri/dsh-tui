---
'@dshline/dshline': patch
---

`/model` now clears a carried reasoning effort when the target model does not advertise it, preventing model switches from failing with `UNSUPPORTED_REASONING_EFFORT`. `/reasoning default` can also clear a stale effort on models that advertise no reasoning levels.
