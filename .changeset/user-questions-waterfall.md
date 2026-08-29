---
'@dshline/dshline': patch
---

`ask_user_question` now answers correctly against both Harness's older single-provider `ctx.userQuestions.registerProvider()` and its current Agent-scoped waterfall registration, detected at runtime rather than by package version. Presentation is unchanged.
