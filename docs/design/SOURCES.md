# Sources and Reference Implementations

## TAKT

- Official site: https://nrslib.github.io/takt/
- Japanese README: https://github.com/nrslib/takt/blob/main/docs/README.ja.md
- CLI reference: https://github.com/nrslib/takt/blob/main/docs/cli-reference.ja.md

参考にする点:

- Workflowがprocessを所有する
- Planning／Implementation／Review／Fixの明示遷移
- `max_steps`
- Review loop monitor
- worktree isolation
- structured output／quality gate

直接依存、Role移植、互換Workflowは行わない。

## Temporal

- Documentation: https://docs.temporal.io/
- TypeScript API: https://typescript.temporal.io/
- TypeScript message passing: https://docs.temporal.io/develop/typescript/message-passing
- TypeScript schedules: https://docs.temporal.io/develop/typescript/schedules

利用箇所:

- durable Task lifecycle
- Signal／UpdateによるHuman Gate
- Schedule
- retry／timeout
- Task Queue routing
- Continue-As-New

## Chat SDK

- Official site: https://chat-sdk.dev/
- Slack adapter: https://chat-sdk.dev/adapters/official/slack
- Adapter catalog: https://chat-sdk.dev/adapters
- Emoji: https://chat-sdk.dev/docs/emoji

Chat SDKはtransport adapterとして利用し、Interaction PolicyはMeidoyaが所有する。

## Codex

- Codex SDK: https://developers.openai.com/codex/sdk
- Codex App Server: https://developers.openai.com/codex/app-server
- Authentication: https://developers.openai.com/codex/auth
- Permissions: https://developers.openai.com/codex/permissions

## Claude Code

- Headless mode: https://code.claude.com/docs/en/headless
- Sessions: https://code.claude.com/docs/en/sessions
- Permissions: https://code.claude.com/docs/en/permissions
- Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions

## Existing implementation source

- `ykawase1011/hermes-fleet`

移植候補はLima、subprocess、filesystem safety、credential、backup／recovery。Hermes固有runtimeは新Repositoryへ依存させない。
