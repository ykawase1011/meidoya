# Product acceptance

The product path is accepted when a clean Git project can be initialized, the
real services can start, `meidoya doctor` is fully healthy, and a task traverses
CLI → Control Plane → Temporal → Maid → execution node → real vendor runtime →
durable `TaskCompleted` without modifying a read-only target.

## Verified 2026-08-25: isolated Yashiki/Lima node

- A new disposable Lima VM, `meidoya-acceptance-20260825`, was created through
  the Yashiki CLI with 4 CPUs, 8 GiB memory and a 30 GiB disk. The existing
  Hermes Fleet VM was not changed.
- Yashiki completed all 12 provisioning steps, installed the pinned arm64 node
  artifact, ran `meidoya-node` as the unprivileged `meidoya` systemd user and
  projected fresh registration and Temporal poller state.
- The fixture Git repository was mounted at `/workspace/acceptance` read-only.
  A guest write probe failed with `Read-only file system`, and the host worktree
  remained clean after both agent runs.
- The Codex login was read from a private host file. The Claude subscription
  token was extracted from the existing Hermes SOPS document with the age key
  retrieved from Keychain. Values were streamed to the guest over stdin, stored
  in owner-only files, and were never printed or placed in command arguments.
- `meidoya-yashiki node doctor` passed provider, resources, artifact checksum,
  service, registration, task queue, both runtime probes, mount policy and all
  credential owner/mode checks. `meidoya doctor` passed the remote-node path;
  the absent local node config was correctly reported as a warning.
- The final node artifact SHA-256 was
  `8f211fb2f0a9666e82d7b785551f487fc87206de29cffe1a84aeeaa9047c20b0`.
  Codex task `task-a225dc0b711b13eaacf10eec53d7bf7d` completed through CLI →
  Control Plane → Temporal → Lima node → Codex and summarized the fixture.
- Claude task `task-2423b41fded62b84e8d77720ec5ea7f5` completed through the same
  path. Temporal history records `provider: claude`, `modelProfile: standard`,
  the three expected README observations and final status `completed`.
- Versions: Lima 2.1.1, Temporal CLI 1.5.0 / Server 1.29.0, Node.js 22.23.1,
  Codex CLI 0.149.1 and Claude Code 2.1.234.

The run exposed and fixed production-only integration defects: Lima could not
reach Unix-only control endpoints or host-loopback Temporal; large artifacts
exceeded Node's string limit during one-shot base64 transfer; the service user
could not traverse a root-owned credential directory; vendor sandboxes needed
`bubblewrap`, `socat` and the isolated guest's user-namespace setting; Yashiki
queried too much of a pre-existing Lima config; node task queues were not tied
to node IDs; remote `doctor` required an unnecessary local node config; and a
blocked Worker could be recorded as a successful quick-lane step.

## Verified 2026-08-24

- Temporal CLI 1.5.0 development server (Temporal Server 1.29.0)
- Codex CLI 0.149.1 with model `gpt-5.6-sol`
- macOS arm64, Node.js 22.23.1
- generated control-plane and node configuration
- `meidoyad` and `meidoya-node` launched by `tools/local-run.mjs`
- `meidoya doctor`: every required check `ok`
- submitted `quick` request: read `README.md`, report its heading and purpose,
  and do not modify files
- Temporal workflow status: `WORKFLOW_EXECUTION_COMPLETED`
- Worker activity queue: `meidoya/node/acceptance-node`
- SQLite task status: `completed`
- persisted result: `Top-level heading: “Acceptance Project”. Purpose: It is a
  Meidoya real-runtime smoke test.`
- target Git worktree: clean after completion

The run exposed and fixed three production-only defects before acceptance:

1. the local launcher did not pass the daemon-provisioned node token;
2. Codex refused coordinating runs in the intentionally non-Git coordination
   directory because the adapter omitted `--skip-git-repo-check`;
3. Request workflows defaulted every Worker activity to `mac-main` instead of
   carrying the node selected from workspace and node policy.

The offline demo and time-skipping suite remain useful development gates, but
they are not substitutes for this acceptance path.

## Release gates

- `pnpm typecheck`: passed
- `pnpm lint`: passed
- `pnpm build`: passed
- `pnpm test`: 1406 passed, 2 skipped, 107 files
- `pnpm mutation`: 244/278 killed, 7 equivalent, 27 recorded known gaps,
  0 unexplained survivors
- offline vertical-slice demo: passed
- local Compose definition: valid
- generated configs: accepted by both production parsers
- local command launchers: installed in an isolated bin directory and all three
  `--help` entrypoints executed
- supervised SIGTERM drain: both daemons stopped cleanly with exit code 0
