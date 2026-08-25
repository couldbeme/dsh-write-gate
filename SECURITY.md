# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab → "Report a vulnerability"). Reports get a response within a few days. Please include a reproduction; this project's own bar is that findings come with runnable proofs, and we hold reports to the same standard we hold ourselves.

## Threat model, briefly

Plainly, first: this gate contains **drift**, not a hostile agent. Structural (tier-1) evidence is evadable by rephrasing an action into an unrecognized shape — indirection lands on the tier-2 judge, and a judge is a filter, not a guarantee. Design accordingly.

In scope:
- Bypassing enforcement: getting a structurally matched action past the monotonic guard or the pre-execute waterfall (see the bypass test in `test/dsh-plugin.test.ts`).
- Judge manipulation from untrusted content: action text escaping the data fence, forging verdicts, or defeating the strict verdict parse (see the fence-defang and parser tests in `test/judge-llm.test.ts`).
- Fail-open behavior that contradicts the documented fail-closed default.

Out of scope:
- The commitments file and plugin config: these are operator-authored and trusted by design (a hostile operator already owns the deployment). This includes pathological command regexes, which are documented as a foot-gun in the README.
- The judge model's own quality on semantic cases: that is measured, not defended (see the fixtures and the [holdline](https://github.com/couldbeme/holdline) benchmark).
- Vulnerabilities in DeepSeek Harness itself: report those upstream; two findings we hit are documented in `docs/E2E-HEADLESS.md`.

## Supported versions

Pre-1.0: the latest published release only.
