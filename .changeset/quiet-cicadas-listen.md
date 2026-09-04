---
'@dshline/dshline': minor
---

dshline now emits one terminal BEL when it presents a Harness question or an
owned approval request. `dshline.attentionBell` defaults to `true` and can be
set to `false` in Harness settings when the terminal's bell should remain
available to other programs but not this frontend.
