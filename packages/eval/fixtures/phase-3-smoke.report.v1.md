# Eval Report: phase-3-smoke

Mode: offline. Cases: 4.
Provider-observed cost: incomplete (0 turns).

| Strategy | Estimated cost USD | Quality proxy | Switches | Cache misses |
|---|---:|---:|---:|---:|
| router | 0.063200 | 0.770000 | 0 | 0 |
| always-frontier | 0.142240 | 0.950000 | 0 | 0 |
| always-cheap | 0.000000 | 0.650000 | 0 | 0 |

## Selections

| Strategy | Session | Turn | Model | Via | Reason |
|---|---|---|---|---|---|
| router | verification-session | verification-1 | fixture/free | free-first | free-first free for tier simple |
| router | planning-session | planning-1 | fixture/frontier | quality | quality frontier for tier medium |
| router | implementation-session | implementation-1 | fixture/free | free-first | free-first free for tier simple |
| router | implementation-session | implementation-2 | fixture/free | free-first | free-first free for tier simple |
| always-frontier | verification-session | verification-1 | fixture/frontier | always-frontier | highest eligible coding index |
| always-frontier | planning-session | planning-1 | fixture/frontier | always-frontier | highest eligible coding index |
| always-frontier | implementation-session | implementation-1 | fixture/frontier | always-frontier | highest eligible coding index |
| always-frontier | implementation-session | implementation-2 | fixture/frontier | always-frontier | highest eligible coding index |
| always-cheap | verification-session | verification-1 | fixture/free | always-cheap | lowest eligible blended price |
| always-cheap | planning-session | planning-1 | fixture/free | always-cheap | lowest eligible blended price |
| always-cheap | implementation-session | implementation-1 | fixture/free | always-cheap | lowest eligible blended price |
| always-cheap | implementation-session | implementation-2 | fixture/free | always-cheap | lowest eligible blended price |

## Gates

- Completeness: passed (all replay turns are complete)
- Live quality: not passed (live quality is unproven by offline replay)
- Estimated cost: passed (router cost savings 55.57%)
