# omp-alamode

One install for all four [oh-my-pi (`omp`)](https://github.com/can1357/oh-my-pi) plugins by Carter Hendricks.

`omp-alamode` is a small npm package that depends on the four plugins and exposes each one as its own extension entry. Installing it gets you the Discord ask relay, the usage leaderboard, the live agent tree, and fly mode without installing each package separately.

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

| `omp.extensions` entry | Dependency | Adds |
| --- | --- | --- |
| `src/lemmeaskchat.ts` | `omp-lemmeaskchat@^0.3.0` | Discord ask relay and away-mode conversation, `/lemmeaskchat` |
| `src/tokenmunchers.ts` | `omp-tokenmunchers@^0.2.0` | Token-usage reporting to a friend-group leaderboard, `/munch` |
| `src/let-me-see.ts` | `omp-let-me-see@^0.3.0` | Live multi-agent dashboard, `/agent-tree` |
| `src/flymode.ts` | `omp-flymode@^0.1.0` | Display-only fly-language masking, `/flymode` |

Each `src/*.ts` file is a one-line re-export of the dependency's default factory. `package.json` lists all four wrappers individually in `omp.extensions` and all four packages in `dependencies`. There is no custom activation layer and no extra configuration surface: npm installs the dependencies, and `omp` loads the four entries as normal extensions.

The wrappers are deliberate. `omp`'s installed-plugin loader only activates extensions declared by packages it resolves directly; it does not walk transitive npm dependencies. The explicit dependency entries plus the four wrappers make each plugin visible to the loader while still letting npm resolve versions normally.

## Avoid duplicate registration

`omp-alamode` loads the same extensions as the standalone packages. Uninstall or disable `omp-lemmeaskchat`, `omp-tokenmunchers`, `omp-let-me-see`, and `omp-flymode` before using the aggregate, and do not load them with `omp -e` at the same time. Loading a standalone copy alongside `omp-alamode` registers its commands, events, and hooks twice.

## Setup and existing configuration

Installing the aggregate does not configure any of the bundled plugins. Their existing setup flows, settings, and plugin-owned configuration files are left untouched and are reused as-is:

- `omp-lemmeaskchat` still needs its Discord bot token and user ID; the aggregate does not provision Discord credentials.
- `omp-tokenmunchers` still needs a leaderboard account and API key (`/munch login`); the aggregate does not create an account.
- `omp-let-me-see` and `omp-flymode` need no credentials. Fly mode stays off until you enable it.

If you already had a standalone copy configured, its configuration remains in place. Do not recreate it.

## Requirements

- Bun `>=1.3.0` (declared in `engines`).
- `omp` (`@oh-my-pi/pi-coding-agent`) `>=18.18.3`, declared as the aggregate's optional peer dependency.

These are the aggregate's declared floors, not a claim that every bundled plugin has been exercised on every host version. `omp-let-me-see@0.3.0` targets an older host and still pins its own optional peer at `18.8.6`.

## Source and conventions

This scaffold follows the source-TypeScript ESM manifest pattern used by all four sibling plugins: published TypeScript entrypoints referenced from `omp.extensions`, with no build step. Its wrappers mirror their factories; the upstream manifests are the source of truth for entrypoints and versions:

- `../lemmeaskchat/package.json`
- `../tokenmunchers/plugin/package.json`
- `../let-me-see/package.json`
- `../flymode/package.json`

Each plugin's own README is the place for command details, configuration, and troubleshooting.

## Verification

Smoke-checked with the compiled `omp` v18.20.2 host: all four bundled commands register exactly once. `npm pack --dry-run` also includes all four extension entrypoints. External Discord and leaderboard services were not exercised.

## License

MIT © Carter Hendricks
