# Local production-path stack

This is the shortest supported path from a checkout to a real Meidoya task. It
uses a real Temporal service and an installed Codex or Claude Code runtime. It
does not use the fake runtime or Temporal's time-skipping test environment.

## Prerequisites

- Node.js 20 or newer
- pnpm 10 or newer
- Docker with Compose v2
- Codex CLI or Claude Code, already authenticated
- a readable and writable Git project

## Initialize

From the Meidoya repository:

```bash
pnpm install
pnpm build
pnpm meidoya init --project /absolute/path/to/project
export MEIDOYA_PROFILE=<workspace-id printed by init>
```

`meidoya init` writes private (`0600`) control-plane and node configs under
`~/.config/meidoya`, creates the local data directories, discovers the model in
`~/.codex/config.toml` when Codex is selected, and refuses to overwrite existing
configuration unless `--force` is passed. Use `--workspace`, `--project-id`,
`--node`, `--provider`, and `--codex-model` when discovery is not appropriate.

The generated policy defaults to the `quick` pipeline and has no quality-gate
allowlist. This is deliberate: verification is deny-by-default. Before using the
`coding` pipeline, define matching `quality_gates.commands` in `config.yaml` and
`quality_gates` in `node.yaml`; use `docs/design/node.example.yaml` as the
annotated reference.

## Run

```bash
pnpm local:start
```

This command starts the pinned local Temporal/PostgreSQL/UI Compose stack, builds
the workspace, then supervises `meidoyad` and `meidoya-node`. The trusted local
launcher passes the daemon-provisioned per-node registration token to the node
and synchronizes the configured logical model names into the node environment.
Press Ctrl-C to drain both Meidoya processes. Temporal remains available for
durable restart; stop it with `pnpm temporal:down`.

In another terminal:

```bash
export MEIDOYA_PROFILE=<workspace-id printed by init>
pnpm local:doctor
pnpm meidoya submit "Read README.md and summarize the project" --pipeline quick
```

Temporal UI is available at <http://localhost:8080>. `meidoya doctor` checks the
two config files, Node version, vendor CLIs, Temporal, the Unix socket, CLI
profile and credential, protocol handshake, and an online execution node. It
returns nonzero if a required check fails and supports `--json` for automation.

## Install command launchers

```bash
pnpm install:local
```

This builds the workspace and installs `meidoya`, `meidoyad`, and `meidoya-node`
launchers in `~/.local/bin` (override with `MEIDOYA_BIN_DIR`). The launchers point
at this checkout, so rebuild after pulling changes.

## External Temporal or separate nodes

Set the Temporal address in both YAML files and do not run the local Compose
stack. A separately launched execution node must receive its daemon-provisioned
token through `MEIDOYA_NODE_TOKEN_FILE` or `MEIDOYA_NODE_TOKEN`. Concrete Worker
model names are node-local environment settings such as
`MEIDOYA_MODEL_CODEX_HIGH`; the local supervisor derives them from `models:`
only because both processes run under one trusted operator on one host.

The Compose file is a local development deployment, not a high-availability
Temporal production topology. Production Temporal operation, database backups,
TLS, authentication, and network policy remain the deployment operator's
responsibility.
