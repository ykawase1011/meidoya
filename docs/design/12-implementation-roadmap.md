# Implementation Roadmap

## Phase 0: Repository foundations

### `meidoya`

- monorepo setup
- domain type skeleton
- Node Protocol v1
- SQLite migration framework
- Temporal local development setup
- CI、lint、typecheck、unit test

### `meidoya-yashiki`

- standalone repository setup
- protocol package consumption smoke test
- Lima provider skeleton
- immutable receipt format

### Definition of Done

- 2 Repositoryが相互のsource pathを読まない
- Node Protocol packageだけでcompileできる
- CIがMac／Linux相当でgreen

## Phase 1: CLI-only single Workspace vertical slice

```text
CLI
→ work-grammarxiv Maid
→ Manager
→ Codex Worker
→ completed / waiting_user
```

機能:

- 1 Workspace固定
- Task作成
- Planning
- Codex Worker
- Temporal retry／wait
- SQLite projection
- `meidoya task list/get/watch/answer/cancel`

### Definition of Done

- daemon再起動後にTaskが再開する
- user input待ちでAgent processが残らない
- Workspace IDがLLM出力で変更できない

## Phase 2: Human Gates, limits, and quiet UX

- Plan Gate
- Review Gate
- side-effect Gate
- `max_steps`
- fix／review round limit
- no-progress fingerprint
- `needs_attention`
- Interaction Policy unit tests
- Notification Outbox

### Definition of Done

- progress messageが0件であることをtestできる
- accepted／plan／review／complete reactionがpolicy通り
- budget超過後にユーザー操作で1回だけ延長可能

## Phase 3: Claude and model routing

- Claude Code runtime
- Codex／Claude session resume
- high／standard／economy mapping
- Manager proposal＋policy validation
- escalation limit
- WorkerProfile

### Definition of Done

- 通常実装をstandardへroutingできる
- 単純作業をeconomyへroutingできる
- 同じ失敗でhighまで上がった後に停止する

## Phase 4: Slack and Discord

- ChatTransport interface
- Vercel Chat SDK adapter
- Slack Socket Mode
- Discord gateway
- thread correlation
- reaction／message edit
- CLIと同じcheckpoint path

### Definition of Done

- 受付後は👀のみ
- 質問または完了までmessageを投稿しない
- thread回答が正しいcheckpointへ届く

## Phase 5: Schedules

- Workspace-owned Temporal Schedule
- create／list／pause／resume／run-now／delete
- overlap policy
- on-change delivery
- scheduled Taskのgate policy

### Definition of Done

- no-change実行が無通知
- Taskと同じManager／Worker pathを通る
- 重複実行policyがtestされている

## Phase 6: `meidoya-yashiki` Lima MVP

- Lima create／start／stop／status
- `meidoya-node` artifact install
- checksum／receipt
- Node registration
- credential sync
- doctor
- reprovision

### Definition of Done

- Lima VMを新規作成しTaskを完了できる
- guest full／host mount limitedが検証できる
- artifact mismatch時に起動を拒否する

## Phase 7: Head Maid

- Global ingress
- delegation grants
- Coordination Task
- Workspace Child Task
- result aggregation
- global status

### Definition of Done

- grantなしWorkspaceがHead Maidから不可視
- Head MaidがWorkerを直接起動できない
- 2 Workspaceの結果を1 threadへ集約できる

## Phase 8: OSS readiness

- English README
- one-command local demo
- example Slack／Discord apps
- sample Workspace config
- threat model
- architecture decision records
- compatibility matrix
- migration guide from Hermes
- semantic releases

## Priority rule

新しいgeneric harness機能、dashboard、providerを追加する前に、次の本線を完成させます。

```text
Workspace-scoped Maid
→ durable Task
→ Manager / Worker
→ Human Gate
→ quiet thread UX
→ Schedule
→ Mac / Lima
```
