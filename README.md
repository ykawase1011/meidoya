# Meidoya

Local-first Agent Control Plane with one Maid per workspace, durable tasks, human gates,
deterministic chat UX, and Codex／Claude workers.

> One Maid per workspace. One Head Maid across them all.
> Codex and Claude do the work; Meidoya runs the office quietly.

This repository owns the secretary organization, Task/Schedule domain, chat UX, workflows,
and agent runtime. Execution-node infrastructure (Lima VM lifecycle, native node bootstrap,
credential materialization) lives in the sibling repository
[`meidoya-yashiki`](https://github.com/ykawase1011/meidoya-yashiki).

Full architecture and design rationale: [`docs/design/`](./docs/design/README.md).

## Status

Phases 0–7 are implemented, including the Head Maid cross-workspace flow. The
production path is accepted against a real Temporal server, Codex CLI and
Claude Code, including an isolated Yashiki/Lima execution node; remaining Phase
8 work is OSS ecosystem integration and release automation. See
[`docs/design/12-implementation-roadmap.md`](./docs/design/12-implementation-roadmap.md)
and [`docs/acceptance.md`](./docs/acceptance.md) for the verified state.

## Repository layout

```text
apps/
  meidoya/        CLI
  meidoyad/        Control Plane daemon
  meidoya-node/    Execution daemon

packages/
  domain/                domain types (Environment, Workspace, Task, Role, ...)
  node-protocol/         cross-repository wire contract with meidoya-yashiki
  store-sqlite/           SQLite migration framework + business schema
  ...                     see docs/design/03-repository-boundaries.md section 5
```

## Running locally

For the copy-paste setup used for manual testing, plus `doctor`, `status`, task
listing/watching/answering, schedules, shutdown and troubleshooting, see the
Japanese one-page guide:
[`docs/operations/quick-reference-ja.md`](./docs/operations/quick-reference-ja.md).
Slack Socket ModeとDiscord Gatewayの同時受信、token file、Bot権限、Hermesからの
安全な切替は
[`docs/operations/chat-ingress-ja.md`](./docs/operations/chat-ingress-ja.md)を参照してください。
「進行中のタスクは？」などの自然言語一覧、状態ごとの意味、状態が変わるタイミング、
Slack Block Kit／Discordのコピー可能な通常テキスト返答は
[`docs/operations/task-status-ja.md`](./docs/operations/task-status-ja.md)にまとめています。
public化前の全履歴secret scan、Actionsログ／artifact、commit email、履歴分離の確認は
[`docs/operations/public-release-ja.md`](./docs/operations/public-release-ja.md)を参照してください。

### Real local stack

```bash
pnpm install
pnpm build
pnpm meidoya init --project /absolute/path/to/a/git-project
export MEIDOYA_PROFILE=<workspace-id printed by init>
pnpm local:start
```

In another terminal, export the same profile and run:

```bash
pnpm local:doctor
pnpm meidoya submit "Read README.md and summarize the project" --pipeline quick
```

Recurring work can be registered from natural language through either the
dedicated CLI entry or the ordinary Maid prompt:

```bash
pnpm meidoya schedule add "平日の朝9時にREADME.mdを確認して要点を報告して" --project <project-id>
pnpm meidoya submit "毎週月曜の10時に依存関係を確認して報告して"
```

The Maid converts an explicit recurrence into a five-field cron and
registers it with Temporal using the environment timezone when none is stated.
This is an internal Temporal Schedule, not a host `crontab` entry. Explicit cron
creation remains available for deterministic/operator-managed setup. See the
[Japanese quick reference](./docs/operations/quick-reference-ja.md#4-定期実行).

`local:start` runs pinned Temporal/PostgreSQL/UI containers and supervises the
real Control Plane and execution node. See
[`docs/operations/local-stack.md`](./docs/operations/local-stack.md) for setup,
quality-gate policy, external Temporal, separate-node, and local command install
instructions.

### One-command offline demo

Runs the whole vertical slice — CLI → Maid → Manager → plan gate → Worker on an
execution node → verify → review → completed — with a time-skipping Temporal test
environment, a fake chat transport and a fake agent runtime. No Codex or Claude
binary, no Temporal server, no Slack/Discord token, no network.

```bash
pnpm install
pnpm -r build
node apps/meidoyad/dist/demo/local-demo.js
```

The demo spawns the real `meidoya` CLI, answers the plan gate on stdin with `A`,
and prints the resulting task state and STATUS.md path.

### Running the three apps for real

```bash
# 1. Control Plane daemon (needs a Temporal service on the configured address)
node apps/meidoyad/dist/main.js --config ~/.config/meidoya/config.yaml

# 2. Execution node (one per host/VM; id must match a `nodes:` entry in config.yaml)
node apps/meidoya-node/dist/main.js --config ~/.config/meidoya/node.yaml

# 3. CLI
export MEIDOYA_SOCKET=~/.local/share/meidoya/meidoya.sock
export MEIDOYA_PROFILE=work-grammarxiv     # selects the CLI ingress binding
node apps/meidoya/dist/main.js submit "Fix the flaky parser test"
node apps/meidoya/dist/main.js task list
node apps/meidoya/dist/main.js task watch <taskId>
node apps/meidoya/dist/main.js task answer <taskId> --checkpoint <cp> "Approve"
node apps/meidoya/dist/main.js status

# Head Maid / cross-workspace (the `global` profile is a coordination binding)
export MEIDOYA_PROFILE=global
node apps/meidoya/dist/main.js submit "Compare both implementations" \
  --target work-grammarxiv --target work-it
node apps/meidoya/dist/main.js status     # includes granted workspaces only
```

Start from [`docs/design/config.example.yaml`](./docs/design/config.example.yaml)
and [`docs/design/node.example.yaml`](./docs/design/node.example.yaml). The daemon
config's `nodes:` block gives each execution node its local policy (allowed
profiles, capabilities and workspaces); a node without one is refused. The CLI's
workspace comes from its ingress binding profile, never from a flag.

When `models:` is configured, `meidoyad` starts Codex and Claude runtimes for the
Head Maid, Maid and Manager roles. `model_policy:` selects those coordinating
roles and the default/allowed Worker and reviewer profiles; Worker and reviewer
runs execute on the selected execution node, with review limited to `repo.read`.
The vendor binaries default to `codex` and `claude` on `PATH`; override them with
`MEIDOYA_CODEX_BIN` or `MEIDOYA_CLAUDE_BIN`. Coordinating runs are bounded to 14
minutes by default; set `MEIDOYA_CONTROL_AGENT_TIMEOUT_MS` to a positive integer
number of milliseconds to change that limit.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Requires Node.js >= 20 and pnpm >= 10.

### The mutation gate

`pnpm test` tells you the tests pass. It does not tell you whether any of them would
notice if a security check were deleted — and this repository has shipped that defect
repeatedly, always on a line coverage called covered.

`pnpm mutation` breaks one guard at a time in a listed set of security and correctness
modules and fails if the suite stays green:

```bash
pnpm mutation --targets token          # one module, ~1-3 min
pnpm mutation                          # every gated module: 278 mutants, ~9 min
```

The full gated set runs on every pull request as its own CI job. Requires Node.js >= 22 (it
is run through native type stripping) and an idle working tree — it edits real source files
while it runs, and takes an exclusive lock to enforce that.

Read [`docs/mutation-testing.md`](./docs/mutation-testing.md) before adding a module, and
especially before adding an allowlist entry — an equivalent mutant has to be argued, not
asserted.
