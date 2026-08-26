# Roles and Scopes

## 1. Role model

```text
HeadMaid
  └─ Maid
       └─ Manager
            └─ Worker
```

Roleは組織上の責務と権限を表します。作業専門性は`WorkerProfile`、Modelは`RuntimeProfile`として別軸にします。

## 2. Head Maid

### Scope

Environment全体。ただしgrantされたWorkspaceだけを認識できます。

### Responsibilities

- Global ingressの受付
- 対象Workspaceの特定
- delegation grantの確認
- Coordination Taskの作成
- Workspace Maidへの依頼委譲
- Child Task summaryの集約
- Global statusの提示

### Forbidden

- Repositoryへの直接アクセス
- Workerの直接起動
- 対象Workspaceのpath指定
- grantなしWorkspaceのstatus参照
- credential参照

## 3. Maid

### Scope

1 Workspace固定です。Workspace IDはIngress Bindingから注入され、LLM出力では変更できません。

### Responsibilities

- thread／CLI requestの受付
- administrative／quick／durableの判定
- Taskの作成または既存Questionへの回答紐付け
- Schedule操作の解釈
- Out-of-scope requestの拒否
- Managerへの委譲

### Forbidden

- 実装、調査、shell、Git操作
- 他Workspaceへの転送
- Workerの直接起動
- 任意path指定

## 4. Manager

### Scope

1 Task固定です。

### Responsibilities

- Task intentの整理
- Planning
- Step分解
- Project selection
- WorkerProfile／provider／model tierの提案
- Worker結果の統合
- Review findingの処遇決定
- Human Gateの要求
- 完了、再実行、中断判断

### Forbidden

- Repositoryへの直接write
- shell／browserの直接利用
- Workspace scope変更
- policyで禁止されたModel／Node指定
- Human Gateの強制回避

## 5. Worker

### Scope

1 Step、1 Workspace、許可されたProject集合に固定します。

### Responsibilities

- 調査
- 実装
- テスト
- Review
- Artifact生成

WorkerはTask lifecycleを直接変更せず、構造化された`WorkerResult`を返します。

## 6. Worker Profiles

```text
researcher
implementer
reviewer
security-reviewer
tester
mechanical-editor
```

例:

```yaml
actor:
  role: worker
  profile: security-reviewer
runtime:
  provider: codex
  model_profile: high
permissions:
  repository: read
  shell: false
  network: false
```

## 7. Role capability matrix

| Capability | HeadMaid | Maid | Manager | Worker |
|---|:---:|:---:|:---:|:---:|
| `workspace.status.read` | grant内 | own | own | no |
| `workspace.delegate` | grant内 | no | no | no |
| `task.create` | coordination | own | child step only | no |
| `task.answer` | coordination | own | request only | no |
| `schedule.manage` | grant内任意 | own | no | no |
| `worker.dispatch` | no | no | yes | no |
| `checkpoint.request` | yes | yes | yes | no |
| `artifact.read` | summary | summary | yes | scoped |
| `repository.read/write` | no | no | no | scoped |
| `shell` | no | no | no | scoped |

Toolを見せないだけでなく、Control Plane API側でもclaimsを検証します。

## 8. Workspace hard boundary

```text
Ingress Binding
  → immutable WorkspaceScope
  → Conversation
  → Task
  → Step
  → AgentRun
  → Artifact
```

Workspace固有APIでは、可能な限り`workspaceId` parameter自体を公開しません。

```ts
createTask(scopeToken, inputWithoutWorkspaceId)
```

次は拒否します。

```ts
createTask({ workspaceId: modelGeneratedValue, ... })
```

## 9. Workspace composition

```text
Workspace: work-it
  ├─ Project: product-a
  ├─ Project: product-b
  └─ Project: shared-library
```

1 Taskは1 Workspaceに属し、Workspace内の複数Projectを対象にできます。複数Workspaceをまたぐ場合はHead MaidがChild Taskへ分解します。

## 10. Delegation grants

```yaml
grant:
  source: global
  target: work-grammarxiv
  capabilities:
    - status.read
    - task.delegate
    - task-summary.read
```

grantがない場合は、Head Maidにも対象Workspaceを見せません。
