---
'@dshline/dshline': patch
---

Report the cache-read share to one decimal, and offer it on the status line as `CR`.

`/usage` reported the share in whole percents, so the range it exists for read wrong: a session reusing one prompt sits at ninety-nine-point-something, and every one of those printed as `100%`. It now keeps one decimal. Between an endpoint and that resolution it states a bound rather than moving the value — `>99.9%`, `<0.1%` — so `0%` and `100%` mean exactly none and exactly all of the prompt.

The same figure is available on the status line as one whole `CR 99.8%` segment. It is convenience information, so it is the first thing the body gives up as the terminal narrows — before the graphical context bar — and it is never shortened. It is absent with no `tokenUsage` projection, no prompt tokens, or `/usage off`.

Both readings come from Harness's `tokenUsage` projection through one derivation: `usageBuckets` reads its four numbers, `cacheReadShare` divides two of them, `formatCacheShare` turns the ratio into text. That is deliberately NOT the fold behind the `↑`/`↓` totals, which prices finalized assistant messages because it needs each request's route and time; Harness also counts a retried attempt's usage sample. The two are reported side by side, never divided into each other, and no comment or document claims they agree. `/usage` stays live through the existing projection invalidation and its existing per-paint `inspection()`: no timer, no polling, no refresh key, no second observer, no `tokenMeter.measure()`.
