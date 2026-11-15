# omp-alamode

Four [Oh My Pi (`omp`)](https://github.com/can1357/oh-my-pi) plugins in one package, plus optional usage awareness for context, costs, and provider quotas.

## Included features

| Feature | Command | Plugin |
| --- | --- | --- |
| Discord questions and away-mode conversations | `/lemmeaskchat` | `omp-lemmeaskchat` |
| Token-usage leaderboard | `/munch` | `omp-tokenmunchers` |
| Live multi-agent dashboard | `/agent-tree` | `omp-let-me-see` |
| Display-only fly-language masking | `/flymode` | `omp-flymode` |
| Context, session usage, quota information, and manual credit estimates | `/usage-awareness` | Built in |

The four upstream plugins keep their original behavior and configuration. This package loads them together; it does not replace their implementations or add a shared settings layer.

## Installation

Requires **Bun 1.3.0 or later** and **omp 18.20.2 or later**.

Once the package is published to npm:

```sh
omp plugin install omp-alamode
```

Start a new `omp` session after installing.

**Avoid duplicate loading:** uninstall or disable standalone copies of `omp-lemmeaskchat`, `omp-tokenmunchers`, `omp-let-me-see`, and `omp-flymode` before using this bundle. Do not load them separately with `omp -e` alongside it; commands and hooks would register twice.

### Setup

- **Discord relay:** requires a Discord bot token and your Discord user ID.
- **Leaderboard:** requires an account and API key; use `/munch login`.
- **Agent dashboard and fly mode:** no credentials required. Fly mode is off until enabled.
- **Usage awareness:** no separate credentials or setup. When enabled, it uses the host's existing provider configuration.

Existing plugin settings are reused and left untouched. See each upstream plugin's README for its full configuration and command reference:

- [lemmeaskchat](https://www.npmjs.com/package/omp-lemmeaskchat)
- [tokenmunchers](https://www.npmjs.com/package/omp-tokenmunchers)
- [let-me-see](https://www.npmjs.com/package/omp-let-me-see)
- [flymode](https://www.npmjs.com/package/omp-flymode)

## Usage awareness

Usage awareness gives the model a short usage summary for each request. It is **off by default** and must be enabled explicitly.

| Command | Action |
| --- | --- |
| `/usage-awareness` | Toggle on or off |
| `/usage-awareness on` | Enable for this session |
| `/usage-awareness off` | Disable and stop adding usage context |
| `/usage-awareness status` | Show the state and, when enabled, current usage information |
| `/usage-awareness balance <USD> [low-USD]` | Record a manual credit estimate for the current provider |
| `/usage-awareness balance clear` | Remove that provider's manual estimate |

When enabled, the summary can include:

- **Context window:** tokens used, capacity, and remaining space for the active model.
- **Session usage:** token counts and host-recorded costs, including subagent costs.
- **Provider quotas:** available limits, remaining allowance, reset times, and report age.
- **Manual credit estimate:** an estimated remaining dollar range, if you entered a balance.

These are separate measurements: context capacity is not a provider quota, and session cost is not a provider invoice.

### Privacy and limits

While off, the extension makes no provider quota queries and adds no usage context. Setting or clearing a manual balance while off only changes local state; it does not enable awareness or trigger a provider query.

All extension state is held in memory. Starting, resuming, switching, or branching a session resets awareness to off and clears manual balances. Nothing is saved to disk.

When enabled, quota reads go through the host's public, normalized usage service—not direct provider requests from this extension. Reports up to five minutes old are treated as fresh; older retained reports are historical only. Missing or failed data is unknown, and a past reset time does not prove that allowance has renewed.

Quota reports are account-scoped snapshots, not guaranteed allowance for the account used by the next request. Separate account reports are not combined. Raw reports, errors, credentials, and account identifiers are not added to model context.

The summary is temporary outgoing context, not saved chat history. Only one copy is added per request, and pending results are discarded after disabling. It adds a small amount of request context but never switches models, changes credentials, aborts tasks, or compacts the session.

### Manual pay-as-you-go credit estimates

If your provider does not report a usable dollar balance, enter its remaining credit manually:

```text
/usage-awareness balance 25
```

This records an estimated starting balance of **$25**, with a default low-credit threshold of **$2.50** (10%). To choose a different threshold:

```text
/usage-awareness balance 25 5
```

Amounts are non-negative USD values. The optional threshold is an absolute dollar amount. Each balance belongs to the model provider active when entered; switching providers does not transfer it. An active provider is required to set or clear a balance.

The extension records spending baselines when you enter the amount, so earlier recorded costs are not deducted again. It then shows two scenarios, each floored at zero:

- **Low scenario:** starting balance minus provider-labelled spending and all recorded task/subagent spending since entry, assuming those child charges used this provider.
- **High scenario:** starting balance minus provider-labelled spending only.

**Both are scenario estimates, not guaranteed bounds. They cannot certify a budget.** Task/subagent charges lack reliable provider attribution. Provider-labelled spending includes recorded assistant and `model_usage` costs for that provider, including entries on inactive branches. Child spending combines the host's subagent total with task-result details, including nested tasks, without double-counting overlaps.

The estimate excludes outside-session spending, usage without a recorded USD cost, child `model_usage`, and task/subagent spending absent from task-result details. It is not synchronized with provider billing, quotas, or account balances. Actual remaining credit may be lower; check your provider for the authoritative balance.

Re-enter the provider's current balance to correct the estimate after a top-up, outside charge, or billing drift. Re-entry replaces the amount and both spending baselines; it does not add credit to the previous estimate.

Possible low-credit and exhaustion reminders use the low scenario, appear only while awareness is enabled, and fire once each per balance entry. Re-entry resets them. They are reminders—not spending caps or enforcement.

## Compatibility

The declared host minimum is `@oh-my-pi/pi-coding-agent >=18.20.2`. The built-in extension uses the public host interfaces verified against that version.

This is not a guarantee that every bundled plugin works on every later host release. In particular, `omp-let-me-see@0.3.0` declares an older optional host peer, `18.8.6`; an optional peer does not establish compatibility.

Live provider endpoints, Discord, and leaderboard services require separate credentials and are not covered by the local deterministic tests.

## Local development

```sh
git clone https://github.com/hndrxc/alamode.git
cd alamode
bun install
omp plugin link .
```

`omp plugin link .` registers a persistent development link to your checkout. Use it only when you want your local plugin installation to load this directory.

Source TypeScript is published as ESM; there is no build step. Each upstream plugin has its own extension entry under `src/`. The built-in extension uses `usage-awareness.ts`, `usage-knowledge.ts`, and `credit-balance.ts`.

Run deterministic built-in extension tests and inspect the publish contents with:

```sh
bun test
npm pack --dry-run --json
```

Tests use fake host interfaces and require no provider credentials. They do not replace a compiled-host activation check or live-service testing.

## License

MIT © Carter Hendricks
