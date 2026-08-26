# Human Gates and Execution Limits

## 1. Human Gateの種類

### 1.1 Clarification Gate

Planning前に不足情報を確認します。

```text
never
when-needed
always
```

既定値は`when-needed`です。

### 1.2 Plan Approval Gate

ManagerがPlanを作成した後、実装前に停止します。

```text
never
on-risk
always
```

### 1.3 Review Approval Gate

内部Review後の完了判断で停止します。

```text
never
on-findings
before-complete
always
```

### 1.4 Side-effect Gate

push、PR作成、deploy、外部message送信、credential変更など、外部作用の前に停止します。

```text
policy
always
```

Security policyが要求するGateは、WorkspaceやTask設定で無効化できません。

## 2. Policy precedence

強い順です。

```text
1. Mandatory security policy
2. One-off task override
3. Workspace policy
4. Pipeline policy
5. Environment default
```

下位設定は上位の必須Gateを緩和できません。

## 3. Checkpoint state

```ts
type HumanCheckpoint = {
  id: string;
  taskId: string;
  kind:
    | "clarification"
    | "plan-approval"
    | "review-approval"
    | "side-effect-approval"
    | "limit-exceeded";
  status: "pending" | "approved" | "rejected" | "answered" | "expired";
  prompt: string;
  choices: CheckpointChoice[];
  version: number;
};
```

回答は元threadまたはattached CLIから受け付けます。複数未回答checkpointがある場合はIDを明示します。

## 4. Root execution budget

無限実行防止はLLM promptではなくControl Planeが強制します。

```yaml
limits:
  max_steps: 24
  max_step_visits: 5
  max_fix_rounds: 3
  max_review_rounds: 3
  max_no_progress_rounds: 2
  max_parallel_workers: 3
  max_model_escalations: 2
  max_consecutive_failures: 3
  max_wall_time: 4h
```

`max_steps`はChild Task、subworkflow、Review／Fix loopを含むroot budgetです。子へ分割してbudgetを迂回できないようにします。

## 5. Step counting

次を1 Stepとして数えます。

- Agent run 1回
- Verification command group 1回
- Review group 1回
- Manager replan 1回

Human wait、Temporal timer、単純なDB projection更新は数えません。

## 6. Loop guards

### Review／Fix loop

```text
review → fix → verify → review
```

`max_fix_rounds`または`max_review_rounds`で停止します。

### Step visit loop

同じStep IDへの訪問回数を`max_step_visits`で制限します。

### No-progress loop

次のfingerprintを比較します。

```text
git diff hash
verification failure signature
review finding IDs
artifact hashes
manager decision class
```

同一fingerprintが閾値回数続いた場合は`needs_attention`へ移します。

## 7. Model escalation

```text
economy → standard → high
```

同じ失敗に対して無限にmodelを変えないよう、`max_model_escalations`を設けます。

## 8. Limit exceeded behavior

即座に`failed`にせず、原則`needs_attention`へ移します。

```text
Task paused: execution limit reached.

Choices:
- Extend budget once
- Change model/profile
- Add instruction
- Accept current result
- Cancel
```

cron taskでは対話できない場合があるため、Workspace policyに従って`failed`または`paused`にします。

## 9. Taktから参考にする点

- `max_steps`到達時に停止し、再開情報を保持する
- Review／Fix loopを明示する
- Workflowが次Stepを決定する
- Quality GateをStep外の機械的判定として扱う

ただし、Takt互換schemaやPersona体系は採用しません。
