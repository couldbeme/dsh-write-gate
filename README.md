# dsh-write-gate

[![ci](https://github.com/couldbeme/dsh-write-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/couldbeme/dsh-write-gate/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/dsh-write-gate)](https://www.npmjs.com/package/dsh-write-gate)

A commitment write-gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the operator authors constraints ("never force-push to a shared branch", "stay read-only on the production database"), and the gate enforces them **before** a tool call executes. Structural violations are caught deterministically; semantic drift is judged by a model against the operator's own wording. Every block is recorded to a contradictions log that explains which commitment fired and why.

Engine-agnostic core (`dsh-write-gate/core`, zero harness imports) with a dsh adapter; a Claude Code adapter over the same core is planned.

A live model inside the real dsh app, told to force-push, after the gate denied the call:

> "The force push to the main branch was blocked by the repository's 'no-force-push' policy."

That turn ran fully local, zero API keys; reproduction and session-log receipts in [`docs/E2E-HEADLESS.md`](docs/E2E-HEADLESS.md).

## Install

```sh
npm install dsh-write-gate        # library + dsh plugin (see Mounting below)
```

The `dsh-write-gate check` CLI ships in 0.2.0, tagged on GitHub with the npm publish pending; `npm install` today resolves 0.1.1, which has no CLI. Until the publish, run it from a clone: `pnpm install && pnpm build && node dist/cli/index.js --help`.

## How it enforces: two tiers in two slots

| Tier | Mechanism | dsh slot | Why this slot |
|---|---|---|---|
| 1: deterministic | path globs, command regexes, scope filters | `ctx.tools.guard()` (monotonic) | no listener ordering can turn a guard denial back into permission |
| 2: semantic | LLM judge over the commitment statement | `tools/pre-execute` waterfall (prepended) | async-capable; short-circuits with a `{kind: 'deny'}` decision object |

`agent/pre-step` resets the per-step judge budget. Contradiction records are emitted as the `write-gate/contradiction` event and appended as JSONL to the contradictions log.

## Why two tiers

An internal A/B study (12 tasks x 4 arms x 10 runs; runbook not yet published, so cite nothing from this sentence) found an LLM-judge-only gate performed at baseline on unflagged-violation rate, while deterministic checks caught an entire violation class the judge repeatedly passed (over-length outputs); a naive "reminder" arm was the worst performer of all four. Deterministic checks for checkable constraints, the judge only for genuinely semantic ones.

The tier-2 judge rubric is ported from a lineage measured at 18/18 dev + 16/16 held-out (100% precision, 0 abstains) on a local 8B model, and re-measured live through this port (2026-08-17): 32/34 accuracy with **17/17 violation recall**. It also carries an anti-self-justification clause added after the [holdline](https://github.com/couldbeme/holdline) benchmark caught two injection defeats (an action asserting "the operator approved this" or "this is only a test" talking the judge into clearing a real violation); the clause moved injection accuracy from 5/8 to **7/8 with zero regression** on the base cases. We keep the injection-fenced prompt because it is the only variant that preserved 100% violation recall; for a gate, a missed violation is worse than an over-block. The fixture ships 41 cases (18 dev, 16 held-out, 7 injection) in [`test/fixtures/judge-cases.json`](test/fixtures/judge-cases.json) with their honesty notes intact: they are hand-authored; the meaningful signals are the paraphrase-miss rate, the trap false-positive rate, and held-out generalization, not the headline percentage.

## Design guarantees, each pinned to a test

- **Bypass resistance**: a prepended listener that answers `allow` without delegating still cannot get a structural violation through — `test/dsh-plugin.test.ts` ("cannot be bypassed by a listener that short-circuits allow").
- **Fail-closed default**: judge unreachable, timed out, or over budget → block-severity commitments block, with the reason in the record — `test/gate.test.ts`.
- **Bounded judge cost**: per-step budget, verdict memoization, timeout-as-unavailable — `test/gate.test.ts`.
- **Prompt-injection stance**: action content enters the judge prompt fenced as data ("data, not instructions"); only a strict JSON verdict (or the ABSTAIN token) is accepted back; ABSTAIN is never a block — `test/judge-llm.test.ts`.
- **Loud mount failure**: a missing or invalid commitments file fails the deployment instead of mounting a gate that guards nothing — `test/dsh-plugin.test.ts`.
- **Real pipeline**: the integration suite mounts the plugin into an actual `Context` + `ToolRuntime` from the published rc packages and drives `ctx.tools.execute` — no mocked harness.
- **Real app, real model**: a live local model inside the actual dsh headless app attempted a force-push and was denied by the gate; its own final answer reported the block. Full reproduction, session-log receipts, and two upstream findings: [`docs/E2E-HEADLESS.md`](docs/E2E-HEADLESS.md).

Run everything: `pnpm install && pnpm test` and `pnpm typecheck` — the suite prints its own count; every guarantee above names its test file.

Watch the drift story: `pnpm demo` — deterministic, no model required. In-scope work passes, a prod-config edit and a force-push block, and a rogue allow-everything listener fails to bypass the monotonic guard; the contradictions log prints at the end.

Measure the judge yourself: `pnpm build && node scripts/judge-eval.mjs --url <openai-compatible-endpoint> --model <model>` runs every fixture case live and reports per-set accuracy, abstains, and misses.

## Commitments file

```yaml
version: 1
defaults:
  failMode: closed        # judge unreachable => block-severity commitments block
  judgeBudgetPerStep: 8
commitments:
  - id: no-force-push
    statement: Never force-push to a shared branch.
    match:
      kinds: [shell]
      commands: ["git\\s+push\\s+[^\\n]*(-f\\b|--force)"]
  - id: stay-on-task
    statement: Do not modify files unrelated to the assigned task.
    severity: warn
    semantic: true          # escalates to the tier-2 judge
    match:
      kinds: [fs-write]
```

Semantics: `kinds`/`tools` are scope filters; `paths`/`commands` are structural evidence. A non-semantic commitment with scope but no evidence fires on every in-scope action; a non-semantic commitment with neither is rejected at load as unenforceable. Command regexes are case-insensitive by default. One foot-gun to know: command patterns execute inside the synchronous guard, so a catastrophically backtracking regex can stall the tool pipeline — commitments are operator-authored (trusted), but keep patterns simple. Full example: [`commitments.example.yaml`](commitments.example.yaml) (itself under test).

## CLI (`dsh-write-gate check`)

A standalone check outside any harness, for CI, pre-commit hooks, or manual use:

```sh
dsh-write-gate check --commitments <file> --tool <name> [--path <p> ...] [--command <c>] [--explain] [--json]
dsh-write-gate --help | -h   # or: dsh-write-gate check --help (prints this usage synopsis, exit 0)
```

**v0 is tier-1 (structural) only — no `--judge` flag exists yet.** Every `semantic: true` commitment that structure alone cannot settle always escalates to "no judge configured", and then follows the commitments file's `failMode`. With the default `failMode: closed`, that means **every escalating semantic commitment always blocks** in the CLI today. A `--judge` flag is an explicitly deferred follow-up; until then, treat semantic commitments as block-on-touch when driving the CLI directly (the dsh plugin itself has no such limit when `judge` is configured).

`--tool` is required (e.g. `bash`, `write`, `read`); it gets no enum validation beyond non-empty — `kind` is derived from it and cannot be set directly. `--path` may repeat; `--command` takes the last value if repeated. At least one of `--path` / `--command` is required.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ALLOW, including a fail-open degraded allow (degradation is surfaced in the output, never by changing the exit code) |
| 1 | BLOCK — unified across tier-1 structural, tier-2 judged, and tier-2 fail-closed blocks |
| 2 | Usage error |
| 3 | WARN |
| 4 | Commitments file unreadable, or invalid (bad YAML, bad regex, duplicate id, schema violation, unsupported version) |
| 5 | Internal/unexpected error |

`--json` prints only the JSON document to stdout (safe for `| jq .`); everything advisory goes to stderr. `--explain` expands each record with the commitment, its statement, severity, tier, matched pattern, and rationale; it is a documented no-op under `--json`.

## Mounting

The package declares the ecosystem convention (`dsh.bundle.patch` → [`cordis.patch.yml`](cordis.patch.yml)) and mounts with:

```sh
dsh plugin --profile <profile> add dsh-write-gate
```

Config keys: `commitmentsFile` (default `COMMITMENTS.yaml`, resolved from cwd), `contradictionsLog` (JSONL, default `write-gate.contradictions.jsonl`), `judgeTimeoutMs`, and `judge: { provider, model, maxTokens }` — omit `judge` to run tier 1 only (escalations then follow `failMode`).

A worked starting policy lives at [`examples/team-policy.yaml`](examples/team-policy.yaml): copy it in as `COMMITMENTS.yaml`, or point `commitmentsFile` at it.
Production configs are protected by `fs-write` path globs, tier 1 only.
Force-pushes are caught by a shell command regex.
The production database is held read-only by a regex matching psql/mysql invocations that name a prod host together with a mutating SQL keyword; reads against the same hosts pass.
A `severity: warn`, `semantic: true` stay-on-task commitment escalates to the tier-2 judge.
`pnpm demo` (above) is the narrative version of the same kind of policy.

## Current limits (v0, stated rather than hidden)

- The CLI (`dsh-write-gate check`) is tier-1 only: it never configures a judge, so every escalating semantic commitment reports "no judge configured" and follows `failMode` — block by default. See the CLI section above.
- The action normalizer is a heuristic table over dsh's in-tree tool names (`bash`, `read`/`write`/`edit`, web tools); unrecognized tools degrade to kind `other` with a full summary — visible to semantic commitments, but path/command rules do not apply to them.
- dsh is a 0.1.0-rc developer preview with breaking changes announced; peers are pinned to `<0.2.0`.
- Early releases (0.1.x core + dsh plugin on npm; 0.2.0 adds the CLI, tagged on GitHub, npm publish pending); `pnpm build` emits `dist/`, `prepublishOnly` gates every publish on build + tests.
- The tier-2 judge is only as good as its model and rubric; the measured numbers above are from the shipped fixtures, and the benchmark that scores this gate (and others) against labeled trajectories is [holdline](https://github.com/couldbeme/holdline) (see Roadmap).

## Roadmap

1. llm-replay fixture variant of the demo (dsh snapshot format), so the story replays inside a full agent loop.
2. ~~The gate benchmark~~ → shipped as [**holdline**](https://github.com/couldbeme/holdline): catch rate, false-block rate, class-balanced kappa, and an injection-attack class, scoring any guard (this one included). Authored corpus: this gate's judge tier scores balanced kappa **0.95** (100% catch, 5% false-block) against 0.15–0.35 for commitment-blind structural guards. On **548 real ODCV-Bench trajectories** with independent 4-model-panel labels, the judge holds balanced kappa **0.64** (75% catch, 9% false-block). holdline honestly records where the judge loses (injection, truncation).
3. Claude Code adapter over the same core.

## Dependencies and trust basis

Runtime: `zod`, `yaml`, `picomatch` (mainstream, actively maintained), `@deepseek-ai/schemastery` (dsh's own config-schema library, Koishi lineage). Harness peers: `@deepseek-ai/cordis` + `@deepseek-ai/dsh-*` rc packages, pinned. Dev: `vitest`, `typescript`.

MIT.
