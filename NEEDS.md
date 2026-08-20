# NEEDS.md — tool wants and needs

Session log per Director rule 10.

## 1. Pre-approved test-run capability (blocks on HEADACHES.md #1)

- **Want:** run `node --test` / `npm test` in the Lodestar workspace without a
  per-run `danger-full-access` approval prompt.
- **Why:** every verification cycle currently stalls on approval; it is the single
  biggest throughput cost in this workflow.
- **Options:** DSH-side persistent allowance for the exact command, or a sandbox
  spawn-with-piped-stdio allowance for workspace test runners.

## 2. (Optional) Native Windows ripgrep available to subagents

- Already available via the session grep tool; no action needed.

## 3. (Optional) Decision-ledger write from sandboxed sessions

- The live Lodestar DB is ACL read-only to sandboxed agents (see HEADACHES.md fact).
  If the Director wants sandboxed agents to record decisions directly, a sanctioned
  write path (e.g., a dedicated append-only shim or ACL adjustment) would be needed.
  Otherwise Q&A.md transcription remains the flow.

## RESOLVED 2026-08-20: golden-helpers toolbelt installed

Director expectation: golden-helpers should be callable tool code, not a repo.
Gap found: the six commands existed and were verified but were never installed.
Fix: six one-line shims in ~/.local/bin (safedel, safewalk, safedit, vcheck,
surface-volatility, trace-limit), all on PATH, help + real invocations verified.
README added to the repo documenting the contract (evidence-only, no verdicts).
Lesson (rule 10): when tools exist but are not wired as tools, say so loudly.
Open: optional per-shell registration (Codex/Claude/opencode/Hermes skill or
tool definitions) — the hermes-skill-distribution pattern applies if wanted.
## RESOLVED 2026-08-20 (follow-up): golden-helpers joined the tool belt

Director's correction: golden-helpers belongs in the established belt, not beside it.
The belt = C:/Users/zerop/Development/utility-belt (install-belt.ps1 -> shims + skill
mirrors to ~/.dsh and ~/.codex; belt-doctor; SKILL.md inventory/triggers; CHEATSHEET).
Done: install-belt.ps1 now owns the six golden-helpers shims (idempotent); belt-doctor
reports them (NoVersion-aware, 24 ok / 0 broken); SKILL.md gained the golden-helpers
toolbox section + trigger language; CHEATSHEET.md gained syntax; mirrors refreshed.
REGISTRATION (in progress 2026-08-20): extending the belt installer to Hermes,
opencode, and Claude Code roots (real copies, delete-then-copy, no links). Mavis is
STRUCK — gone forever, no registration, no references.
## RESOLVED 2026-08-20: registration is now PORTABLE (Director constraint)

Director: must not be hard-coded to this system; must be distributable to others.
Applied:
- golden-helpers/install.ps1 (new): repo-relative ($PSScriptRoot) shims, -BinDir
  param, idempotent. Works from any clone on any machine.
- install-belt.ps1: rewritten portable — no author paths. Parameters:
  -GoldenHelpersRepo (default: sibling dir), -DshSkillsRoot, -CodexSkillsRoot,
  -OpencodeSkillsRoot, -ClaudeSkillsRoot (defaults: standard per-product user
  conventions), -HermesSkillsRoot (no default; machine-specific, pass it),
  -BinDir, -BrokenShimCandidates (machine-specific list moved to a param).
- Belt docs (SKILL.md/README/CHEATSHEET/belt-doctor): author-absolute paths
  replaced with <repo>/<this-skill-dir> portable forms.
- Verified on this machine: 5 roots mirrored (DSH, Codex, opencode, Claude full
  copies; Hermes SKILL.md-only), all real dirs, LinkType none, 24 ok / 0 broken.
- Remaining machine-specific inputs are passed as parameters at install time
  (Hermes root, known-broken shims) — the scripts themselves stay portable.
## RESOLVED 2026-08-20: UNIFIED — one utility belt (golden-helpers merged)

Director approved merging golden-helpers into utility-belt. Done:
- Six Python tools moved to utility-belt/belt/ (safedel, safewalk, safedit, vcheck,
  surface-volatility, trace-limit). One inventory: belt-*.ps1 wrappers + Python
  evidence tools + one installer + one doctor + one cheatsheet + one update path
  (add under belt/ -> document in SKILL/CHEATSHEET -> run install-belt.ps1).
- install-belt.ps1 installs all shims repo-relative (portable). -GoldenHelpersRepo
  param removed.
- golden-helpers repo is a tombstone (README only, archived; tools moved).
- Verified: 5 skill roots mirrored (DSH/Codex/opencode/Claude 17 files each, Hermes
  SKILL.md-only), real copies no links, doctor 24 ok / 0 broken, shims point at
  utility-belt/belt, tools run via PATH.
- Call-site lesson: pwsh -File does NOT bind @(...) arrays correctly (second element
  leaked positionally into a later param) — pass array params via -Command or repeat
  named args, never @() literals through -File.
## DURABILITY AUDIT 2026-08-20 (utility-belt unified) — bugs fixed

Found and fixed:
1. UnicodeEncodeError class (ALL six tools): piped output under `python -I -S` (or any
   non-UTF-8 locale) crashed with cp1252 charmap errors on non-ASCII paths (CJK/emoji).
   Fix: deterministic UTF-8 reconfigure (errors=replace) on stdout+stderr in each main().
   Verified: CJK+emoji paths through all six under -I -S, safedit CRLF+unicode e2e PASS.
2. install-belt.ps1 -BrokenShimCandidates: `pwsh -File` cannot bind @() array literals
   (second element leaked positionally into another param — real bug I hit). Fix:
   semicolon-separated [string] param, split inside. Verified.

Audited clean (no change needed): safedit atomic-write/backup/rollback/splice invariants;
safedel handle-bound identity checks + ancestor-reparse guards; safewalk; vcheck manifest
validation (path-traversal, case-collision, duplicate-key); PS7 Remove-Item on junctions
is link-only (target survives — no guard needed).

OPEN (Director action): surface-volatility --selfcheck fails until utility-belt is
COMMITTED — the selfcheck is a deliberate durability gate proving the tool is installed
from a committed repo (probe file belt/safedel.py is currently ?? untracked). Commit the
merge and it goes green. Residual minors: shims call plain python at runtime (doctor
surfaces missing python); scoop install exit codes ignored (doctor is the check);
broken-shim loop prints a cosmetic PS error record (harmless).
