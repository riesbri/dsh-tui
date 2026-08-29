---
'@dshline/dshline': patch
---

`ask_user_question` now answers correctly against both the Harness 0.1.1 `ctx.userQuestions.registerProvider()` single-provider slot and the 0.1.2+ Agent-scoped Cordis waterfall (`ctx.on('user-questions/request', …)`) that replaced it, detected at runtime by whether `registerProvider` exists rather than by package version. Plan review, generic questions, and abort handling are unchanged; dshline always claims a request under the new registration mode, since it has no other answerer to defer to.
