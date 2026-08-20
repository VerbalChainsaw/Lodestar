# The toolchain

Lodestar documents this small toolchain rather than treating it as one giant rules file. Each part closes a specific failure mode without granting Lodestar ownership over another tool's files.

Lodestar ships canonical reference content from npm. It owns its database and package bytes only. External skill directories and agent-instruction files remain owned by their native environments.

---

## Lodestar, layer 4, memory

`lodestar-agent-context` · [github.com/VerbalChainsaw/Lodestar](https://github.com/VerbalChainsaw/Lodestar) · MIT · Node 24.15+

```bash
npm install --global lodestar-agent-context
lodestar skills verify --target all
```

Lodestar does not install or synchronize external skill directories. Place skills
through the native environment or a deliberate user-owned distribution step, then use
read-only verification when comparison is useful.

A local context registry. Project knowledge, decisions, work presence, startup snapshots, and continuity live in one universal-record SQLite database and come back through stable IDs, exact aliases, deterministic search, and explicit links. No background service or runtime network dependency.

**What it covers.** Agents open a session by recursively searching the repo and rebuilding context the project already knows, and that burns a good chunk of a window before any work starts. Lodestar gives them a smaller first move.

The mechanism is exact retrieval with optional caller-selected paging:

| Command | Returns |
|---|---|
| `get <id-or-alias>` | One record, resolved by stable ID or exact alias. Not a search, not a ranked list. |
| `find <query>` | Deterministically ordered matching records. Add `--limit` only when a page is useful. |
| `links <id-or-alias>` | **One hop** of incoming and outgoing links. Never a transitive dump of the graph. |
| `export` | A deterministic JSON representation, when you actually want everything. |

Every success is one JSON object on stdout, `{"ok": true, "data": {}}`. Every failure is one stable object on stderr carrying a code, a message, the identifiers requested, and an `action` field telling the agent what to do next. `--human` formats it for people. Help and version never open or create a database.

The part I care most about is what it refuses to claim. Record content carries one of five states: `known`, `known_empty`, `unavailable`, `unknown`, `stale`. Whether a source was actually checked is tracked on a separate axis as `inspected`, `not_inspected`, `inspected_no_value`, or `unknown`. So `known_empty` means a checked source genuinely supports an empty value, which is a different fact from nobody having looked, and neither one means the project is complete.

A missing record means only that Lodestar lacks that knowledge. It is not evidence the thing does not exist. Its published agent contract is five lines: use Lodestar before recursively searching, retrieve through stable IDs or aliases, follow explicit links for related context, treat a missing record as missing knowledge rather than proof of absence, and inspect the repository normally when Lodestar is insufficient. It does not infer readiness, score completeness, or claim its records fully describe anything.

Durability is ordinary SQLite done carefully: `BEGIN IMMEDIATE`, foreign keys, `synchronous=FULL`, read-only query-only connections for reads, and a finite lock wait so a one-shot CLI cannot hang behind another writer beyond its host execution window. Startup replay snapshots are ordinary universal records, not a second persistence format or background service.

A note on the 1.0 rewrite, since it is relevant to the rules in this repo. The original version had generation trees, commit pointers, heartbeat locks, snapshots, and custom rollback. 1.0 replaced all of that with ordinary SQLite transactions. It does less and is easier to operate. I wrote a freeze rule telling agents to stop gold-plating, then had to apply it to my own tool, which was humbling.

## center-geo, layer 7, survey

Ships in the canonical `managed-assets/skills/center-multigeometry` bundle.

A deterministic structural risk scanner. It reads a codebase as a graph and traverses it under six geometries (radial, cycle, boundary, anomaly, convergent, path), then fuses the signals into ranked hypotheses with anchors.

**What it covers.** Guessing where the risk is. Or worse, treating a scanner's output as a defect list.

For calibration, a real run against an 80,000 line agent codebase indexed 187 files into 2,837 nodes and 26,726 edges, producing 438 raw signals that fused into 20 hypotheses. Of those edges, 17,838 were low confidence. So the graph rank was only ever used to pick which code to read by hand.

It emits hypotheses. It does not prove defects. I think a scanner that reports findings as conclusions is worse than no scanner, because it turns noise into confident work items.

## center-audit, layer 8, proof

v2.5.1 · [github.com/VerbalChainsaw/center-audit](https://github.com/VerbalChainsaw/center-audit) · MIT. Ships in the canonical managed skill bundle.

A read-only, evidence-gated, center-out root cause audit of a single suspected defect. It returns a calibrated finding, blast radius, a repair contract, and a verification plan.

**What it covers.** Two things I kept running into.

The first is volume. Ask an agent to investigate a bug and you get 17 plausible issues, ranked, and now you have a triage problem instead of an answer.

The second is worse. The agent investigates and fixes in one motion, so a wrong diagnosis becomes a wrong edit before anyone can check the reasoning.

center-audit does not edit code. It produces a contract the next agent can independently re-validate before touching a file. That separation between diagnosing, handing off, and implementing is the whole point, and it is why this sits between survey and verification instead of replacing either.

### Why survey and proof are two tools

They answer different questions, and when I tried to combine them I got something that did neither well.

center-geo runs when you have no center: where should I even look? center-audit runs when you have one: is this specific thing real, and what exactly is broken?

Run center-geo to pick a hypothesis. Run center-audit to prove or kill it. Then use `ladder-audit` to design the proof that the repair actually worked.

---

## Active context and state

Lodestar is the active authority for its own context database. It does not distribute or modify skill directories or agent-instruction files.

```bash
lodestar skills verify --target all
lodestar agents status --cwd .
lodestar start --cwd .
lodestar work start "<scope>"
lodestar work done "<result>"
```

Identity comes from the host, not the shell. In a host running the Lodestar plugin
(Codex Desktop), call the bundled tools — `lodestar_work_start`, `lodestar_work_done`,
`lodestar_work_status` — which carry the exact session id the host already knows.
A plain shell has no session id, so `lodestar work start` there requires an explicit
`--session <id>`. Lodestar refuses rather than guessing: work records are keyed by
actor, so a guessed session would capture and then overwrite a concurrent peer's
marker.
```text
lodestar handoff status --cwd .
```
