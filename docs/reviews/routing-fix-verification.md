
---

## Resolution of the verification findings (2026-10-03)

| # | Finding | Resolution |
|---|---|---|
| N1 | budget-forced downgrades were still blocked by the cache penalty | cache-penalty branch now also exempts `budgetForced`; plan test covers soft pressure + big cache miss |
| N2 | prefer bare ids containing `/` were mis-split (W3 regressed) | `insertPrefer` keeps the bare id (provider "") and `resolveModel` resolves by unique registry id first, then provider/model split; integration test selects `openrouter/xiaomi/mimo` |
| N3 | runtime price recheck used `composed.tier` | now `effectiveTier`; test with a tight quick ceiling |
| N4 | confirm without UI was logged as applied | explicit skipped branch ("confirm required UI; not applied"); integration test |
| N5 | chosen-only history reached 0.917 | chosen contributes 0.2 per event, capped at two events (max +0.4) |
| N6 | cloud auth path captured HOME at module load | `authFile()` resolves at call time |
| T1/T2 | prefer tests pinned the buggy split and never tested resolution | tests now assert the bare-id shape plus an end-to-end selection test |
| T3 | continuation branch had no end-to-end test | integration test asserts the skipped entry and thinking application |
| T4 | the `compass_route` tool was untested | boot captures registered tools; test calls execute with text |
| T5 | stale test name said "chosen stays neutral" | renamed to "chosen is a weak positive" |
| T6 | W1 test uses a synthetic event (acceptable) | pi types confirm `usage.cost.total`; kept, with zero-cost and non-assistant no-op cases |

`npm test` 330 pass, `accept.sh` 8/8, typecheck clean.
