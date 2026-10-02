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
