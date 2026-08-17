# dsh API Contract — for the `dsh-write-gate` Cordis policy plugin

Extracted 2026-08-17 from a sparse clone of the dsh repo (branch `master`).
All paths are relative to the repo root `dsh-src/`. Every claim carries a `path:line`
citation; quoted code is verbatim. Anything not pinnable to source is in §9 UNKNOWNS.

---

## 1. PLUGIN SHAPE

Cordis accepts three plugin entrypoint shapes — `vendor/cordis/src/registry.ts:91-96`:

```ts
/** Supported plugin entrypoint shapes. */
export type Plugin<T = any> =
  | Plugin.Function<T>
  | Plugin.Constructor<T>
  | Plugin.Object<T>
```

with shared metadata `vendor/cordis/src/registry.ts:100-111`:

```ts
  export interface Base<T = any> {
    /** Display name used for fiber diagnostics and logger names. */
    name?: string
    /** Standard-schema validator applied to config before the plugin starts. */
    Config?: StandardSchemaV1<any, T>
    /** Services the plugin requires; it only loads while all are available. */
    inject?: Inject
    /** Service name(s) the plugin provides (read by `Service` and by loaders). */
    provide?: string | string[]
    /** Service names whose intercept config the plugin declares it consumes. */
    intercept?: Dict<boolean>
  }
```

and the three shapes at `vendor/cordis/src/registry.ts:120-133`:

```ts
  /** Function plugin called with `(ctx, config)`. */
  export interface Function<T = any> extends Base<T> {
    (ctx: Context, config: T): any
  }

  /** Class plugin constructed with `(ctx, config)`. */
  export interface Constructor<T = any> extends Base<T> {
    new (ctx: Context, config: T): any
  }

  /** Object plugin with an `apply(ctx, config)` method. */
  export interface Object<T = any> extends Base<T> {
    apply(ctx: Context, config: T): any
  }
```

`Inject` is `vendor/cordis/src/registry.ts:19`:

```ts
export type Inject<M = Dict> = (keyof M)[] | { [K in keyof M]?: M[K] }
```

An **out-of-tree module is mounted as a `Plugin.Object`**: the loader imports the
module and applies `unwrapExports` — `vendor/loader/src/index.ts:191-199`:

```ts
  /** Normalize ESM/CJS/default export shapes before applying a plugin. */
  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
```

Consequence, enforced by an in-tree test: a **function-style policy plugin must NOT
have a default export** (the module namespace itself — with `name`, `inject`,
`Config`, `apply` — is the plugin object), while a **Service plugin ships its class
as the default export**. `packages/spill/spill-policy/tests/spill-policy.spec.ts:102-113`:

```ts
describe('loader export shape', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in SpillPolicy).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(SpillPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(SpillPolicy)
    expect(unwrapped.name).toBe('spill-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
```

### 1.1 package.json pattern (all three policy packages are identical in shape)

- Name scope: `@deepseek-ai/dsh-<name>` — `packages/spill/spill-policy/package.json:2`
  (`"@deepseek-ai/dsh-spill-policy"`), `packages/fs/fs-observation-policy/package.json:2`,
  `packages/sandbox/sandbox-policy/package.json:2`.
- `"type": "module"`, `"main": "lib/index.js"`, `"types": "lib/types/index.d.ts"` —
  `packages/spill/spill-policy/package.json:14-15`.
- Exports map: `"."` (types + default), `"./invariant"`, `"./src/*": "./src/*"`,
  `"./package.json"` — `packages/spill/spill-policy/package.json:16-27`.
- **Cordis and every consumed dsh package are `peerDependencies`**, duplicated in
  `devDependencies` for the package's own tests:
  `packages/spill/spill-policy/package.json:34-42`:

```json
  "peerDependencies": {
    "@deepseek-ai/dsh-invariants": "workspace:^",
    "@deepseek-ai/dsh-llm": "workspace:^",
    "@deepseek-ai/dsh-output-retention": "workspace:^",
    "@deepseek-ai/dsh-session": "workspace:^",
    "@deepseek-ai/dsh-spill": "workspace:^",
    "@deepseek-ai/dsh-tools": "workspace:^",
    "@deepseek-ai/cordis": "workspace:^"
  },
```

- The one runtime `dependency` is the config-schema library:
  `packages/spill/spill-policy/package.json:43-45` →
  `"dependencies": { "@deepseek-ai/schemastery": "workspace:^" }`.
  Same in sandbox-policy (`packages/sandbox/sandbox-policy/package.json:42`).
  fs-observation-policy has no config, hence no `dependencies` block
  (`packages/fs/fs-observation-policy/package.json:34-45`).
- **`Context` types come from `@deepseek-ai/cordis`** (the vendored fork,
  `vendor/cordis/package.json:2` → `"name": "@deepseek-ai/cordis"`, version `4.0.1`
  at `vendor/cordis/package.json:4`). Every policy plugin imports it:
  `packages/spill/spill-policy/src/index.ts:46` →
  `import type { Context } from '@deepseek-ai/cordis'`;
  `packages/sandbox/sandbox-policy/src/index.ts:22` →
  `import { Context, Service } from '@deepseek-ai/cordis'`.

### 1.2 Function plugin with inject + Config (spill-policy)

`packages/spill/spill-policy/src/index.ts:59-77,110`:

```ts
/** Plugin config. */
export interface Config {
  maxInlineBytes?: number
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spill-policy'

/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
export const inject = ['tools']

export const Config: z<Config> = z.object({
  maxInlineBytes: z.number(),
})
...
export function apply(ctx: Context, config: Config): void {
```

(`z` is `import z from '@deepseek-ai/schemastery'` — `packages/spill/spill-policy/src/index.ts:47`.
The merged value+type `Config` export is the house idiom: the interface and the
schema share the name.)

Config validation happens **at load, not per call** — a bad config must fail the
deployment: `packages/spill/spill-policy/src/index.ts:114-119`:

```ts
  // Validate at LOAD, not per call: ...
  if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0) {
    throw new Error(`spill-policy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`)
  }
```

### 1.3 Function plugin with no inject (fs-observation-policy)

`packages/fs/fs-observation-policy/src/index.ts:97-107`:

```ts
/** Cordis plugin name used by loader diagnostics. */
export const name = 'fs-observation-policy'

/**
 * Register the three `fs/*` listeners. No `inject` — this plugin reads no
 * services; it operates only on its own `WeakMap`. ...
 */
export function apply(ctx: Context): void {
  const gate = new ObservedStateGate()
```

Its minimal structural actor type (narrowing the opaque `object` actor without
importing dsh-tools) is `packages/fs/fs-observation-policy/src/types.ts:23-29`:

```ts
export interface FsObservationActor {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    /** The session that owns observed-file state, used as an opaque key. */
    session?: object
  }
}
```

spill-policy does the same trick (session id only) — `packages/spill/spill-policy/src/types.ts:16-26`
(`SpillPolicyExec`: `agent?: { session: { header: { id: SessionId } } }`) and derives
the owner at `packages/spill/spill-policy/src/index.ts:90-92`.

### 1.4 Service subclass plugin (sandbox-policy)

`packages/sandbox/sandbox-policy/src/index.ts:54-58,91-111,154`:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}
...
export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const).default('read-only'),
    workspaceRoot: z.string(),
  })
  ...
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    ...
  }
}

export default SandboxPolicyService
```

The `Service` base contract — `vendor/cordis/src/service.ts:5-11,42`:

```ts
/**
 * Base class for services that expose a named API on `ctx`.
 *
 * Subclasses call `super(ctx, name)` from their constructor. The service is
 * registered immediately and is automatically removed with the owning fiber.
 */
export abstract class Service<out T = never> {
  ...
  constructor(protected ctx: Context, name: string) {
```

A Service plugin can also lazily wire optional peers with `ctx.inject` —
`packages/sandbox/sandbox-policy/src/index.ts:112-123`:

```ts
    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: 110,
        ...
      })
    })
```

`ctx.inject` signature — `vendor/cordis/src/registry.ts:176`:
`inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>`;
`ctx.plugin` — `vendor/cordis/src/registry.ts:185`:
`plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>`.

**Recommendation for dsh-write-gate**: function-plugin form (spill-policy shape)
unless the gate must expose a `ctx.writeGate` service; then sandbox-policy shape
with `declare module '@deepseek-ai/cordis' { interface Context { ... } }` +
`export default`.

---

## 2. MOUNTING

Config file: **`cordis.yml`** — an ordered YAML **list** of entry rows
`{ id, name, config? }`. `name` is a **module specifier resolved by dynamic
`import()`** against the config's base URL — `vendor/loader/src/config/tree.ts:145-159`
(`return await import(/* @vite-ignore */name)`), unwrapped at
`vendor/loader/src/config/entry.ts:280`:

```ts
      plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, this.getOuterStack))
```

So an out-of-tree plugin mounts by npm package name (or importable path).

Real entry row with config — `examples/acp-agent/cordis.yml:27-31`:

```yaml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js "process.env.DSH_PERMISSION_MODE ?? (process.env.DSH_SNAPSHOT === undefined ? 'workspace-write' : 'danger-full-access')"
    workspaceRoot: !!js process.cwd()
```

Config-less entry, with load-order comment — `examples/headless-agent/cordis.yml:155-163`:

```yaml
# Policy loads before the model-facing filesystem tools so writes and edits
# require an observed file. Relative paths resolve from the process cwd.
- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.cwd()

- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'
```

Overlay/include with insert patch (how spill-policy is added on top of a base
tree) — `examples/acp-agent/fs.cordis.yml:4-17`:

```yaml
- id: base
  name: '@deepseek-ai/cordis-plugin-include'
  config:
    path: ./cordis.yml
    patches:
      - insert:
          - id: spill-local
            name: '@deepseek-ai/dsh-spill-local'
            config:
              root: !!js process.env.DSH_SNAPSHOT_SPILL_ROOT ?? './.spill'
          - id: spill-policy
            name: '@deepseek-ai/dsh-spill-policy'
            config:
              maxInlineBytes: !!js process.env.DSH_SNAPSHOT && 800 || 50000
```

`!!js` semantics — `docs/cordis-primer.md:38`: "`@deepseek-ai/cordis-plugin-include`
parses `!!js` into expression nodes. Loader interpolates an entry's `config` (after
declared injections activate, against that plugin context — `ctx.serviceName`) and
its `disabled` field (at every mount decision, against the loader context) ...
Use overlays when the environment selects plugins."

Bundle/profile/layer semantics — `docs/architecture.md:15-31`:

- :17 "A running `dsh` is a plugin tree composed at boot from ordered layers."
- :19 "A **profile** is a named composition stored in the Harness home. It lists the
  bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's
  own `cordis.patch.yml`. `web` and `headless` ship as templates."
- :21 "A **bundle** is a distribution format for Cordis config rows and the code they
  mount, so whatever it inserts stays patchable by the layers above it."
- :23 "Each declares itself in its own `package.json` under a `dsh` field:
  `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's
  patch file."
- :27 "Layers apply to an empty entry list in this order: each bundle in the
  profile's listed order, then the profile's `cordis.patch.yml`, then the home-level
  one, then any `--patch` overlay. A patch targets a row by id and replaces its whole
  config, or inserts new rows."
- :29-33 inspect with `dsh --profile web --dump-config`.

Config discoverability: every mountable `config:` block is generated into
`docs/config-catalog.md` (header, :4-8) with a `Requires:` line listing the
plugin's `inject` service keys (`docs/config-catalog.md:8`).

---

## 3. TOOLS PIPELINE

Service: `ctx.tools` (`ToolRuntime extends Service`, `static inject = ['systemPrompt']`,
`packages/core/tools/src/index.ts:787-788`). Plugin config schema
`packages/core/tools/src/index.ts:790-793`
(`mode: 'native' | 'code' | 'both'`, default `'native'`; `maxParallelSubCalls`).

Stage order — `docs/tool-execution-pipeline.md:6`: "The `tools/pre-execute`
waterfall runs first, monotonic guards run next, and the `tools/execute` and
`tools/post-execute` waterfalls follow; the three waterfalls may transform a call.
Definition-owned `finalizeContent` and `tools/result` run afterward." Matching
executor JSDoc: `packages/core/tools/src/index.ts:1328-1332` ("Execute through
pre-policy, guards, around-dispatch, post-policy, definition-owned content
finalization, and final notification"), entry point
`async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult>` at :1342.

### 3.1 Event declarations (verbatim, with modes)

`packages/core/tools/src/index.ts:137-208` (declaration-merged into
`@deepseek-ai/cordis`):

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolRuntime
  }

  interface Events {
    /**
     * Allow, deny, or ask before dispatch. `next()` delegates to allow; missing
     * approval support turns `ask` into denial. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
```
(:152)

```ts
    'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
```
(:163 — around-dispatch waterfall "for timeout, retry, or metrics. `next()` returns
a normalized result; wrappers may change only `exec.signal`, while call identity
remains immutable", :154-159)

```ts
    'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
```
(:175 — "Accept, replace, enrich, or block a normalized dispatch result. `next()`
accepts it unchanged; thrown tools still reach this waterfall as errors", :164-169)

```ts
    'tools/code-dispatch-log'(this: Scoped<ToolRuntime>, dispatch: CodeDispatchLog, next: () => Promise<ContentBlock[]>): Promise<ContentBlock[]>
```
(:189 — durable-log copy of one `run_code` sub-dispatch; "A throwing listener is
contained: the bridge falls back to logging the original settled content", :182-184)

```ts
    /**
     * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): keyed by `exec.agent`.
     * @param exec - the execution object that traversed the pipeline.
     * @param result - a deep-frozen snapshot of the final returned result.
     * @mode emit
     */
    'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
```
(:197)

```ts
    'tools/change'(): void
```
(:207, `@mode emit` at :205 — registry membership changed; deliberately NOT
scope-filtered, :199-204)

Modes independently confirmed by the generated matrix
`docs/event-producer-consumer.md:55-59` (pre/execute/post/code-dispatch-log =
`waterfall`, result/change = `emit`; also lists in-tree listeners — e.g.
`tools/post-execute` ← hooks-claude-code, hooks-codex, repeat-tool-reminder,
spill-policy, tool-fs-search at :57).

### 3.2 What a pre-policy listener receives

`ToolExecution` — `packages/core/tools/src/index.ts:379-384`, extending
`ToolExecutionInput` (:314-338):

```ts
export interface ToolExecutionInput {
  readonly callId: CallId
  /** Root model-requested call owning this execution tree. ... */
  readonly rootCallId?: CallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /** Opaque token of the enclosing transport execution, when one exists. ... */
  readonly parent?: ToolExecutionToken
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}
...
export interface ToolExecution extends ToolExecutionInput {
  /** Root model-requested call, resolved for every root and nested execution. */
  readonly rootCallId: CallId
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: ToolExecutionToken
}
```

Session/agent refs: `exec.agent` is the live `Agent`
(`packages/core/agent/src/runtime-types.ts:64-76` — `id: SessionId`,
`session: Session`, `ctx: Context`, `options`, `inbox`, `status`). Arguments are
deep-frozen after one lossless-JSON materialization (`packages/core/tools/src/index.ts:372-377`).

`ToolDispatchExecution` (around stage) — :391-394: same minus readonly `signal`
(`signal: AbortSignal` mutable for the wrapped lifetime).

`CodeDispatchLog` — :357-370: `{ exec: ToolExecution; agent?: Agent; subCallId: CallId;
name: string; isError: boolean; content: ContentBlock[] }` (sub-call id format
`<parent>:code:<n>`, :362).

### 3.3 How a listener BLOCKS a call — decision objects, not throws

Pre stage — return a decision object WITHOUT calling `next()`.
`packages/core/tools/src/index.ts:582-591`:

```ts
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes an error;
 * `ask` runs only after an approval service returns `allowed-once` and otherwise
 * denies. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
```

Post stage — `packages/core/tools/src/index.ts:593-600`:

```ts
/**
 * Post-dispatch decision: accept, replace one projection, attach context for the
 * next request, or block by turning corrective feedback into an error result.
 */
export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }
```

Result vocabulary — `packages/core/tools/src/index.ts:555-580`:

```ts
export interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** The agent loop stops after committing this successful result batch. */
  readonly concludesTurn?: true
}

export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}

/** The discriminated, execution-local outcome of one tool call. */
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure
```

(`ToolFailure`: `{ message: string; info?: { name: string; code: string } }` — :475-486.
Cancellation codes `TOOL_ABORTED = 'ABORTED'` / `TOOL_ABORTED_BEFORE_DISPATCH` — :468-472.)

Waterfall semantics generally — `docs/cordis-primer.md:30-34`: "Call `next()` to
delegate ... return without `next()` to short-circuit. ... For single-decision
events, short-circuiting is the design." Use `{ prepend: true }` "only when the
listener must run before ordinary registrations" (:32).

### 3.4 Monotonic guards

`packages/core/tools/src/index.ts:703-711`:

```ts
/**
 * A monotonic execution guard evaluated after every `tools/pre-execute`
 * listener and before the tool body. Returning a reason denies the call;
 * returning `undefined` leaves it unchanged. Because guards have no allow
 * result, listener ordering cannot turn a denial back into permission.
 * @param execution - the identity-protected call after extensible pre-execute policy completed.
 * @returns a final denial reason, or `undefined` to leave the call allowed.
 */
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined
```

Registration — `packages/core/tools/src/index.ts:1100-1116`:

```ts
  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: ToolGuard): () => void {
```

Guard evaluation order: global layer first, then the agent scope chain
farthest-first (:1118-1128).

Also relevant: `ToolRuntime.register(definition: ToolDefinition): () => void`
(:1037), `restrict()` (:1093-1097), and the `Scoped<T>` brand
`packages/core/scope/src/index.ts:27` —
`export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }`.

### 3.5 How spill-policy registers its listener (exact call)

`packages/spill/spill-policy/src/index.ts:190-209`:

```ts
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Delegate first so a downstream listener (e.g. a hook) settles the result;
    // we bound whatever it accepted. A block passes through — spill only shapes
    // accepted plain-text results, never corrective feedback.
    const decision = await next()
    // Skip `read` to avoid a read → spill → read again loop.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
      || exec.parent !== undefined || exec.name === 'read') return decision

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= maxInlineBytes) return decision

    const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, 'result')
    if (replacedText === undefined) return decision
    const replaced: ContentBlock[] = [{ type: 'text', text: replacedText }]
    return { kind: 'accept', content: replaced, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  }, { prepend: true })
```

and the second arm `ctx.on('tools/code-dispatch-log', async (dispatch, next):
Promise<ContentBlock[]> => { ... }, { prepend: true })` at :217-231. Note the
no-op contract: omitted config ⇒ `apply` returns before registering anything
(:112-113).

`ctx.on` signature — `vendor/cordis/src/events.ts:97`:

```ts
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

with `EventOptions = { prepend?: boolean; global?: boolean }` (`vendor/cordis/src/events.ts:111-117`).

### 3.6 fs event gate (the sibling pattern for provider-seam gating)

Declared in the provider package `packages/fs/fs/src/index.ts:49-77` (within
`declare module '@deepseek-ai/cordis'`):

```ts
    /**
     * Single-slot decision for the next {@link FileSystem.writeText}. Calling
     * `next()` yields the bare provider's unconditional write; the first listener
     * that returns an intent owns the decision rather than composing with peers.
     * @mode waterfall
     */
    'fs/write-intent'(target: FsTarget, actor: object | undefined, next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>): Promise<FsWriteIntent | undefined>
    'fs/edit-intent'(target: FsTarget, actor: object | undefined, next: () => { version: FsVersion } | undefined | Promise<{ version: FsVersion } | undefined>): Promise<{ version: FsVersion } | undefined>
    /**
     * Record an authoritative positive or negative observation. Listeners must
     * be synchronous recorders: throws fail the tool call and returned promises
     * are not awaited.
     * @mode emit
     */
    'fs/observed'(target: FsTarget, observation: FsObservation, actor: object | undefined): void
```

Consumed by fs-observation-policy — `packages/fs/fs-observation-policy/src/index.ts:116-129`:
single-slot occupancy = return the decision, do NOT call `next()`; async throws are
deferred through `Promise.resolve().then(...)` so they reject instead of escaping
synchronously (:117-122); rejections use typed `FsError` codes `FS_NOT_OBSERVED` /
`FS_NOT_FOUND` (:78-88).

---

## 4. AGENT/PRE-STEP

Decision type — `packages/core/agent/src/runtime-types.ts:52-55`:

```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }
```

Event declaration — `packages/core/agent/src/runtime-types.ts:220-231`:

```ts
    /**
     * Reject a proposed step or replace the messages that enter it. Calling
     * `next()` preserves the current messages.
     * @param payload.agent - the agent proposing the step.
     * @param payload.messages - messages removed from the inbox for this step.
     * @param payload.turn - the turn that will own the step.
     * @param payload.step - the step proposed by the loop.
     * @param payload.signal - the current turn's cancellation signal.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent's calls.
     * @mode waterfall
     */
    'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

Dispatch site (the loop's default `next` is `enter` with the claimed messages plus
the runtime-context snapshot) — `packages/core/agent-loop/src/agent.ts:234-242`:

```ts
    const decision = await this.dispatch.waterfall(
      'agent/pre-step', { messages: claimed, ...position, signal },
      (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
        kind: 'enter',
        messages: context === undefined ? claimed : [...claimed, context],
      }),
    )
    signal.throwIfAborted()
    return decision.kind === 'reject' ? decision : { ...decision, assembly }
```

Authority — `docs/agent-lifecycle.md:78`: "The returned `agent/pre-step` decision
is authoritative; listeners wrapping `next()` preserve downstream messages unless
replacement is intentional. Steering and injected context pass through the same
waterfall after a later claim operation takes their next-step batch."

**To reject**: return `{ kind: 'reject' }` without calling `next()`. Proven effects
(`packages/core/agent-loop/tests/interception.spec.ts:234-255`): the model is never
called, the turn closes `turn/start` → `turn/end` with `reason { kind: 'blocked' }`,
no `user/message` and no `step/start` are logged:

```ts
    ctx.on('agent/pre-step', async (): Promise<PreStepDecision> => ({ kind: 'reject' }))
```
(:239)

Claimed-message fate on reject — `packages/core/agent/src/runtime-types.ts:188-190`
(`agent/inbox/claimed` JSDoc): "If the proposed step is rejected, the claimed
message ends here: it is neither discarded nor re-emitted as a user/message, and
the turn closes without a step."

**`enter(messages)`** = `{ kind: 'enter', messages }`: the returned `messages`
array IS what enters the step (recorded as `user/message` events and sent to the
model). A listener can pass through (`return next()`,
`packages/core/agent-loop/tests/interception.spec.ts:68-71`), rewrite the prompt
(test "enter with content rewrites the prompt before it is recorded", :159), or
append separately-sourced context (test :180). `UserMessage` construction:
`createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })`
(`packages/core/agent-loop/tests/interception.spec.ts:53-55`; exported from
`@deepseek-ai/dsh-llm`, re-exported message vocabulary
`packages/llm/llm/src/types.ts:27-37`).

Sibling extension points a gate may need (same file):
`'agent/request'` waterfall replacing the frozen `LlmCallConfig`
(`packages/core/agent/src/runtime-types.ts:244`), `'agent/request-error'` waterfall
returning `{ kind: 'retry' } | undefined` (:260, type :58), `'agent/turn-stopping'`
serial (:278), `'agent/session-start'` emit (:217) — seed model-facing context with
`agent.inject()` (:208-210).

---

## 5. CTX.LLM JUDGE SURFACE

Service key `llm` (`packages/llm/llm/src/index.ts:284-293`,
`class LlmRuntime extends Service` / `super(ctx, 'llm')`; default export :947).

### 5.1 Minimal non-UI model call = `ctx.llm.stream()` + `BlockAssembler`

There is **no oneshot helper** in `packages/llm/llm` (verified: no
oneshot/generateText/collectText symbol in packages/llm or packages/core src —
grep over the slice). The canonical pattern is stream + collect.

`packages/llm/llm/src/index.ts:902-915`:

```ts
  /**
   * Stream one model call as raw chunks (token-level deltas). ...
   * Adapter selection, dispatch, and iteration failures become terminal `error`
   * or `aborted` finish chunks; middleware, nested-call, cleanup, and consumer
   * failures remain thrown.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithRegistration(options)
  }
```

Request shape — `packages/llm/llm/src/types.ts:340-377`:

```ts
/** A single model request, fully assembled. */
export interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (dsh-agent-loop); a hand-built one-shot passes any list.
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
  /** Provider-neutral classification for an auxiliary model call. ... */
  purpose?: 'compaction' | 'session-title'
}
```

(Note :350-351: "a hand-built one-shot passes any list" — this is the sanctioned
judge-call idiom. `purpose` is merge-extensible only via this union today.)

Chunk protocol — `packages/llm/llm/src/types.ts:312-324` (`StreamChunk` union:
`block-start | text-delta | reasoning-delta | tool-call-delta | block-end | usage |
finish{reason, replayState?}`). Failure normalization contract: model-request
failures surface ONLY as terminal `finish {kind:'error'|'aborted'}` chunks
(`docs/defensive-patterns.md:13`; `packages/llm/llm/src/index.ts:930-939`).

Collector — `packages/llm/llm/src/assembler.ts:36,47,156,166,184`:

```ts
export class BlockAssembler {
  push(chunk: StreamChunk): void { ... }        // :47
  blocks(): ContentBlock[] { ... }              // :156
  get finish(): FinishReason { ... }            // :166  ({kind:'stop'} when absent)
  message(source: MessageSource = { kind: 'plugin', plugin: 'dsh-llm/assembler' }): Message { ... }  // :184
}
```

So a judge call inside a policy plugin is:

```ts
const assembler = new BlockAssembler()
for await (const chunk of ctx.llm.stream({ provider, model, messages, system, signal })) assembler.push(chunk)
const verdictText = assembler.blocks()   // check assembler.finish.kind first
```

(`ctx.llm.stream(...)` drive pattern proven in-tree at
`packages/test-support/llm-replay/tests/llm-replay.spec.ts:503` —
`await drain(ctx.llm.stream({ provider: 'm', model: 'm', messages: [] }))`.)

### 5.2 Model choice for a plugin

- `GenerateOptions.provider` selects a registered adapter route; `model` is
  interpreted by that adapter (`packages/llm/llm/src/types.ts:342-344`).
- Reuse the calling agent's route: `agent.options` is
  `{ provider?: string; model?: string; maxTokens?: number }`
  (`packages/core/agent/src/runtime-types.ts:24-31`, surfaced on the live handle
  at :67-68) — e.g. `exec.agent.options.provider` / `.model` inside a tools listener.
- Or take provider/model as plugin config, like every example composition does for
  agents (`examples/headless-agent/cordis.yml:44-53`).
- Discovery/validation: `ctx.llm.listProviders()` (`packages/llm/llm/src/index.ts:419`),
  `listModels(provider)` (:581), `resolveModelInfo` (:619); catalog membership is
  advisory, never request rejection (:199-203).
- Adapters mount from config, e.g. `examples/headless-agent/cordis.yml:23-32`
  (`@deepseek-ai/dsh-llm-deepseek`, `models: [{ id: deepseek-v4-pro, ... }]`).
- Interception seam: `'llm/stream'` waterfall wraps every call
  (`packages/llm/llm/src/index.ts:921-926`; declared at :51-64 per
  `docs/event-producer-consumer.md:39`).

### 5.3 llm-replay (test-support): fixture format + wiring

Module `@deepseek-ai/dsh-llm-replay` (`packages/test-support/llm-replay/src/index.ts:7`).

Fixture = a recorded **session log `session.jsonl`**: "Line 0 is the session header
(a `{type:'session',…}` record), every subsequent non-empty line is a" session
event (`packages/test-support/llm-replay/src/index.ts:159-161`; parsers
`parseSessionLog` :167, `parseSessionHeader` :183). The per-call replay script is
derived from `assistant/chunk` events — `deriveReplayScript(events: SessionEvent[]):
ReplayEntry[]` :206; header doc :1-8: "It derives one model-call script per recorded
session from `assistant/chunk` events ... Throw and hang cases require an explicit
override".

Real committed fixture — `examples/headless-agent/tests/snapshots/pty-tools/session.jsonl:1`:

```json
{"type":"session","version":0,"id":"{{sessionId}}","createdAt":0,"cwd":"{{cwd}}","delegationDepth":0}
```

and a chunk line (same file, the `seq: 9` record):

```json
{"type":"assistant/chunk","seq":9,"time":0,"data":{"turn":1,"step":1,"chunk":{"type":"block-start","index":0,"blockType":"tool-call"}}}
```

Entry/config vocabulary — `packages/test-support/llm-replay/src/index.ts:36-43`:

```ts
export type ReplayEntry =
  | { kind: 'chunks'; chunks: StreamChunk[] }
  | { kind: 'throw'; chunks: StreamChunk[]; message: string; code: string }
  | { kind: 'hang'; readyFile?: string }
```

`ReplayConfig` :84-121 (`file`, `overrideFile` sidecar — "a bare `ReplayEntry[]`
replaces the derived script; `{ patches }` keeps it and swaps the named call
indexes" :92-95, `childFiles`, `providers`, `paceMs`).

Wiring in place of a live provider — `installLlmReplay(ctx: Context, config:
ReplayConfig): ReplayHandle` :697; the crux :748-751:

```ts
  const providers = config.providers ?? []
  const dispose = providers.length > 0
    ? ctx.llm.registerAdapter(providers.map(provider => provider.id), new ReplayAdapter(providers, replay))
    : ctx.on('llm/stream', (options: GenerateOptions, _next) => replay(options))
```

i.e. either a real routed adapter registration or a catch-all `llm/stream`
waterfall listener that never calls `next()`. `ReplayHandle` :129-138 =
`{ dispose(): void; assertConsumed(): void }` (call `assertConsumed` at teardown —
underruns throw, :754-768). It is also mountable as a plugin from `cordis.yml`
(`export const name = 'llm-replay'` / `export const inject = ['llm']` :772-773;
`apply` :809-826 defaults from `$DSH_SNAPSHOT_FILE`, `$DSH_SNAPSHOT_OVERRIDE`,
`$DSH_SNAPSHOT_CHILD_FILES`).

For unit tests the lighter house pattern is a scripted `LlmAdapter` — see §7.

---

## 6. CUSTOM TYPED EVENTS (declaring `write-gate/contradiction`)

Pattern: **TypeScript declaration merging into `interface Events` of
`@deepseek-ai/cordis`**, with a JSDoc `@mode` tag. Convention source —
`docs/cordis-primer.md:12` ("Services declare event names through TypeScript
declaration merging, then dispatch them as `emit`, `waterfall`, `parallel`, or
`serial`") and :26 ("The dispatch mode is part of the event's public contract. New
harness events document it with an `@mode` tag so the generated catalog can check
declarations against dispatch sites." — the generated checker output is
`docs/event-producer-consumer.md:8-66`).

Smallest in-tree example (payload-free emit) — `packages/llm/llm/src/types.ts:12-25`:

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The provider topology changed: ...
     * Observer failures are contained and cannot veto the registry mutation.
     * @mode emit
     */
    'llm/adapters-updated'(): void
  }
}
```

Waterfall example with payload + scope filtering —
`packages/interaction/user-approval/src/index.ts:17-32`:

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    approval: ApprovalService
  }

  interface Events {
    /**
     * Ask composed answerers for one decision. Return an outcome to claim the
     * request or call `next()`; failure yields the fail-closed default.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param req - the pending decision (agent, tool identity, reason, signal).
     * @mode waterfall
     */
    'approval/request'(this: Scoped<ApprovalService>, req: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>
  }
}
```

So for the write gate, in the plugin's own src:

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A write-gate contradiction was detected. <doc...>
     * @mode emit
     */
    'write-gate/contradiction'(payload: WriteGateContradiction): void
  }
}
```

Dispatch with the matching Context method (`vendor/cordis/src/events.ts:44-88`):
`emit` (:53, sync, ignores returns), `parallel` (:44, awaited, concurrent),
`serial` (:63, awaited in order until one bails), `bail` (:73), `waterfall` (:86 —
"Each listener wraps the rest of the chain: calling `next()` invokes the next
listener (finally the built-in behavior); not calling it vetoes"). The full
runtime mode union includes `bail` — `vendor/cordis/src/events.ts:32`:
`export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall'`
(harness `@mode` tags in the slice use only emit/waterfall/parallel/serial, per
`docs/event-producer-consumer.md:8-66`).

Naming: `<domain>/<event>` kebab-case, domain = the owning seam
(`docs/architecture.md:53-59`: session events for durable facts (:57), `agent/*`
for in-flight work, capability events like `fs/*`, `tools/*` for seam policy (:59)).

Related but distinct merge target — **durable session events** go into
`SessionEventMap` of `@deepseek-ai/dsh-session/types` instead, e.g.
`packages/sandbox/sandbox-policy/src/session-mode.ts:24-39`:

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The session's sandbox mode was switched — log-only (like `approval/*`;
     * NOT a surface event, carries no `surfaceOp`): durable and replayable,
     * never in the model transcript. ...
     */
    'sandbox/mode': {
      mode: SandboxMode
      /** Marks an override seeded into a child at delegation. */
      source?: 'delegation'
    }
  }
}
```

written via `session.append('sandbox/mode', { mode })`
(`packages/sandbox/sandbox-policy/src/session-mode.ts:69-71`) and folded back from
`session.events` (:52-58). If a contradiction must survive restart/replay, declare
it there (an audit-pair precedent: `approval/asked`/`approval/decided`,
`packages/interaction/user-approval/src/index.ts:34-73`); if it is live-only
coordination, use the Cordis `Events` merge.

---

## 7. TESTING HOUSE STYLE

### 7.1 vitest conventions

- **One root config**, no per-package vitest configs (the policy packages contain
  only `package.json`, `src/`, `tests/`, `tsconfig.json`, README — directory
  listing of `packages/spill/spill-policy`, `packages/fs/fs-observation-policy`).
- Test discovery: `vitest.config.ts:85-90` —
  `const testIncludes = ['packages/*/*/tests/**/*.spec.{ts,tsx}', 'apps/*/tests/**/*.spec.ts', 'examples/*/tests/**/*.spec.ts', 'scripts/**/*.spec.ts']`.
- Pool `'forks'`, setup `./scripts/test-invariants.ts`, projects `thread-safe` /
  `process-bound` (`vitest.config.ts:126-160`; `pool: 'forks'` at :135,:150).
- Coverage gate: v8, include `'packages/*/*/src/**/*.{ts,tsx}'`
  (`vitest.config.ts:166`), **per-file 100% statements/branches/functions/lines**
  (`vitest.config.ts:273-279`; comment :269 "100% or it doesn't merge
  (docs/testing.md: excessive tests are welcome)"). Every `v8 ignore` comment must
  carry a reason (:271-272).
- Source-mode TS with `vite-tsconfig-paths` over `tsconfig.base.json`
  (`vitest.config.ts:19`), shared decorator pre-transform `vitest.shared.ts:15-41`.

### 7.2 Booting a minimal context with tools + scripted llm and driving one step

Prerequisite mount helper — `packages/test-support/agent-loop-testkit/src/index.ts:37-46`:

```ts
export async function mountAgentLoopTestDependencies(
  ctx: Context,
  options: AgentLoopTestDependenciesOptions = {},
): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, options.systemPrompt ?? {})
  await ctx.plugin(ToolRuntime, options.tools ?? {})
  await ctx.plugin(AgentRegistry)
}
```

(default imports: `AgentRegistry from '@deepseek-ai/dsh-agent'`, `LlmRuntime from
'@deepseek-ai/dsh-llm'`, `SessionStore from '@deepseek-ai/dsh-session'`,
`SystemPrompt from '@deepseek-ai/dsh-system-prompt'`, `ToolRuntime from
'@deepseek-ai/dsh-tools'` — :8-15. "The caller retains ownership of the context,
loop, adapters, optional plugins, and teardown" :2-4.)

The agent-loop specs inline the same mounts plus the loop and a scripted adapter —
`packages/core/agent-loop/tests/interception.spec.ts:30-55`:

```ts
async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
```

Driving one step and asserting — :62-79 (`ctx.agentLoop.create(SessionId('a1'),
{ provider: 'mock', model: 'mock' })`; `send(agent, 'hello')`;
`await waitForIdle(ctx, agent)`; assertions over `agent.session.events`). Tool
turns are scripted as `new MockAdapter([toolCallResponse('c1', 'echo', { text: 'hi' }),
textResponse('done')])` with a fixture tool registered via
`ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'echo',
parameters: { text: { type: 'string', required: true } }, execute: async ({ text })
=> [{ type: 'text', text }] }))` (:82-92).

`MockAdapter` (scripted `LlmAdapter` subclass; records requests; `'hang'` /
`'hang-slow'` markers for cancellation) —
`packages/core/agent-loop/tests/mock-adapter.ts:66-75,90`; chunk-script builders
`textResponse` :5-13, `toolCallResponse` :30-56.
`defineContentToolFixture(options): ToolDefinition` —
`packages/core/tools/src/testing.ts:27-29` (content blocks AS the canonical value;
"Product tools must declare domain-owned DTOs instead", :21-22; exported from
`@deepseek-ai/dsh-tools` per `packages/core/tools/src/index.ts:107`).

Policy-only tests skip the loop entirely and drive `ctx.tools.execute` directly —
`packages/spill/spill-policy/tests/spill-policy.spec.ts:68-84` (mount SystemPrompt +
ToolRuntime + a stub backend Service + the policy via `await ctx.plugin(SpillPolicy,
config)`, then `await ctx.tools.execute(exec('big'))` with a structural
`ToolExecution` stub, :58-62).

### 7.3 Committed .jsonl fixture conventions

- Snapshot suites keep per-scenario dirs `examples/<name>/tests/snapshots/<scenario>/`
  containing `session.jsonl` (replay input), `session.expected.jsonl`,
  `stdout.expected.jsonl` / `stream-json.expected.jsonl`, and for nested-agent
  scenarios `parent.replay.jsonl` / `child.replay.jsonl` + `child.expected.jsonl`
  (directory listing of `examples/acp-agent/tests/goal-snapshots/` and
  `examples/headless-agent/tests/snapshots/`).
- `docs/testing.md:12`: record with `pnpm run test:snapshot:record` when a model
  transcript changes, `pnpm run test:snapshot:refresh` when replay input remains
  valid; "review every JSONL and expected-output diff".
- `docs/testing.md:15`: "Committed session-format JSONL uses the canonical
  packed-row layout, and the keyless snapshot gate discovers every such fixture by
  its `session` header".
- `docs/testing.md:49`: "Every non-trivial model-, protocol-, or human-visible
  change adds or updates a keyless scenario in the same PR"; ACP scenarios under
  `examples/<name>/tests/snapshots/`, headless owns the canonical-event JSONL
  replay fixtures.
- Fixtures tokenize volatile fields (`"id":"{{sessionId}}"`, `"cwd":"{{cwd}}"`) —
  `examples/headless-agent/tests/snapshots/pty-tools/session.jsonl:1`.

---

## 8. DISPOSAL / DEFENSIVE CHECKLIST

**Core rule** — `docs/cordis-primer.md:13,44`: "Registrations are reversible
effects ... installed through `ctx.effect()` or `ctx.on()` so reload and teardown
unwind them predictably"; "Every registration should have a disposer ... If
teardown order matters, keep the related work in one effect so disposal unwinds in
the intended sequence."

`ctx.effect` signature — `vendor/cordis/src/fiber.ts:402-418`:

```ts
  /**
   * Register a cleanup-aware effect on this fiber.
   *
   * `execute` runs immediately; the disposers it produces are collected and
   * run (in reverse order) either when the returned disposer is called or
   * when the fiber unloads, whichever comes first. Calling the disposer twice
   * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
   * already disposed, and `TypeError` if `execute` returns an invalid shape.
   *
   * @param execute — the effect body; see {@link Effect} for accepted shapes.
   * @param label — effect label shown in `getEffects()` diagnostics.
   * @returns a disposer that tears the effect down and settles once done.
   */
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

Concrete in-tree disposer examples:

1. Policy state teardown with a label (HMR safety) —
   `packages/fs/fs-observation-policy/src/index.ts:109-114`:

```ts
  ctx.effect(() => () => {
    // Drop all recorded state on disposal so a reloaded plugin starts clean
    // (HMR safety). The WeakMap itself would be GC'd, but replacing it makes the
    // release observable and immediate for tests.
    gate.clear()
  }, 'fs-observation-policy observed-state teardown')
```

2. Registry APIs return **the exact effect disposer**: `tools.register()`
   (`packages/core/tools/src/index.ts:1035,1057-1061` — `return this.layers.effect(
   this.ctx, layer => layer.tools.insert(name, definition), { label: 'tools.register()' })`),
   `tools.guard()` (:1108-1115, label `'tools.guard()'`), `tools.restrict()`
   (:1093-1097). `ctx.on(...)` itself returns a disposer
   (`vendor/cordis/src/events.ts:95-97` — "a disposer removing the listener").
3. Composing several listener disposers into one —
   `packages/core/agent/src/model-selection.ts:40-75` (`installModelSelection`
   registers two `agentCtx.on(...)` listeners and returns
   `() => { disposeAssembly(); disposeRequest() }`).
4. Freestanding-closure disposers are documented safe to destructure —
   `packages/test-support/llm-replay/src/index.ts:129-138`
   (`dispose(this: void): void`).

Defensive patterns that bind on a policy plugin (`docs/defensive-patterns.md`):

- **Contain callback exceptions** (:23-25): "A user-supplied listener that throws
  must not reject the promise it runs inside or starve the listeners after it.
  Wrap the dispatch loop in try/catch and log; one bad subscriber never breaks
  core lifecycle." Harness dispatchers already contain observers —
  `tools/result` "Listener failures are contained"
  (`packages/core/tools/src/index.ts:191`), `tools/code-dispatch-log` throwing
  listener contained (:182-184), `llm/adapters-updated` observers contained
  (`packages/llm/llm/src/types.ts:20`) — but waterfall decisions are NOT contained
  (a throwing `agent/pre-step` listener reports a driver error:
  `packages/core/agent-loop/tests/interception.spec.ts:516`), so a gate's judge
  path must catch its own failures.
- **Async teardown awaited / quiescence** (:19-21): "Make cleanup async and await
  the children's exit (kill → await `done`), and close listener/notification
  registries BEFORE killing so late completions stay silent." Mirrored in the
  tools contract: async gates "must observe `exec.signal`; the registry rechecks
  cancellation after they settle but never abandons their promise"
  (`packages/core/tools/src/index.ts:145-148`); around wrappers "must still
  restore their signal and reach quiescence" (:158-159); tool bodies "settle only
  after ... owned work reaches quiescence" (:227-230).
- **Report orthogonal outcomes independently** (:7-9) and **normalize at the
  public boundary** (:11-13).
- **Never hand untrusted output the ambient environment or predictable paths**
  (:27-29) — scrubbed env, 0700 dirs, `'wx'`/0o600 exclusive opens.

Policy-specific defensive idioms proven in the three plugins:

- **No-op on omitted config** — register nothing at all
  (`packages/spill/spill-policy/src/index.ts:112-113`).
- **Fail the deployment, not the tool** — validate config at load
  (`packages/spill/spill-policy/src/index.ts:114-119`).
- **Best-effort transforms never convert success into error** — missing backend /
  missing owner / storage failure ⇒ log `ctx.logger.warn` and return the original
  (`packages/spill/spill-policy/src/index.ts:33-35,138-161`); optional service
  access via `ctx.get('spillStore')` instead of hard `inject`
  (:142-145; `ctx.get` — `vendor/cordis/src/reflect.ts:17-19`).
- **Own only weakly-keyed state** so a collected session frees it —
  `private observed = new WeakMap<object, Map<string, FsObservation>>()`
  (`packages/fs/fs-observation-policy/src/index.ts:22-28`); one state instance per
  `apply()` so disposal drops it (:17-20).
- **Match the event's sync/async contract** — `fs/observed` "must remain
  synchronous and non-throwing: emit does not await promises"
  (`packages/fs/fs-observation-policy/src/index.ts:124-129`); single-slot waterfall
  throws deferred via `Promise.resolve().then(...)` (:117-122).
- **`prepend: true` only when the listener must wrap ordinary registrations**
  (`docs/cordis-primer.md:32`; spill-policy uses it to bound whatever downstream
  listeners accepted, `packages/spill/spill-policy/src/index.ts:190-209`).

---

## 9. UNKNOWNS

Everything below could not be pinned to source in the sparse slice — do not build
on it without opening the named files in a full checkout.

1. **Bundle/profile internals**: `packages/bundle/*` (dsh-base, web-app, headless)
   and `packages/boot/app-boot` are NOT in the slice; the `dsh.profile` /
   `dsh.bundle` package.json field shapes, the `cordis.patch.yml` patch-row
   grammar (beyond the `insert:` form quoted from
   `examples/acp-agent/fs.cordis.yml:8-17`), and the Harness-home profile layout
   are docs-sourced only (`docs/architecture.md:15-33`). QUERY/DOC-ONLY.
2. **`apps/`** (CLI/web product trees, `--profile` handling, `$DSH_HOME`
   layout) absent from the slice; `$DSH_HOME/settings.yaml` behavior known only
   from a config comment (`examples/headless-agent/cordis.yml:6-8`).
3. **No oneshot LLM helper found** — negative claim grounded in a grep over
   `packages/llm` + `packages/core` src for oneshot/generateText/collectText (no
   hits) plus the `packages/llm/llm/src` file inventory; in-tree auxiliary LLM
   consumers that would demonstrate the judge idiom end-to-end (compaction-basic,
   session-title — listed as `llm/stream`-adjacent consumers in
   `docs/event-producer-consumer.md:39`) are outside the slice, so §5.1's composed
   idiom is assembled from `stream()` + `BlockAssembler`, not quoted from one
   shipped consumer. Treat "no oneshot helper anywhere in dsh" as
   QUERY-ONLY (unproven beyond this slice).
4. **Hook-bridge ordering**: hooks-claude-code / hooks-codex listen on
   `tools/pre-execute` and `tools/post-execute`
   (`docs/event-producer-consumer.md:57-58`); their sources
   (`packages/hooks/hooks-claude-code`, present in the slice) were not opened, so
   the relative ordering guarantees between an out-of-tree write gate and the hook
   bridges (registration order vs `prepend`) are unverified beyond the generic
   rule at `docs/cordis-primer.md:32`.
5. **Agent-scoped registration mechanics**: per-event JSDoc promises scope-filtered
   dispatch and `agent.ctx` exists
   (`packages/core/agent/src/runtime-types.ts:75-76`;
   `packages/core/tools/src/index.ts:148,1102-1103` "one registered through
   `agent.ctx` applies only to that agent"), but no in-tree example of a policy
   registering a listener through `agent.ctx` was opened, and the this-arg
   filtering implementation (`Scoped` carrier `packages/core/scope/src/index.ts:27,170`
   ↔ `vendor/cordis/src/events.ts` filter path) was not traced.
6. **Loader-side `Config` schema validation**: the loader validates config against
   the plugin's `Config` (StandardSchemaV1 —
   `vendor/cordis/src/registry.ts:103-104`) and spill-policy's tests prove load
   rejection propagates through `ctx.plugin`
   (`packages/spill/spill-policy/tests/spill-policy.spec.ts:117-123`), but the
   exact loader/registry validation call path in `vendor/loader` /
   `vendor/cordis/src/registry.ts` was not read line-by-line, nor whether the
   config-catalog cross-check imposes constraints on an out-of-tree package
   (`docs/config-catalog.md:6` describes the generator for in-repo packages only).
7. **`ctx.spillStore` etc. optional-service typing**: `ctx.get('spillStore')`
   returns the augmented type via declaration merge
   (`packages/spill/spill/src/index.ts:25`), and `packages/core/tools/src/index.ts:18-20`
   notes the type-only import trick (`import type {} from
   '@deepseek-ai/dsh-user-approval'`) that makes `ctx.get('approval')` resolve —
   but `Service.check` availability semantics (`vendor/cordis/src/service.ts:14-15`,
   `reflect.provide`) were not traced.
8. **Publishing mechanics for an out-of-tree package** (build tooling — the repo
   uses `tsdown.config.ts` per package, e.g.
   `packages/sandbox/sandbox-policy/tsdown.config.ts` exists in the file listing —
   and whether `lib/` output layout is required by the loader beyond the exports
   map): not examined; the loader itself only needs an importable module
   (`vendor/loader/src/config/tree.ts:145-159`).
