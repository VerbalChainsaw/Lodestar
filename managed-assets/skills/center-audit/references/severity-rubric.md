# CENTER-AUDIT: Severity and Confidence Rubric

Severity measures consequence of a **confirmed** defect. Confidence measures evidence quality. Do not use severity to compensate for uncertainty.

## Severity

### CRITICAL

Confirmed behavior with credible potential for one or more of:

- irreversible or broad data loss/corruption
- exploitable security or authorization boundary breach
- destructive action without effective guard or recovery
- silent systemic corruption or false success that conceals severe harm
- cross-tenant or high-sensitivity data exposure
- widespread production outage with no practical workaround

Critical requires a concrete mechanism and affected boundary. “Could theoretically be bad” is not critical.

### HIGH

Confirmed behavior causing one or more of:

- persistent state corruption or broken save/load/migration
- public API, CLI, event, or schema contract failure with meaningful consumers
- broad incorrect output or silently dropped records
- permission validation bypass without demonstrated critical exposure
- repeated duplicate actions, billing, or irreversible workflow advancement
- serious production failure with costly or narrow recovery

### MEDIUM

Confirmed, bounded, recoverable functional defect such as:

- incorrect behavior in a defined scenario
- degraded workflow or blocked task with workaround
- stale cache, retry, ordering, or error-path failure without lasting corruption
- misleading but detectable status/output
- weak regression protection on the confirmed trajectory

### LOW

Confirmed localized, recoverable defect with limited consequence, such as:

- minor behavior mismatch
- bounded UI/state defect
- noisy or misleading noncritical log/status
- rare edge case with easy recovery and no contract or data damage

Naming, comments, cleanup, duplication, and general maintainability are not LOW defects unless they directly cause the center claim. Usually they are non-center observations or non-scope.

## Confidence

### HIGH

- target revision/environment captured
- strong direct evidence
- no unresolved material contradiction
- complete enough causal trajectory
- appropriate independent corroboration for high-impact claims

### MEDIUM

- direct evidence exists
- one environment, runtime, or trajectory gap remains
- reproduction is intermittent or unavailable but mechanism is well supported

### LOW

- weak/heuristic center
- material contradiction unresolved
- incomplete search domain
- runtime/config/version uncertain
- mechanism depends on unverified assumptions

## Result labels

- **CONFIRMED**: sufficient causal evidence supports the defect.
- **PROVISIONAL**: mechanism is plausible and important, but evidence is insufficient for a final confirmed finding. Report under unknowns/contradictions, not confirmed defects.
- **DISPROVEN**: direct evidence rules out the stated concern in the captured frame.
- **INCONCLUSIVE**: evidence cannot confirm or disprove.

## Calibration checks

Before assigning severity, ask:

1. What user/system asset is harmed?
2. Is the harm persistent or reversible?
3. How many users, records, tenants, services, or workflows are affected?
4. Is detection immediate, delayed, or silent?
5. Is privilege or sensitive data involved?
6. Is the mechanism confirmed at the target boundary?

Before assigning confidence, ask:

1. Is the target revision/environment known?
2. Is every material trajectory link proven?
3. Are runtime and source consistent?
4. Are search exclusions known?
5. Is the test oracle independent of the proposed repair?
6. For HIGH/CRITICAL impact, is there an independent evidence channel or a stated reason it was unavailable?
