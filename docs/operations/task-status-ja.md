# タスク状態と一覧の見方

Slack／Discord／CLIから受け付けた依頼は、Control PlaneのTaskとして保存されます。
チャットで単に「進行中のタスクは？」と尋ねた場合は、完了済みを混ぜず、現在動いている
Taskと人の確認・対応を待っているTaskだけを表示します。一覧を尋ねるために作られた
管理Task自身は結果から除外されます。

## 1. チャットでの一覧指定

| 聞き方の例 | view | 表示対象 |
| --- | --- | --- |
| 「進行中のタスクは？」「未完了の作業を見せて」 | `open` | 処理中 + 確認・対応待ち（既定） |
| 「確認待ちは？」「私の対応が必要なタスクは？」 | `waiting` | 確認・対応待ちのみ |
| 「完了済みは？」「終了したタスクを見せて」 | `closed` | 完了・失敗・キャンセル |
| 「全タスクを見せて」「完了分も含めて一覧」 | `all` | 全状態 |

返答はSlackではBlock Kit、DiscordではEmbedを使い、状態群ごとの見出しと状態アイコンを
付けます。通知本文の`text`は通知失敗時や未対応transport向けのフォールバックです。
TemporalはTaskの実行と待機を耐久化しますが、`Result`などの表示形式を決めるものでは
ありません。

CLIは状態を直接指定できます。

```bash
pnpm meidoya task list --limit 20
pnpm meidoya task list --status running
pnpm meidoya task list --status waiting_plan_approval
pnpm meidoya task list --status completed
```

## 2. 状態の意味と切替タイミング

### 進行処理中

| 状態 | 表示 | この状態になるタイミング |
| --- | --- | --- |
| `received` | 📥 受付中 | 依頼を受理し、Taskを永続化した直後 |
| `planning` | 📝 計画中 | Managerが実行計画を作成・再作成している間 |
| `running` | ⚙️ 実行中 | Workerの調査・実装、修正、委譲処理を実行している間 |
| `verifying` | 🧪 検証中 | 設定済みquality gateや成果物を検証している間 |
| `reviewing` | 🔎 レビュー中 | ReviewerまたはManagerが結果を判定している間 |

### 確認・対応待ち

待機中はCodex／Claude process、Git lock、SQLite transactionを保持しません。回答や承認を
受けると、記録済みの再開地点からWorkflowが続行します。

| 状態 | 表示 | この状態になるタイミング | 主な戻り先 |
| --- | --- | --- | --- |
| `waiting_clarification` | ❓ 追加情報待ち | 計画に必要な情報が不足したとき | `planning` |
| `waiting_plan_approval` | ✋ 計画承認待ち | policyが実行前のPlan承認を要求したとき | 承認で`running`、差戻しで`planning` |
| `waiting_review_approval` | ✋ 完了承認待ち | policyが完了前のReview承認を要求したとき | 承認で`completed`、差戻しで`running` |
| `waiting_user_input` | 💬 回答待ち | 実行途中でユーザー判断が必要になったとき | 待機前に記録した状態 |
| `waiting_side_effect_approval` | ⛔ 外部操作承認待ち | 外部副作用の実行前に承認が必要になったとき | 待機前に記録した状態 |
| `needs_attention` | ⚠️ 要対応 | 自動継続できず、運用者の介入が必要になったとき | 対応内容に応じた処理状態または`completed` |

### 完了・終了

| 状態 | 表示 | この状態になるタイミング |
| --- | --- | --- |
| `completed` | ✅ 完了 | 必須Step、検証、Review、成果物、完了通知の条件をすべて満たしたとき |
| `failed` | ❌ 失敗 | 再試行できない失敗、または許容回数を超えた失敗になったとき |
| `cancelled` | ⏹️ キャンセル | CLI／チャット／Workflow signalでキャンセルが確定したとき |

終了状態から別の状態へは戻りません。再実行する場合は新しいTaskとして依頼します。

## 3. 通常の状態遷移

```text
received
  → planning
    → waiting_clarification → planning
    → waiting_plan_approval → running（または planningへ差戻し）
    → running
      → verifying → reviewing
      → reviewing → running（修正）
        → waiting_review_approval → completed（または runningへ差戻し）
        → completed
```

`waiting_user_input`、`waiting_side_effect_approval`、`needs_attention`、`failed`、
`cancelled`は、必要に応じて通常フローの途中から入ります。Quick laneは通常、Plan承認と
Review承認を省略しますが、追加情報や副作用の承認が必要なら待機します。

## 4. 運用時の確認

```bash
pnpm meidoya status
pnpm meidoya task list --limit 20
pnpm meidoya task get <task-id>
pnpm meidoya task watch <task-id>
pnpm meidoya task answer <task-id> --checkpoint <checkpoint-id> "承認します"
```

- 一覧は現在のスナップショットです。細かい遷移は`task watch`で追跡します。
- 待機理由とcheckpoint IDは`task get`で確認します。
- CLIの`task list`はoperator向けの生データ、Slack／Discordの自然言語一覧は読みやすい
  状態別表示です。
- Taskの状態更新はWorkflowからControl Planeへ記録され、通知はNotification Outboxから
  配送されます。通知の一時失敗だけで完了済みTaskが実行中へ戻ることはありません。
