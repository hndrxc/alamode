# omp-alamode

One install for four [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi) plugins by Carter Hendricks, plus a built-in, opt-in usage-awareness extension.

`omp-alamode` is a small npm package that depends on the four upstream plugins and exposes each one as its own extension entry. Installing it gets you the Discord ask relay, the usage leaderboard, the live agent tree, and fly mode without installing each package separately. It also includes one first-party extension that can add current context, session, and provider-quota facts to the model's context when you explicitly turn it on.

## Install

Once `omp-alamode` is published to npm:

```sh
omp plugin install omp-alamode
```

`omp plugin install` resolves packages from the npm registry, so this command only works after the package is published. Start a new `omp` session after installing.

### Local development

```sh
git clone https://github.com/hndrxc/alamode.git
cd alamode
bun install
omp plugin link .
```

Use `omp plugin link .` while working from a checkout. It registers a link to this directory so edits are picked up without republishing.

## What it installs

| `omp.extensions` entry | Source | Adds |
| --- | --- | --- |
| `src/lemmeaskchat.ts` | `omp-lemmeaskchat@^0.3.0` | Discord ask relay and away-mode conversation, `/lemmeaskchat` |
| `src/tokenmunchers.ts` | `omp-tokenmunchers@^0.2.0` | Token-usage reporting to a friend-group leaderboard, `/munch` |
| `src/let-me-see.ts` | `omp-let-me-see@^0.3.0` | Live multi-agent dashboard, `/agent-tree` |
| `src/flymode.ts` | `omp-flymode@^0.1.0` | Display-only fly-language masking, `/flymode` |
| `src/usage-awareness.ts` | Built in (no additional dependency) | Opt-in usage knowledge for the current call, `/usage-awareness` |

The first four entries are one-line re-exports of their dependencies' default factories. `src/usage-awareness.ts` is the one first-party implementation in this otherwise aggregate package; it uses the host's public extension interfaces only. Its helper `src/usage-knowledge.ts` formats the facts and is not a separate `omp.extensions` entry.

`package.json` lists all five entries individually in `omp.extensions` and the four upstream packages in `dependencies`. There is no custom activation layer for the upstream plugins and no extra configuration surface: npm installs the dependencies, and `omp` loads each entry as a normal extension.

The wrappers are deliberate. `omp`'s installed-plugin loader only activates extensions declared by packages it resolves directly; it does not walk transitive npm dependencies. The explicit dependency entries plus the four wrappers make each upstream plugin visible to the loader while still letting npm resolve versions normally.

## Usage awareness

`/usage-awareness` is off by default in every session. While off, the extension does not query provider quotas and injects no usage facts. Manual balance entry and clearing are accepted while off: they record local state only, do not enable awareness, and perform no provider query. The extension has no configuration file and does not persist its state.

```text
/usage-awareness                        toggle on/off
/usage-awareness on                     enable for this session
/usage-awareness off                    disable and stop injecting usage facts
/usage-awareness status                 show state; when on, show current usage knowledge
/usage-awareness balance <USD> [low-USD] record the current provider's remaining PAYG balance
/usage-awareness balance clear          remove the current provider's manual balance
```

### Session-only state

State is held in memory by the extension and starts `false`. Starting a new session, switching sessions, or branching resets it to off; resuming a session also starts off. `/usage-awareness on` must be reissued in each session. There is no setting written to disk.

While enabled, the extension supplies at most one ephemeral custom message (`customType: alamode-usage-awareness`, hidden from chat) per LLM call. It removes its previous injected message before adding the replacement, so calls do not accumulate copies. The message is outgoing context only: it is not appended to session history. Turning off while a provider report is still pending discards that work for injection purposes, so a late report cannot reappear after the toggle or produce a misleading "enabled" confirmation.

### Manual PAYG balance

For pay-as-you-go providers whose quota reports do not expose a usable dollar balance, you can enter the remaining credit manually for the current provider:

```text
/usage-awareness balance 25          record $25.00 remaining; low warning at $2.50 (default 10%)
/usage-awareness balance 25 5        record $25.00 remaining; low warning at $5.00
/usage-awareness balance clear       remove the current provider's manual estimate
```

Amounts are USD, may include decimals, and must be non-negative. The optional `low-USD` threshold is an absolute dollar amount; when omitted it defaults to 10% of the entered balance. A balance is associated with the model provider active when you enter it, and `clear` removes only that provider's entry. If no model provider is active, the command leaves the estimate unchanged. Switching providers does not transfer one provider's balance to another.

Provider-labelled accounting uses only session entries the host attributes to the current provider: assistant turns and `model_usage` entries (for example title-generation or cache-warm calls) that carry a provider-reported USD `Usage.cost.total`. All matching recorded entries count, including entries on branches that are no longer active. The baseline snapshots both the matching provider's recorded cost and recorded task/subagent spend at entry, so earlier spend is not deducted again.

Because task/subagent charges have no exact provider attribution, the remaining balance is reported as a conservative scenario range, both scenarios floored at zero:

- **Low scenario** subtracts provider-labelled spend plus all recorded task/subagent spend since entry, assuming every recorded child charge hit the current provider.
- **High scenario** subtracts only provider-labelled spend, excluding child charges.

These are scenario estimates, not guaranteed bounds; a budget cannot be certified.

Recorded child spend draws on the public `getUsageStatistics().subagentCost` and a traversal of task-result details, including nested `extractedToolData.task` entries, without double-counting overlapping records. Exact per-provider child attribution is not readily available through public task entries, and a task's final `resolvedModel` is unsafe for attribution because fallback can switch providers and later revert. Child `model_usage` and task/subagent spend not represented in task result details are therefore also missing.

Re-entering a balance replaces the starting amount and both baselines instead of adding to the previous estimate. This makes re-entry the manual correction path after a top-up, an external charge, or drift between the estimate and provider billing: enter the provider's actual remaining balance again. `clear` removes the estimate entirely.

Balances are in-memory, session-only state and reset on the same new/switch/resume/branch lifecycle as awareness itself. Nothing is written to disk or synchronized to the provider. Setting or clearing a balance while awareness is off does not enable it and performs no provider query; the local confirmation may still be shown. Low-balance warnings appear only while awareness is enabled, alongside the usage knowledge. They are phrased as “Possible … credit low” or “Possible … credit exhaustion,” use the low scenario, and are one-shot per balance entry; re-entry resets them. A warning is a reminder, not an enforcement mechanism.

Every balance display and reminder labels the value as an estimate—not an invoice, authoritative bill, or hard spending cap—and states that task/subagent charges are excluded from provider attribution. The two ends are scenario estimates, not guaranteed bounds; a budget cannot be certified. The estimate also excludes child `model_usage` and task/subagent spend not represented in task result details, spend from outside the current session, usage with no recorded USD cost, provider quotas and account balances, and any persistence across sessions. These omissions can make the estimate too high. It is not synchronized to provider billing, so confirm actual credit with the provider. Because the estimate is local, it can drift after pricing changes, discounts, concurrent use, or failed accounting.

### What it can add

- **Context window** for the active model, from `ctx.getContextUsage()`: tokens in use, the model's context window, percent used, and remaining/headroom.
- **Session usage and cost**, from `ctx.sessionManager.getUsageStatistics()`: input, output, cache-read, and cache-write tokens; total and orchestration counters; premium requests; and host-provided cost. The session cost figure already includes subagent cost; the manual balance estimate handles recorded child spend as an unattributed range rather than as provider-labelled cost. These are running session accounting figures, not an invoice.
- **Provider quota windows**, from `ctx.modelRegistry.authStorage.usage.reports({ provider })` for the current model's provider: normalized limits, remaining allowance, reset times, and report age. The extension does not contact provider endpoints directly; the host's usage service owns normalized reports, credential selection, caching, cooldowns, and upstream requests.
- **Manual PAYG balance estimate**, when you entered one for the current provider: a conservative scenario range whose low scenario also subtracts recorded task/subagent spend and whose high scenario subtracts provider-labelled spend only, plus low-scenario possible low/exhaustion reminders at your threshold. Child attribution gaps and unpriced usage are not deducted.

The generated text is compact and advisory. It may point out low context headroom, an exhausted or soon-resetting provider window, session spend, or a possible low/exhausted manual balance, but it never switches models, changes providers or credentials, aborts a task, compacts the session, or spends a provider reset. Those remain your decisions.

### Freshness and scope

Host usage reports are treated as fresh for at most five minutes; the host also retains a last-good report for up to 24 hours. The extension distinguishes those ages:

- A report up to five minutes old can be described as current, with its fetch age.
- An older retained report is not presented as current. Its limits are stale history, not a live allowance.
- A reset timestamp already in the past does not prove that allowance renewed; the extension treats renewed capacity as unknown until a fresh report says otherwise.
- Missing, expired, unavailable, or failed data is reported as unknown. The extension never fills gaps with a guessed percentage, token allowance, or reset time.

Provider quota reports are account- and credential-scoped snapshots. The extension:

- keeps model-specific limits only when they match the current model and retains limits marked shared;
- labels multiple reports as separate account snapshots and never sums them into one quota;
- does not claim to know which account or credential the host will use for inference, so a report cannot be treated as a guarantee for the active account;
- omits raw reports, raw error text, credentials, and account emails/IDs from model context, and treats provider-supplied text as untrusted data rather than instructions.

Context numbers describe the current request; they do not promise future compaction behavior. Session cost is host accounting, not a provider bill. Quota snapshots can lag the provider and can belong to another configured credential for the same provider.

### No setup required

The usage extension needs no API key, account, or configuration of its own. When you enable it, provider quota reads use auth already configured for the host and the current model's provider. While off it performs no provider queries and injects nothing; manual balance entry remains local state. Enabling awareness adds tokens to each request, so the facts and guidance are intentionally brief.

## Avoid duplicate registration

`omp-alamode` loads the same four upstream extensions as the standalone packages. Uninstall or disable `omp-lemmeaskchat`, `omp-tokenmunchers`, `omp-let-me-see`, and `omp-flymode` before using the aggregate, and do not load them with `omp -e` at the same time. Loading a standalone copy alongside `omp-alamode` registers its commands, events, and hooks twice.

There is no standalone `usage-awareness` package. Do not copy `src/usage-awareness.ts` into another loaded extension set; two loaded copies would both register `/usage-awareness` and could inject duplicate context.

## Setup and existing configuration

Installing the aggregate does not configure any of the bundled upstream plugins. Their existing setup flows, settings, and plugin-owned configuration files are left untouched and are reused as-is:

- `omp-lemmeaskchat` still needs its Discord bot token and user ID; the aggregate does not provision Discord credentials.
- `omp-tokenmunchers` still needs a leaderboard account and API key (`/munch login`); the aggregate does not create an account.
- `omp-let-me-see` and `omp-flymode` need no credentials. Fly mode stays off until you enable it.
- The built-in usage extension needs no setup. It reads provider quota only while explicitly enabled and does not configure credentials for any provider.

If you already had a standalone copy configured, its configuration remains in place. Do not recreate it.

## Requirements

- Bun `>=1.3.0` (declared in `engines`).
- `omp` (`@oh-my-pi/pi-coding-agent`) `>=18.20.2`, declared as the aggregate's optional peer dependency.

`18.20.2` is the verified baseline for the built-in extension's host interfaces: the public `ExtensionContext`, `ModelRegistry.authStorage`, the auth `UsageService.reports()` API, and the normalized `UsageReport` schema. The floor is not a claim that every bundled upstream plugin has been exercised on every later host version. `omp-let-me-see@0.3.0` targets an older host and still pins its own optional peer at `18.8.6`.

## Source and conventions

The four upstream wrappers mirror their factories; the upstream manifests are the source of truth for entrypoints and versions:

- `../lemmeaskchat/package.json`
- `../tokenmunchers/plugin/package.json`
- `../let-me-see/package.json`
- `../flymode/package.json`

The built-in extension lives entirely in this package:

- `src/usage-awareness.ts`: extension factory, `/usage-awareness` command, session lifecycle state, and context-hook injection.
- `src/usage-knowledge.ts`: reads public host interfaces and formats compact, scoped usage facts.
- `src/credit-balance.ts`: session-only, provider-keyed manual PAYG balance estimates and low-threshold reminders.

Everything is published as source TypeScript ESM with no build step. Each upstream plugin's own README is the place for that plugin's command details, configuration, and troubleshooting.

### Host compatibility evidence (omp v18.20.2)

These are the source references used for the built-in extension. Links are pinned to the verified `v18.20.2` release tag:

- [`ExtensionContext`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/extensibility/extensions/types.ts): `getContextUsage()`, read-only `sessionManager`, `modelRegistry`, and the extension/hook types.
- [`ModelRegistry`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/coding-agent/src/config/model-registry.ts): public read-only `authStorage`.
- [`UsageService`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/src/auth/usage.ts): `reports({ provider?, baseUrlResolver?, signal? })`, cache/cooldown coordination, and account-scoped report assembly.
- [`UsageReport`](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/src/usage.ts): normalized limits, windows, amounts, and scope metadata.
- [Usage cache](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/src/auth/usage-cache.ts): 24-hour last-good retention.
- [Usage report TTL](https://github.com/can1357/oh-my-pi/blob/v18.20.2/packages/ai/src/auth/sqlite-credential-store.ts): five-minute fresh-report tolerance.

The installed `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-ai` packages in this checkout both report version `18.20.2` and contain these interfaces.

## Verification

- 40 deterministic tests verified: 13 quota-knowledge tests passed in the initial three-file run; all 27 toggle/credit tests passed in the subsequent focused run. Coverage includes scope/freshness, session transitions and async races, provider-specific credit baselines, child-cost scenario ranges, and low-credit reminders.
- Compiled `omp` v18.20.2 smoke check in a temporary, credential-free profile: all five commands registered exactly once. Toggle, status, balance input/clear, invalid input, and new-session reset produced the expected command output, with no extension errors or model/message-start events.
- `npm pack --dry-run --json` includes all five extension entrypoints and both built-in helpers. Tests, the lockfile, installed dependencies, and the local agent guide are excluded.

Live provider quota endpoints, external Discord/leaderboard services, and other host versions were not exercised. No model prompt was sent; model-facing injection and credit depletion were covered by deterministic fake-host tests.

## License

MIT © Carter Hendricks
