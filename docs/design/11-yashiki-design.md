# Meidoya Yashiki Design

## 1. Purpose

`meidoya-yashiki`はMeidoyaのInfrastructure Planeです。TaskやChatを知らず、Execution Nodeを安全に作り、更新し、監視します。

```text
meidoya-yashiki
  → create / provision Lima VM
  → install meidoya-node
  → materialize credentials
  → register service
  → verify receipt and health
```

## 2. CLI

```bash
meidoya-yashiki node create work-grammarxiv \
  --provider lima \
  --cpu 8 \
  --memory 16GiB

meidoya-yashiki node start work-grammarxiv
meidoya-yashiki node stop work-grammarxiv
meidoya-yashiki node status work-grammarxiv
meidoya-yashiki node doctor work-grammarxiv
meidoya-yashiki node upgrade work-grammarxiv
meidoya-yashiki node reprovision work-grammarxiv
meidoya-yashiki node backup work-grammarxiv
```

## 3. Local registry

```text
~/.config/meidoya-yashiki/config.yaml
~/.local/share/meidoya-yashiki/yashiki.sqlite
~/.local/share/meidoya-yashiki/artifacts/
```

`yashiki.sqlite`は次を管理します。

- Node desired configuration
- provider state
- provisioning run
- install receipt
- credential receipt
- health result
- backup／recovery operation

TaskやWorkspace conversationは保存しません。

## 4. Provider interface

```ts
interface NodeProvider {
  create(input: CreateNodeInput): Promise<NodeRef>;
  start(node: NodeRef): Promise<void>;
  stop(node: NodeRef): Promise<void>;
  inspect(node: NodeRef): Promise<NodeInspection>;
  exec(node: NodeRef, input: ExecInput): Promise<ExecResult>;
  destroy(node: NodeRef): Promise<void>;
}
```

MVPは`LimaProvider`のみ実装します。

## 5. Provisioning lifecycle

```text
validate desired config
  ↓
acquire node lock
  ↓
create or inspect VM
  ↓
apply resource and mount config
  ↓
install system dependencies
  ↓
download pinned meidoya-node artifact
  ↓
verify checksum
  ↓
materialize credentials
  ↓
install launchd/systemd service
  ↓
start node
  ↓
verify registration / heartbeat
  ↓
write receipt
```

各mutation後にread-back verificationを行い、曖昧な結果ではfail-closedにします。

## 6. Node bundle

YashikiはMeidoya releaseのmanifestをpinします。

```yaml
node_bundle:
  version: 0.1.0
  protocol_version: 1
  manifest_sha256: "..."
```

Guestにはreceiptを残します。

```json
{
  "product": "meidoya-node",
  "version": "0.1.0",
  "protocolVersion": 1,
  "artifactSha256": "...",
  "installedAt": "..."
}
```

## 7. Credential materialization

MVPで扱うcredential:

- Codex／ChatGPT login state
- Claude Code subscription token
- Node registration token
- optional GitHub credential

原則:

- valueはargv、log、receiptへ出さない
- Host Keychain／SOPSをsourceにする
- Guest側のowner／modeを検証する
- providerごとに別ファイル／別receiptにする
- revokeとsyncを分離する

## 8. Mount policy

```yaml
mounts:
  - source: ~/Workspace/Repositories/GrammarXiv
    target: /workspace/GrammarXiv
    writable: true
```

- Host home全体mountは禁止
- mountはNode local configに置く
- LLMはmount sourceを生成しない
- Guest内full accessでもHost側はmount範囲に限定

## 9. Doctor

Doctorは少なくとも次を確認します。

- Lima／provider version
- VM registryとdesired configの一致
- Node artifact checksum／receipt
- Node service active
- Control Plane registration
- Temporal Task Queue poller
- Codex runtime readiness
- Claude runtime readiness
- workspace path／mount
- credential presenceのみ。値は表示しない
- owner／mode／symlink安全性

## 10. Backup and recovery

Backup対象:

- Yashiki desired config
- install receipts
- Node-specific state
- guest workspace metadata
- credential documents。平文sinkは原則除外または暗号化

Recoveryはjournal／CAS／postcondition checkを用い、曖昧な場合は`RECOVERY_REQUIRED`で停止します。

## 11. What Yashiki must never do

- Task作成
- Worker／Model選択
- Slack／Discord投稿
- Human Gate解除
- Workspace間委譲
- Agent prompt生成
