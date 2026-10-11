# Plugin Galaxy · `dsh-plugin-galaxy`

[![ci](https://github.com/AndyPBI/dsh-plugin-galaxy/actions/workflows/ci.yml/badge.svg)](https://github.com/AndyPBI/dsh-plugin-galaxy/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![host](https://img.shields.io/badge/DSH-0.1.5%20%7C%200.2.1-informational)](docs/host-compatibility.md)
[![telemetry](https://img.shields.io/badge/telemetry-none-success)](#permissions--security)

> A visual plugin galaxy inside **DeepSeek Harness** — browse, search, and install community
> plugins without leaving the app. 中文说明见 [`README.md`](README.md)。

The plugin lives in the DSH **settings dialog** (no sidebar seat, no chat commands). It is
driven by two self-owned contracts — [`docs/implementation-contract.md`](docs/implementation-contract.md)
(server) and [`docs/client-contract.md`](docs/client-contract.md) (client) — and by a
[catalog contract](docs/site-linkage.md) shared with the community site.

![The market: card grid with search, filters and sorting](https://raw.githubusercontent.com/AndyPBI/dsh-plugin-galaxy/main/docs/screenshots/01-market-all.png)

## Why

- **The ranking is the site's own** — cards carry the catalog's `ranking.top` places (`#1`, `#2`, …)
  with bands and a score breakdown, instead of "most downloaded" dressed up as "recommended".
- **Installed plugins are managed in place** — install, update, enable/disable, uninstall and
  roll back from one panel, with progress, cancel and a readable reason when something fails.
- **It is allowed to touch your profile** — every destructive step snapshots the three profile
  files first, writes go through a mutation lock and an atomic rename, and failures roll back.
- **Two host generations, web and desktop** — works on `0.1.5-rc.2` and `0.2.1-alpha.1`, including
  the packaged desktop app on Windows and macOS.
- **Honest permissions** — no telemetry, no credentials on disk, no postinstall scripts, and a
  self-restart that stays off unless the operator asks for it.

## Features

- **Discovery** — five state filters (all / recommended / installed / updatable / incompatible) over
  one card grid, plus a **category selector built from the catalog's own vocabulary** with the
  featured category (「甄选」 / Featured) promoted to a chip next to 「全部」; search across name, npm
  package, category label, description and author.
- **Recommended view** — the catalog's ranking (`ranking.top`, window 20), with `#1`, `#2`, … badges,
  S/A/B/C bands, a score breakdown tooltip and pinned editor picks.
- **Lifecycle** — one-click install; enable/disable, update, uninstall, notes, groups, favorites,
  changelogs; every mutation shows up in an operations panel with cancel and rollback.
- **Settings card** — snapshots and presets, WebDAV/Gist sync, region and release channel, optional
  one-click restart, self-uninstall, profile diagnostics and a redacted log export.
- **Cross-generation plumbing** — the settings-card seat, icon naming, plugin settings and the
  packaged app's own bundled package manager are all resolved at runtime (`profileContext`), so one
  build serves both host generations; self-restart stays off where the shell owns the process.

## Install

The package is **not published to npm**, so `dsh plugin add dsh-plugin-galaxy` cannot work.
Build it, then install the tarball that `npm pack` prints:

```bash
git clone https://github.com/AndyPBI/dsh-plugin-galaxy.git
cd dsh-plugin-galaxy
npm ci
npm run build
npm pack

dsh plugin --profile web add ./dsh-plugin-galaxy-0.1.34.tgz
```

Then **restart the host** (the plugin is loaded at startup) and open
**Settings → Plugin Galaxy**. Uninstall with
`dsh plugin --profile web remove dsh-plugin-galaxy`.

Requirements: DSH `>=0.1.5-alpha.1` (0.2.x needs Node `^22.19.0 || >=24.0.0`); installs use the
host's pnpm, and the packaged desktop app supplies its own bundled runtime.

## Permissions & security

- **Writes** only inside your profile: `package.json`, `pnpm-lock.yaml`, `cordis.patch.yml`
  (snapshotted first) and its own state under `<profile>/.dsh-galaxy/`.
- **Network egress**: the plugin catalog (ETag-revalidated), the npm registry for versions,
  the GitHub API for changelogs, and WebDAV/Gist **only when you click sync**.
- **Subprocesses**: `dsh plugin --profile <p> add|remove|…` — pnpm arguments are forwarded to the
  host CLI, with timeouts and a kill-settle fallback.
- **HTTP surface**: everything under `/dsh-galaxy`; mutations are same-origin, destructive routes
  also require loopback and refuse proxied requests.
- **No telemetry. No credentials on disk** (sync secrets come from host settings or the
  environment; log exports are redacted). **No postinstall scripts.** Self-restart is off unless
  you set `allowRestart: true`, and never overrides a supervisor that owns the process.
- Failures are isolated: a client-side error boundary and per-route server guards mean this plugin
  cannot keep your host from booting.

## FAQ

| Symptom | Cause / fix |
|---|---|
| 「Plugin Galaxy」 is missing from settings | The host loads plugins at startup — restart it completely. |
| The catalog looks stale | Use the panel's refresh button (forces ETag revalidation), or check `catalogUrl`. |
| Update check says "not checked" | That plugin was installed from a local tarball (`file:`), so there is no remote version to compare. |
| Compatibility shows "unknown" | The manifest facts are probed asynchronously on first sight, then cached by TTL. |
| An install failed | The panel shows pnpm's own output; check the registry, mirror and proxy settings. |
| No one-click restart on desktop | By design: a packaged app owns the process lifecycle (and a supervisor does on a server). |

## Documentation

The reference material is written in Chinese, like the rest of the project docs:

| Topic | Where |
|---|---|
| Server contract: routes, objects, rules, state files, errors | [`docs/implementation-contract.md`](docs/implementation-contract.md) |
| Client contract: slots, components, copy and layout rules | [`docs/client-contract.md`](docs/client-contract.md) |
| Catalog linkage: row format, ranking block, deep links | [`docs/site-linkage.md`](docs/site-linkage.md) |
| Host compatibility across `0.1.5-rc.2` and `0.2.1-alpha.1` | [`docs/host-compatibility.md`](docs/host-compatibility.md) |
| Host patches that an upgrade silently drops | [`docs/host-patches.md`](docs/host-patches.md) |
| Configuration reference (plugin config, env vars, state) | [`docs/configuration.md`](docs/configuration.md) |
| Development commands and every release gate | [`docs/development.md`](docs/development.md) |

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs exactly `npm run release`, so local
gates and CI cannot drift apart.

## License

MIT © 2026 AndyPBI · <dalianyunhai@gmail.com> · third-party notices in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). The community catalog is served by
<https://www.yhaigc.cn>; this plugin is not affiliated with it and the catalog URL is
configurable.
