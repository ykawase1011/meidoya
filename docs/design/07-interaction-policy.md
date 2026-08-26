# Interaction Policy

## 1. Principle

外部へ何を、いつ、何回投稿するかをLLMに決めさせません。

```text
Agent structured result
  ↓
Domain Event
  ↓
Interaction Policy
  ↓
Notification Outbox
  ↓
Chat Transport
```

## 2. Default event matrix

| Domain event | Reaction | Thread message |
|---|---|---|
| `RequestAccepted` | add `👀` | none |
| `TaskStarted` | none | none |
| `TaskProgressed` | none | none |
| `WaitingClarification` | add `❓` | one question |
| `WaitingPlanApproval` | add `📝` | one plan summary |
| `WaitingReviewApproval` | add `🔍` | one review summary |
| `WaitingSideEffectApproval` | add `⛔` | one approval request |
| `TaskNeedsAttention` | add `⚠️` | one limit／loop notice |
| `TaskCompleted` | replace with `✅` | one final result |
| `TaskFailed` | add `⚠️` | one failure summary |
| `ScheduleNoChange` | none | none |
| `ScheduleChanged` | configurable | one result |

EmojiはEnvironment／Workspace／transportごとに変更できます。

## 3. No progress spam

次は外部messageへ変換しません。

- Step開始
- Worker開始
- 途中の調査結果
- retry
- model escalation
- verify中
- Review中
- VM起動待ち

これらはSQLite、Temporal UI、log、STATUS.mdだけに反映します。

## 4. One active checkpoint message

同じcheckpoint versionについて、threadへ作るmessageは1つだけです。内容更新が必要な場合は既存messageをeditします。

```text
checkpoint:<checkpointId>:<version>
```

をidempotency keyとして利用します。

## 5. Notification Outbox

```ts
type NotificationOutboxItem = {
  id: string;
  workspaceId: string;
  conversationId: string;
  eventId: string;
  action:
    | "add-reaction"
    | "remove-reaction"
    | "post-thread-message"
    | "update-message";
  idempotencyKey: string;
  status: "pending" | "sending" | "sent" | "failed";
  attempt: number;
};
```

Task state更新とoutbox insertを同じSQLite transactionで行います。Transport失敗時はTaskを巻き戻さず、outboxだけretryします。

## 6. Chat Transport abstraction

```ts
interface ChatTransport {
  addReaction(ref: MessageRef, emoji: EmojiRef): Promise<void>;
  removeReaction(ref: MessageRef, emoji: EmojiRef): Promise<void>;
  postThreadMessage(ref: ThreadRef, message: RenderedMessage): Promise<MessageRef>;
  updateMessage(ref: MessageRef, message: RenderedMessage): Promise<void>;
}
```

初期adapterはVercel Chat SDKを利用します。Interaction PolicyはSDKの型へ依存しません。

## 7. CLI UX

Attached CLIはcheckpoint時にstdin待ちを行います。

```text
Task task_123 is waiting for plan approval.

[A] Approve
[E] Add instruction
[C] Cancel
>
```

Detached CLIは次で扱います。

```bash
meidoya task watch task_123
meidoya task answer task_123 --checkpoint cp_456 "Approve"
```

CLI processはAgent processを保持せず、Control Plane eventを購読します。

## 8. Scheduled delivery

```text
always
on-change
on-failure
never
```

既定値は`on-change`です。前回結果と同一なら外部通知しません。

## 9. Rendering

LLMの生outputをそのまま投稿しません。Rendererが次を行います。

- secret／path／internal ID scrub
- platform文字数制限
- artifact link生成
- plan／review／result template適用
- raw logの除外
