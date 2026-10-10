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

## Features

- **Discovery** — five filters (all / recommended / installed / updatable / incompatible) over one
  card grid; search across name, npm package, category, description and author.
- **Recommended view** — the catalog's own ranking (`ranking.top`, window 20), with `#1`, `#2`, …
  badges, S/A/B/C bands, a score breakdown tooltip and pinned editor picks.
- **Lifecycle** — one-click install; enable/disable, update, uninstall, notes, groups, favorites,
  changelogs; every mutation shows up in an operations panel with cancel and rollback.
- **Safety net** — profile snapshots (three files + rollback token) before destructive work,
  a mutation lock, atomic writes, and automatic rollback on failure.
- **Settings card** — snapshots and presets, WebDAV/Gist sync, region and release channel,
  optional one-click restart, self-uninstall, profile diagnostics and a redacted log export.
- **Two host generations** — works on `0.1.5-rc.2` and `0.2.1-alpha.1`; the three contract
  differences (icon naming, the settings-card seat, plugin settings) are resolved at runtime.

## Install

The package is **not published to npm**, so `dsh plugin add dsh-plugin-galaxy` cannot work.
Build it, then install the tarball:

```bash
git clone https://github.com/AndyPBI/dsh-plugin-galaxy.git
cd dsh-plugin-galaxy
npm ci
npm run build
npm pack

dsh plugin --profile web add ./dsh-plugin-galaxy-0.1.29.tgz
```

Then **restart the host** (the plugin is loaded at startup) and open
**Settings → Plugin Galaxy**. Uninstall with
`dsh plugin --profile web remove dsh-plugin-galaxy`.

Requirements: DSH `>=0.1.5-alpha.1` (0.2.x needs Node `^22.19.0 || >=24.0.0`), and the host's pnpm
for installs.

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

## Development

```bash
npm run typecheck && npm test
npm run check:desensitization   # compliance scan (published surface + repo)
npm run check:host-surface      # host contract: slots, primitives, icons, tokens, peers, patches
npm run check:host-settings     # settings wiring against the real host service
npm run check:layout            # real-Chrome layout probe
npm run screenshots             # regenerate the README screenshots
npm run release                 # all of the above + npm pack
```

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs exactly `npm run release`, so local
gates and CI cannot drift apart.

## License

MIT © 2026 AndyPBI · <dalianyunhai@gmail.com> · third-party notices in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). The community catalog is served by
<https://www.yhaigc.cn>; this plugin is not affiliated with it and the catalog URL is
configurable.
