# Task Lifecycle

## 1. Request intake

```text
Message received
  ↓
Ingress Binding resolves Workspace
  ↓
Open Question correlation check
  ↓
Maid request assessment
```

Maidの判断結果は自由文ではなく、次のいずれかです。

```ts
type MaidDecision =
  | { type: "administrative"; command: AdminCommand }
  | { type: "quick"; brief: TaskBrief }
  | { type: "durable"; brief: TaskBrief }
  | { type: "answer_question"; taskId: string; questionId: string; answer: string }
  | { type: "ask_user"; question: string }
  | { type: "out_of_scope"; reason: string };
```

## 2. Quick lane

Quick laneでもMaid自身は実作業をしません。

```text
Maid
  → inline Task
  → Manager
  → one Worker
  → result
```

特徴:

- Task IDとAgent Runを記録する
- Human Gateは既定でoff
- 並列Workerは使わない
- soft deadlineを超えた場合、同じTaskをdurableへ昇格する
- 昇格時は追加の進捗messageを投稿しない

## 3. Durable lane states

```text
received
  ↓
planning
  ├─ waiting_clarification
  └─ waiting_plan_approval
  ↓
running
  ↓
verifying
  ↓
reviewing
  ├─ running (fix)
  └─ waiting_review_approval
  ↓
completed
```

どこからでも次へ遷移できます。

```text
waiting_user_input
waiting_side_effect_approval
needs_attention
failed
cancelled
```

## 4. Planning

Managerが返すPlanは構造化します。

```ts
type ExecutionPlan = {
  summary: string;
  risk: "low" | "medium" | "high";
  projects: ProjectAccess[];
  steps: PlannedStep[];
  expectedArtifacts: string[];
  verification: VerificationPlan;
};
```

PlanはControl Planeが次を検証します。

- Workspace／Project所属
- Step依存関係
- WorkerProfile allowlist
- Model／provider policy
- capability要求
- Human Gate policy
- root execution budget

## 5. Fixed task pipelines

### Research

```text
clarify → plan → research → synthesize → review → complete
```

### Coding

```text
clarify → plan → implement → verify → review → fix loop → complete
```

### Scheduled

```text
assess → execute → compare previous result → deliver by policy
```

### Cross-workspace

```text
Head Maid plan → workspace delegations → wait children → aggregate → complete
```

## 6. Worker result

```ts
type WorkerResult =
  | {
      type: "completed";
      summary: string;
      artifacts: ArtifactRef[];
      evidence: EvidenceRef[];
    }
  | {
      type: "blocked";
      reason: string;
      proposedQuestion?: string;
    }
  | {
      type: "failed";
      errorClass: string;
      retryable: boolean;
    };
```

Workerが直接ユーザーへ質問しません。Managerが本当にユーザー判断が必要かを判定します。

## 7. Verification

Verificationは可能な限りLLM判断ではなくcommand／artifact evidenceで行います。

```text
unit tests
integration tests
lint
typecheck
build
repository-specific checks
```

結果は`VerificationResult`として保存し、Review promptにも渡します。

## 8. Review

ReviewerはWorkerProfileです。

```text
Worker(profile=reviewer)
  → ReviewFindings
Manager
  → complete / fix / additional review / Human Gate
```

Review findingにはstable IDを付け、同じ指摘の反復をno-progress検知に利用します。

## 9. User questions

```text
Manager requests checkpoint
  ↓
Question row + Notification Outbox
  ↓
Temporal waits
  ↓
Slack/Discord thread or CLI receives answer
  ↓
Question answered
  ↓
Workflow resumes
```

待機中にCodex／Claude process、Git lock、SQLite transactionを保持しません。

## 10. Completion

完了条件:

- Plan上の必須Stepがterminal
- Verification policyを満たす
- unresolved blocking findingがない
- Review Gateを満たす
- required artifactが保存済み
- notification outboxへ完了通知が登録済み

Task完了と外部通知は同一transaction／outbox patternで結び付けます。
