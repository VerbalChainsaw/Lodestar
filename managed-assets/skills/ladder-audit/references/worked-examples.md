# Ladder Audit Worked Examples

These examples show how to separate capability owners. They are not reusable action scripts, complete certification plans, or permission to encode known answers.

## Example 1: Minecraft overnight shelter

### Outcome

A companion receives one ordinary request, builds a safe overnight shelter, enters through its entrance, sleeps in the exact bed it built, survives one Stop/restart, and resumes companion behavior.

### Bounded capability map

```text
intent -> blueprint -> semantic validation -> site binding -> dependencies
      -> placement -> world verification -> terminal receipt -> exact bed use
      -> agenda settlement -> companion resumption
```

### Bad first test

Enable natural language, unknown terrain, empty inventory, model-generated geometry, resource discovery, tool preparation, construction, sleep, Stop, and restart in one run. A six-minute failure has nearly every node as a suspect.

### Representative next tranche

| Rung | Newly active capability | Supplied scaffolds |
|---|---|---|
| A0 | ordinary audit-place-verify loop | validated blueprint, bound clear site, final items supplied |
| A1 | oriented door and two-cell bed | exact logical fixture descriptors supplied |
| A2 | exact entrance and exact bed use | completed structure and exact fixture bindings supplied; decoy bed nearby |
| B0 | direct creation of one missing final fixture | immediate ingredients and workstation supplied |
| B1 | one raw dependency acquisition | acquisition tool supplied; all other resources fixed |
| C0 | safe site selection | inventory and blueprint supplied; vicinity loaded |
| D0 | custom blueprint compilation | physical prerequisites supplied |

Later tracks can cover empty inventory, remote site ownership, natural-language sequencing, and restart. Do not detail them until this tranche passes.

### Orthogonality correction

“Remove the torch” is not one rung when it activates wood discovery, tool preparation, fuel, crafting, navigation, and inventory capacity. Split by capability boundary.

### Oracle qualification

Before A2, prove the shelter bed is absent or unused, place a closer decoy bed, and record the exact shelter bed identity. Pass only when external world state shows the companion used the bound shelter bed.

### Eligible pre-fix

Source stores a bed as one ordinary cell even though the game creates foot and head blocks. That is a shared state-model contradiction with a focused failing-before check. Repair it before another broad run, while retaining physical placement and sleep as graduation requirements.

## Example 2: File import service

### Outcome

A user uploads a CSV file. The service authorizes the request, imports rows idempotently, records exact rejected rows, survives a worker restart, and does not duplicate accepted records.

### Representative ladder

| Rung | Newly active capability | Supplied scaffolds |
|---|---|---|
| A0 | persist one supplied normalized row | normalized row supplied, local transaction |
| A1 | normalize one parsed row | parsed fields supplied, persistence fixed |
| A2 | classify and record one rejected row | known invalid parsed row supplied |
| A3 | idempotent batch replay | upload identity and normalized rows supplied |
| B0 | CSV parsing | known local file supplied |
| C0 | upload-storage handoff | authenticated request and local storage fixture |
| D0 | async job checkpoint | downstream path proven |
| E0 | restart after partial batch | exact checkpoint intentionally preserved |

### Qualified oracle

Check pre-state row counts and idempotency keys, then verify exact accepted/rejected identities directly in the database and report store. A returned `200` or “import complete” log is insufficient.

### Eligible pre-fix

The job store deletes the terminal result before the status endpoint acknowledges it. Repair the shared terminal-handoff contradiction before the restart rung.

## Example 3: LLM tool workflow

### Outcome

An agent receives a natural request, selects one typed tool, executes it exactly once against the intended target, persists a correlated result, and resumes after interruption without treating an older run as success.

### Representative ladder

| Rung | Newly active capability | Supplied scaffolds |
|---|---|---|
| A0 | typed tool execution and exact effect | tool name, arguments, and target supplied |
| A1 | request-invocation-result correlation | typed invocation supplied |
| B0 | deterministic intent routing | unambiguous utterance, no model |
| B1 | model-selected typed tool | tool catalogue supplied |
| C0 | dependent two-step binding | first result supplied to second step |
| E0 | interruption and terminal handoff | exact invocation state intentionally preserved |

### Transfer probe

Use another valid target of the same contract and keep an unrelated older active tool run present. The new request may pass only through its own correlation identity.

### Eligible pre-fix

The orchestrator declares a deferred command accepted whenever any active tool job exists. This is an exact-correlation contradiction, not a reason to script the expected tool sequence.

## General lessons

- Start from the real outcome, but execute the ladder from the deepest unproven boundary.
- Supply scaffolds through external setup, never production-visible hints.
- Remove one material uncertainty per rung; use a paired boundary only when isolation is demonstrably impossible.
- Qualify the oracle before trusting a pass, and distinguish `BLOCKED`, `INCONCLUSIVE`, and product `FAIL`.
- Keep ordinary rungs stateless and recovery rungs intentionally stateful.
- Detail only the next useful tranche.
- The unchanged graduation gate remains the product claim.
