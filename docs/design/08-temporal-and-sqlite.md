# Temporal and SQLite

## 1. Authority split

| Data／State | Authority |
|---|---|
| Workflow progression、timer、retry、wait | Temporal |
| Workspace／Project／policy設定 | SQLite |
| Conversation／Task intent／Question／Artifact metadata | SQLite |
| Active Task lifecycle state | Temporal。SQLiteはprojection |
| External notification delivery | SQLite Outbox |
| Agent session reference | SQLite |
| Large artifact bytes | Filesystem／object store |

TemporalとSQLiteを同じ状態の二重source of truthにはしません。

## 2. Temporal Workflows

```text
EnvironmentWorkflow
HeadMaidWorkflow                 # optional, 1 per Environment
WorkspaceMaidWorkflow            # 1 per Workspace
RequestWorkflow                  # 1 inbound request
TaskWorkflow                     # 1 Task
CrossWorkspaceWorkflow           # 1 coordination Task
```

Agent呼び出し、SQLite、filesystem、chat投稿はすべてActivityへ置きます。

## 3. WorkspaceMaidWorkflow

Workflow ID:

```text
maid/<environmentId>/<workspaceId>
```

主なUpdate／Signal:

```text
submitMessage
submitCliRequest
submitScheduleTrigger
submitDelegation
answerCheckpoint
cancelTask
refreshPolicy
```

Task詳細やmessage本文はWorkflow stateへ大量保存せず、IDと必要最小限のstateだけ保持します。

## 4. TaskWorkflow

```text
load Task
  ↓
run Manager planning Activity
  ↓ optional checkpoint
run Worker Activities／Child Workflows
  ↓
run verification Activities
  ↓
run review Worker
  ↓
Manager decision
  ↓ optional checkpoint
terminal
```

Worker ActivityはNode固有Task Queueへ送ります。

## 5. Continue-As-New

長寿命のMaid／Head Maid WorkflowはEvent History肥大化を防ぐため、次を目安にContinue-As-Newします。

- Temporalがsuggestした時
- event数／history size閾値
- policy revision切替
- 一定期間経過

pending handlerが完了してから実行します。

## 6. Schedules

Temporal Scheduleは通常TaskWorkflowを開始します。

```text
Temporal Schedule
  → RequestWorkflow(origin=schedule)
  → Maid
  → Manager
  → Worker
```

ScheduleはWorkspace所有で、overlap policy、pause、resume、run-now、backfillをTemporalへ委譲します。

## 7. Temporal deployment modes

### Development

Temporal local development serverを利用できます。file-backed modeは開発・検証用として扱います。

### Stable personal deployment

次のどちらかを推奨します。

- Temporal Cloud
- Temporal Service＋PostgreSQLをlocal／LAN上で運用

業務DBはどちらの場合もSQLiteのままです。

## 8. SQLite write model

```text
Chat Gateway ─┐
CLI          ─┼─ Control Plane command → serial write queue → SQLite
Activities   ─┘
```

Agent／Execution NodeはSQLiteへ直接書きません。

推奨PRAGMA:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

## 9. Optimistic concurrency

Task projection等は`version`付き条件UPDATEにします。

```sql
UPDATE tasks
SET status = :next_status,
    version = version + 1,
    updated_at = unixepoch()
WHERE id = :id
  AND version = :expected_version;
```

0行更新なら競合として再読込します。

## 10. Idempotency

- inbound message key
- Temporal Update ID
- Task event ID
- Worker run attempt ID
- checkpoint version
- notification idempotency key

を保存し、retry／再送で二重作用しないようにします。

## 11. Artifact policy

SQLiteへ大きなdiff、log、report本文を保存しません。

```text
~/.local/share/meidoya/artifacts/<workspace>/<task>/...
```

SQLiteにはpath、hash、content type、visibility、owner Taskだけを保存します。
