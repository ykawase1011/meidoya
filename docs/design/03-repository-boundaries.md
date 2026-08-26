# Repository Boundaries

## 1. Repository 1: `meidoya`

### 1.1 Owns

- Environment／Workspace／Project domain
- Head Maid／Maid／Manager／Worker protocol
- Request assessment
- Quick／durable Task lifecycle
- Planning／Review／side-effect Human Gate
- Execution budget／loop guard
- Temporal Workflows／Activities
- 業務SQLite schema
- Slack／Discord／CLI ingress
- Interaction Policy／Notification Outbox
- Codex／Claude Agent Runtime
- Model routing
- Execution Node protocolとresolver
- Native Mac／Linux `meidoya-node`
- STATUS.md projection

### 1.2 Does not own

- Lima VMの作成・削除
- VM resource／mount設定
- Node artifactのVM配備
- VM credential materialization
- VM backup／recovery

## 2. Repository 2: `meidoya-yashiki`

### 2.1 Owns

- Lima VM lifecycle
- Native／Lima provider abstraction
- CPU／Memory／Disk／mount設定
- `meidoya-node`のinstall／upgrade／rollback
- Codex／Claude credential materialization
- Node bootstrap／service registration
- Doctor／preflight／receipt
- Backup／recovery
- Yashiki local registry

### 2.2 Does not own

- User message本文
- Workspace Maid／Head Maid
- Task／Question／Schedule domain
- Manager／Worker routing判断
- Chat UX／reaction
- Model選択
- Temporal business workflow

## 3. Dependency direction

```text
meidoya-yashiki
  ├─ consumes @meidoya/node-protocol
  ├─ consumes node release manifest
  └─ installs meidoya-node artifact

meidoya
  └─ never imports meidoya-yashiki
```

Source repository間のGit dependency、submodule、internal path readは作りません。

## 4. Cross-repository contracts

Cross-repository contractは以下だけに限定します。

```text
@meidoya/node-protocol
@meidoya/node-manifest
meidoya-node release artifact
```

### 4.1 Node Protocol

- registration
- heartbeat
- capability advertisement
- run request／event／result
- cancel
- protocol version negotiation

### 4.2 Release manifest

```json
{
  "product": "meidoya-node",
  "version": "0.1.0",
  "protocolVersion": 1,
  "artifacts": [
    {
      "platform": "linux",
      "arch": "arm64",
      "sha256": "..."
    }
  ]
}
```

Yashikiはmanifestをpinし、checksum検証後にinstallします。

## 5. Proposed repository layout

### `meidoya`

```text
apps/
  meidoya/                 # CLI
  meidoyad/                # Control Plane daemon
  meidoya-node/            # Execution daemon

packages/
  domain/
  protocol/
  workspace-scope/
  roles/
  task-engine/
  checkpoint-policy/
  execution-budget/
  interaction-policy/
  notification-outbox/
  workflows-temporal/
  store-sqlite/
  chat-core/
  chat-vercel/
  agent-runtime/
  runtime-codex/
  runtime-claude/
  model-router/
  node-protocol/
  node-runtime/
  execution-native/
  status-projector/
```

### `meidoya-yashiki`

```text
apps/
  meidoya-yashiki/         # CLI

packages/
  yashiki-core/
  provider-lima/
  provider-native/
  node-provisioner/
  node-bundle/
  credentials/
  doctor/
  receipts/
  backup/
  recovery/
  store-sqlite/
```

## 6. Release cadence

Repositoryは独立SemVerです。

```text
meidoya            0.1.0
meidoya-yashiki    0.1.0
node protocol      1
```

YashikiはMeidoyaの特定versionではなく、Node Protocol versionとNode artifact checksumへ依存します。

## 7. Shared utility policy

2 Repositoryを完全分離するため、汎用utility packageを安易に共有しません。

- Agent subprocess管理は`meidoya`
- Lima／provision subprocess管理は`meidoya-yashiki`
- 共有するのはwire contractだけ
- 共通化が必要になった場合も、実利用が2箇所以上で安定してから独立package化する
