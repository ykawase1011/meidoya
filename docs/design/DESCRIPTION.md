# OSS Description Candidates

## Recommended Japanese description（281文字）

Meidoyaは、Slack・Discord・CLIを入口に、Workspace専属のMaidと全体を束ねるHead Maidが、Codex／Claudeへ仕事を静かに委譲するlocal-firstなAgent Control Planeです。長時間タスク、定期実行、質問待ち、再試行をTemporalで耐久化し、Workspace境界、Model選択、Planning／Review承認、実行上限、通知やreactionまで決定論的に制御します。進捗を垂れ流さず、必要な質問と最終結果だけを返し、Mac／Linux／Limaの実行Nodeを安全に使い分けます。

## Strength-focused description（298文字）

Meidoyaの強みは、Agentの賢さではなく「仕事の受け方・止め方・返し方」をコードで所有する点です。WorkspaceごとのMaidが依頼範囲を固定し、ManagerがCodex／ClaudeとModel tierを選び、Temporalが長時間Task、cron、質問待ち、再試行を耐久化します。Planning／ReviewのHuman Gate、Step・Loop上限、filesystem権限、reaction、投稿回数まで決定論的に強制するため、Agentの暴走や進捗連投を防げます。既存Agentを置き換えず、静かで監査可能な実務システムへ変えるControl Planeです。

## Short Japanese description

Workspaceごとに専属Maidを置き、Codex／Claudeへ仕事を静かに委譲するlocal-firstなAgent Control Plane。長時間Task、cron、Human Gate、実行上限、reactionまで決定論的に管理し、質問と結果だけを返します。

## GitHub description

Local-first Agent Control Plane with one Maid per workspace, durable tasks, human gates, deterministic chat UX, and Codex／Claude workers.

## README hero

```text
Meidoya
One Maid per workspace. One Head Maid across them all.

Send work from Slack, Discord, or CLI.
Meidoya delegates it to Codex and Claude,
and only interrupts you when it needs an answer or has a result.
```

## Differentiation bullets

- **Quiet by default**: progress spamではなく、質問と結果だけを通知
- **Workspace hard scopes**: 入口からAgent Runまでscopeを固定
- **Deterministic UX**: reaction、投稿回数、message editをコードで管理
- **Durable work**: crash、cron、質問待ち、再試行をTemporalで継続
- **Harness without lock-in**: Codex／Claudeの外側でGate、Review、上限を強制
- **Local-first execution**: Mac／Linux／Limaを同一Node protocolで利用
