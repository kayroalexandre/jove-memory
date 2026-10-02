# Automatic threshold calibration

This system uses a decision model to make six kinds of call (see
[ARCHITECTURE.md](ARCHITECTURE.md#3-model-layer-one-key-three-surfaces)). Six of those calls
need a threshold: the number above which the system acts on a decision.

Hand-picked thresholds are guesses. This document describes how they get measured instead.

---

## The problem with a fixed 0.6

A threshold of 0.6 means nothing on its own. Whether 0.6 is right depends on:

- The decision model in use
- The version of that model
- The kind of question being asked
- The cost of a false positive versus a false negative for that specific decision

A threshold tuned for deduplication is wrong for cross-workspace traversal, where being too
eager leaks context you meant to keep separate.

So the system measures each threshold against labeled data and adjusts it, rather than trusting
a constant chosen in advance.

---

## What gets calibrated

| Threshold | Governs | Cost of being too low | Cost of being too high |
| --- | --- | --- | --- |
| `write_gate` | Whether content is stored | Noise accumulates | Valid memory is discarded |
| `rerank` | Which candidates survive | Irrelevant items crowd out relevant ones | Relevant items are dropped |
| `cross_workspace` | Whether another workspace is consulted | Context bleeds across workspaces | Useful cross-workspace context never surfaces |
| `min_similarity` | The vector arm's distance floor | Every search returns K results, so "nothing relevant is stored" and "the index is broken" look identical | Relevant memories are dropped because they sit just under the floor |

### A fourth number that is not a threshold at all

`batch_size` (32) is in the same file because it is the other number people will
want to tune, and because the honest reason not to is worth writing down. It
controls how many texts go in one HTTP request. Lowering it is not faster — it
is more round trips for the same work. Raising it past a provider's limit gets
the whole request rejected, which costs more than any number of successful
batches would have. The only reason to change it is a provider limit this
build has not been told about, and the right response to that is to raise it
to the documented ceiling rather than to experiment.

`embed_dimensions` is here for a different reason and is **not** tunable at
runtime. It is the width of the `vector(3072)` column created in migration
0002. Changing it is a data migration — re-embed every memory — because
`google/gemini-embedding-2` and any successor do not share a vector space
(ADR-005). The client refuses to store a vector of any other width, naming the
model and the offending text, precisely so that "someone edited the config"
cannot become "search returns plausible nonsense".

### On `min_similarity` specifically

This one is not a decision-model question, so the pipeline in the next section
does not produce it. It is measured directly, from `search_runs`, and it is
listed here because it has the same property that matters: a hand-picked
number means nothing on its own.

The reason it exists at all is worth stating, because the default is counter-
intuitive. `minSimilarity` defaults to **null**, which applies no floor, and
that means the vector arm returns the K nearest items to *any* query —
including a query about something entirely absent from memory. A nearest-K
query has no notion of "close enough". The K-th neighbour is returned whether
its similarity is 0.9 or 0.02.

That behaviour is correct for a build whose floor has not been calibrated yet,
and wrong for one where it has. So:

- **null** — no floor. Every search returns K results. The response says so.
- **a number** — a floor, applied in SQL before the LIMIT so the top-K is not
  filled with rows the caller discards.

A floor of zero is a real floor and is *not* the same as no floor: it excludes
the items most unlike the query, which is not the same as excluding nothing.
The code distinguishes them, and so should any caller reading a response.

What gets measured: for each recorded search, the distribution of similarities
among returned items, and the point below which a human-labelled "irrelevant"
item falls. The floor goes just above that, because the cost asymmetry favours
it — a missing result is recoverable by asking again, and a buried one is not.

---

## How calibration works

### 1. Collect labeled observations

Every decision the system makes is logged to the `decisions` table:

```sql
-- every decision call is recorded, not just the applied ones
SELECT operation, noul_score, confidence, was_applied, outcome
FROM decisions
WHERE created_at > now() - interval '30 days';
```

`outcome` is set later, by one of:

- **Explicit feedback:** a client calls `memory_feedback` saying an item was useful or ignored
- **The user reverting an action:** a gate applied, and the item was later deleted
- **Consolidation result:** a proposal that was accepted versus one that was rejected

### 2. Score candidate thresholds

The calibrator sweeps the full range (0.05 to 0.95 in 0.01 steps) against the collected
labeled set and computes, for each step:

- **False-positive rate:** actions taken that `outcome` says were wrong
- **False-negative rate:** correct actions that were not taken
- **Expected cost:** `FP × cost_fp + FN × cost_fn`, where the two costs are set per operation
  (a false cross-workspace leak costs far more than a missed cross-workspace result)

### 3. Pick the minimum

The chosen threshold is the **lowest** step whose expected cost is within tolerance of the
best achievable. Lower is chosen over higher at equal cost because a lower threshold keeps more
options open for a human to act on.

### 4. Propose, do not apply

This is the part that matters for you not having to be involved.

The calibrator **never changes a live threshold**. It:

1. Writes the analysis to a report file
2. Opens (or updates) a GitHub issue titled `calibration: <operation> threshold drift`
3. Includes current value, proposed value, the numbers behind it, and the sample size
4. Stays a **pull request**, never an automatic merge

The threshold only changes when a change is merged.

### 5. You get told once

You are notified when:

| Event | What you see |
| --- | --- |
| A threshold drifts past tolerance | One issue, with the numbers, asking to review |
| Calibration cannot run (not enough data) | One issue, saying so, once — not repeatedly |
| Calibration ran and found nothing worth changing | Nothing. Silence means stable. |

**No notification means no action is needed.** The system is not going to interrupt you to
tell you everything is fine.

---

## Minimum sample sizes

Calibration does not run on small samples, because a threshold fitted to 20 observations is
just as much a guess as a hand-picked value.

| Threshold | Minimum labeled observations |
| --- | --- |
| `write_gate` | 200 |
| `rerank` | 100 |
| `cross_workspace` | 50 |

Below the minimum, the calibrator reports insufficient data and stays quiet. This prevents the
system from reacting to noise.

---

## What the system does when calibration is unavailable

Nothing. The threshold stays at its configured value. Calibration is an improvement loop, never
a dependency. Memory operations do not depend on it.

---

## Safety limits on automatic adjustment

Even when calibration runs:

- **No threshold moves more than 0.10 in one adjustment.** A large jump indicates the model
  changed behavior, which is a problem to investigate, not to compensate for.
- **The `cross_workspace` threshold can only move upward automatically.** Loosening the
  context boundary is a one-way decision and requires explicit human action.
- **Every adjustment is recorded** in the audit log alongside the decision model id and version
  that produced the measurement.

---

## Measured: the write gate against `upstage/solar-decide`, 2026-10-02

103 valid writes, 118 noise writes, threshold 0.60. 221 calls, 0.004845 credits,
3.2s mean latency. Reproduce with `npm run gate:measure`.

```
set        n     min    p10   median    p90     max   mean    stored  proposed
valid     103   0.000  0.001   0.123  0.934  1.000  0.307       26        77
noise     118   0.008  0.015   0.022  0.035  0.089  0.025        0       118
```

### The distributions

```
bucket      valid   noise
0.00-0.05      43     114
0.05-0.10       9       4
0.10-0.20      18       0
0.20-0.30       4       0
0.30-0.50       0       0
0.50-0.70       3       0
0.70-0.90       8       0
0.90-1.01      18       0
```

**The separation is real, and it is above 0.10.** Not one noise item scored above
0.089, and 51 valid items scored above 0.10 with a clean staircase to 1.0. Any
threshold between 0.09 and 0.10 admits zero noise.

**52 of 103 valid items scored below 0.10 — the same range as noise.** That is the
finding, and it is not a threshold problem.

### Why the threshold is not the thing to change

Sweeping every midpoint for the minimum of `valid demoted + noise admitted`:

| Threshold | Valid demoted | Noise admitted |
| --- | --- | --- |
| 0.60 (in force) | 77 of 103 | 0 of 118 |
| 0.044 (best this data) | 40 of 103 | 6 of 118 |

Lowering the threshold trades a review queue nobody will read for a smaller
review queue plus noise in the corpus. Neither is a fix.

The 52 items the model cannot separate from noise are the interesting ones. They are
short declarative facts — "the user has a standing desk and it is 118cm high", "the
user's laptop is a ThinkPad T14" — with no indication that the user wanted them
remembered. The current instruction tells the model to reject "content the assistant
already knows or can look up", and a bare fact about a laptop is arguably exactly
that.

So the question is underspecified, not the number. Three ways to fix it, none of
them a threshold change:

1. **Say what "worth remembering" means in this system.** The instruction currently
   defines it by exclusion (not chatter, not lookable-up, not asked). A positive
   definition — a durable fact about the user that changes how a later answer should
   be given — is a different question.
2. **Let the caller's intent count.** `memory_write` knows whether this came from an
   explicit "remember this". A caller-supplied signal is not the model guessing at
   intent from a fragment of text.
3. **Re-measure with realistic input.** 103 hand-written items are not what a memory
   system receives. Phase 9 migrates real memory, and the honest measurement is
   against that corpus, not against a list written to be unambiguous.

### What was not done

No threshold was changed. This document is explicit that a calibration number is a
proposal that opens a pull request, and that a number produced by one measurement on a
synthetic corpus is not a number to act on. The measurement is recorded so the next one
can be compared against it.

### Two operational notes from the same run

- **3.2s mean latency per decision.** On a write path that is the dominant cost of
  remembering something, and it is spent before the write completes. Worth measuring
  on a real corpus before deciding it is acceptable; a caller that wants a fast
  acknowledgement may need to write first and gate after.
- **$0.0048 for 221 calls.** Cost is not a constraint here. Latency and accuracy are
  the constraints, and they are very different problems.

---

## Phase 6: the rerank benchmark is saturated, 2026-10-02

`npm run rerank:measure`. 31 memories, 33 labelled queries, top-10. Real
embedding model, real decision model, ground truth written before any number existed.

```
metric                      RRF alone    reranked     change
top-1 accuracy                   55%         55%           —
top-10 recall of relevant       106%         97%        -3
top-10 precision                 11%         10%           —
```

**Recall over 100% is not a measurement error.** 35 of 35 relevant items were
retrieved into the top ten by fusion alone. There is no headroom.

A benchmark where the baseline is at the ceiling cannot show an improvement, and
reporting "no improvement" from one is measuring the benchmark rather than the thing
being measured. Rerank changed nothing on 30 of 33 queries and lost three. With no
headroom the only honest reading is **neutral, on a corpus too small to say more**.

### Why the corpus is too small

31 memories, one or two relevant per query, top-10. Fusion finds all of them because
there is nothing to *not* find. Rerank reorders a set that is already correct.

A benchmark that can answer the question needs distractors — enough memories that
top-10 is a binding constraint. Two ways:

1. **Scale the corpus** to hundreds of memories with several relevant per query, so a
   top-10 window excludes something. This is what a real memory corpus looks like and
   it is the honest fix.
2. **Shrink the window** to top-3 or top-5. Cheaper, and it measures reordering rather
   than recall — which is what rerank actually does. It is also a weaker claim.

Option 1, on the real corpus Phase 9 migrates.

### The first run scored 45% where fusion scored 106%

Worth recording, because it looked exactly like a model that ranks relevance backwards.

The reranker received raw fusion results, whose text lives at `payload.item.content`, and
read `candidate.item?.content ?? ""`. The `??` fell through to an empty string, so the
model was asked *the same question about an empty memory* for every candidate and returned
a confident ordering of nothing.

Not a crash. Not a degraded path. A plausible-looking wrong answer, produced by a `?.`
chain that silently produced no text.

Fixed, and guarded: a candidate whose text cannot be read at all now **throws** with the
ids listed, rather than being ranked blind. A rerank that cannot see its candidates must
say so rather than order them.

### The degradation half of the gate did close

```
[pass] provider down: 20 results returned, in RRF order
[pass] reported as: decision provider failed for all 20 candidates
```

`debug.rerank.ranked: false` with a reason, rather than a silent unranked result that
claims to be ranked. `upstage/solar-decide` is listed as beta, and this is the case that
matters for it.

### The number ARCHITECTURE.md quotes

The architecture document states rerank's effect as "top-1 accuracy 5% → 18%, top-10
38% → 62%", attributed to "a comparable benchmark". **That is not a measurement of this
system**, and it should not be read as one. It is carried over from the plan that
motivated the fork. The measured numbers are the table above, and the honest summary is
that the effect is unmeasured.
