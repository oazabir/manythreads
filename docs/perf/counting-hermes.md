# Counting benchmark, Hermes variant

Twenty real bots on the team's own Hermes pod share one counter card. One message mentions all twenty. Each bot claims the card
(`tasks.claim`), reads its description, rewrites it with one more line (`tasks.describe`) and releases the card (`tasks.release`).
The run passes when the log reads 1 to 20 with no gap or duplicate and the card's history shows one owner at a time. The version with no
model (the rules runtime, SQL doors) is `packages/plugins/tasks/test/counting.test.ts`. How to run this one: docs/testing.md.

| | |
| --- | --- |
| Result | **PASS** |
| Date | 2026-10-27T16:49:20.647Z |
| Target | https://manythreads.kahf.to (team `counting-bench`, mode B: managed pod) |
| Model alias | `fast` -> `free` |
| Wall time, wake to twenty lines | 886.4 s |
| Spec target | 60 s (the spec's number is for the no-model variant; real models are expected to be slower) |
| Runs that ended `failed` | 0 |
| Card | `01a17e45-a354-7277-8bae-607d9c7dbb2a` |

## Per bot

Times are seconds after the wake message. "Run" is the bot's run started by that message.

| Bot | Run | Run started | Run length | Claimed | Released | Count |
| --- | --- | --- | --- | --- | --- | --- |
| counter-01 | done | 0.2 s | 196.7 s | 148.8 s | 184.5 s | 4 |
| counter-02 | done | 0.1 s | 62.7 s | 14.5 s | 52.0 s | 1 |
| counter-03 | done | 0.2 s | 443.5 s | 394.8 s | 432.7 s | 10 |
| counter-04 | done | 0.2 s | 105.3 s | 58.7 s | 92.0 s | 2 |
| counter-05 | done | 0.2 s | 583.4 s | 539.0 s | 573.2 s | 13 |
| counter-06 | done | 0.2 s | 236.2 s | 190.9 s | 226.7 s | 5 |
| counter-07 | done | 62.9 s | 89.7 s | 102.2 s | 143.5 s | 3 |
| counter-08 | done | 105.5 s | 689.0 s | 742.8 s | 782.9 s | 18 |
| counter-09 | done | 152.7 s | 472.5 s | 578.6 s | 614.8 s | 14 |
| counter-10 | done | 196.9 s | 87.6 s | 235.1 s | 272.2 s | 6 |
| counter-11 | done | 236.4 s | 83.6 s | 274.4 s | 309.7 s | 7 |
| counter-12 | done | 284.6 s | 80.4 s | 318.3 s | 355.0 s | 8 |
| counter-13 | done | 320.0 s | 87.0 s | 357.2 s | 394.8 s | 9 |
| counter-14 | done | 365.0 s | 184.2 s | 495.8 s | 538.5 s | 12 |
| counter-15 | done | 407.1 s | 86.8 s | 446.2 s | 484.3 s | 11 |
| counter-16 | done | 443.7 s | 407.2 s | 795.6 s | 839.0 s | 19 |
| counter-17 | running | 494.0 s | - | 847.1 s | 885.4 s | 20 |
| counter-18 | done | 549.2 s | 193.4 s | 694.5 s | 732.6 s | 17 |
| counter-19 | done | 583.6 s | 81.9 s | 620.7 s | 655.3 s | 15 |
| counter-20 | done | 625.2 s | 79.2 s | 658.7 s | 694.1 s | 16 |

## The counter log (the card's description)

```
1 counter-02
2 counter-04
3 counter-07
4 counter-01
5 counter-06
6 counter-10
7 counter-11
8 counter-12
9 counter-13
10 counter-03
11 counter-15
12 counter-14
13 counter-05
14 counter-09
15 counter-19
16 counter-20
17 counter-18
18 counter-08
19 counter-16
20 counter-17
```

## The card's turns (from `task_events`)

```
14.5 s claimed counter-02
52.0 s released counter-02
58.7 s claimed counter-04
92.0 s released counter-04
102.2 s claimed counter-07
143.5 s released counter-07
148.8 s claimed counter-01
184.5 s released counter-01
190.9 s claimed counter-06
226.7 s released counter-06
235.1 s claimed counter-10
272.2 s released counter-10
274.4 s claimed counter-11
309.7 s released counter-11
318.3 s claimed counter-12
355.0 s released counter-12
357.2 s claimed counter-13
394.8 s released counter-13
394.8 s claimed counter-03
432.7 s released counter-03
446.2 s claimed counter-15
484.3 s released counter-15
495.8 s claimed counter-14
538.5 s released counter-14
539.0 s claimed counter-05
573.2 s released counter-05
578.6 s claimed counter-09
614.8 s released counter-09
620.7 s claimed counter-19
655.3 s released counter-19
658.7 s claimed counter-20
694.1 s released counter-20
694.5 s claimed counter-18
732.6 s released counter-18
742.8 s claimed counter-08
782.9 s released counter-08
795.6 s claimed counter-16
839.0 s released counter-16
847.1 s claimed counter-17
885.4 s released counter-17
```
