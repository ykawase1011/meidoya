# Meidoya / Meidoya Yashiki 設計資料

- Product: **Meidoya**
- Repository 1: **`meidoya`**
- Repository 2: **`meidoya-yashiki`**
- 対象OS: macOS / Linux
- 主実装言語: TypeScript
- 状態: Architecture baseline
- 更新日: 2026-08-17

## プロダクト説明文（約300字）

> Meidoyaは、Slack・Discord・CLIを入口に、Workspace専属のMaidと全体を束ねるHead Maidが、Codex／Claudeへ仕事を静かに委譲するlocal-firstなAgent Control Planeです。長時間タスク、定期実行、質問待ち、再試行をTemporalで耐久化し、Workspace境界、Model選択、Planning／Review承認、実行上限、通知やreactionまで決定論的に制御します。進捗を垂れ流さず、必要な質問と最終結果だけを返し、Mac／Linux／Limaの実行Nodeを安全に使い分けます。

文字数: 281文字

## 強み説明（298文字）

> Meidoyaの強みは、Agentの賢さではなく「仕事の受け方・止め方・返し方」をコードで所有する点です。WorkspaceごとのMaidが依頼範囲を固定し、ManagerがCodex／ClaudeとModel tierを選び、Temporalが長時間Task、cron、質問待ち、再試行を耐久化します。Planning／ReviewのHuman Gate、Step・Loop上限、filesystem権限、reaction、投稿回数まで決定論的に強制するため、Agentの暴走や進捗連投を防げます。既存Agentを置き換えず、静かで監査可能な実務システムへ変えるControl Planeです。

### English one-liner

> **One Maid per workspace. One Head Maid across them all. Codex and Claude do the work; Meidoya runs the office quietly.**

## 一番やりたいこと

Slack、Discord、CLIから依頼すると、Workspace専属のMaidが受け付け、Managerが作業を分解し、Codex／Claude Workerへ委譲します。長い作業はdurable taskとして継続し、ユーザーへの外部通知は原則として次だけに限定します。

- 回答にユーザー判断が必要になった時
- Planning／ReviewのHuman Gateが有効な時
- 作業が完了した時
- 作業が失敗または実行上限に達した時

通常の進捗は外部へ投稿しません。受付reaction、確認時reaction、完了reaction、投稿回数、threadの使い方はLLMではなくコードで決めます。

## 固定するAgent階層

```text
HeadMaid
  └─ Maid
       └─ Manager
            └─ Worker
```

| Role | Scope | 責務 |
|---|---|---|
| `HeadMaid` | Environment全体 | Workspace横断受付、grant確認、各Maidへの委譲、結果集約 |
| `Maid` | 1 Workspace | ユーザー受付、quick／durable判定、Workspace境界維持 |
| `Manager` | 1 Task | Planning、Step分解、Worker／Model選択、Review結果処理 |
| `Worker` | 1 Step | 調査、実装、テスト、レビューなどの実作業 |

Reviewer、Researcher、Implementerは独立Roleにせず、`WorkerProfile`として表現します。

## Repository境界

```text
meidoya
  = 秘書組織、Task、Schedule、Chat UX、Workflow、Agent Runtime

meidoya-yashiki
  = Mac／Linux／Lima Execution Nodeの構築・配備・運用
```

`meidoya`は`meidoya-yashiki`へ依存しません。`meidoya-yashiki`は、`meidoya`が公開するNode Protocolと`meidoya-node`のrelease artifactだけを利用します。

## Taktの扱い

Taktは直接依存にも互換対象にもせず、Harness Engineeringの参考に限定します。

取り入れる考え方:

- Agentの外側に状態遷移を置く
- Planning／Implementation／Review／Fixを明示する
- Stepごとに権限と構造化出力を指定する
- Reviewを飛ばせないようにする
- `max_steps`とReview／Fix loop制限を設ける
- isolated worktreeとQuality Gateを使う

持ち込まないもの:

- TaktのRole／Persona体系
- Takt互換Workflow DSL
- Taktの実行engine
- 汎用multi-agent framework化

MVPでは固定パイプラインをコードで実装し、Human Gate、上限、Model routingだけを設定可能にします。

## 文書一覧

| File | 内容 |
|---|---|
| `01-product-and-goals.md` | 目的、非目的、用語、UX promise |
| `02-architecture.md` | 全体構造と主要処理経路 |
| `03-repository-boundaries.md` | 2 Repositoryの責務と依存契約 |
| `04-roles-and-scopes.md` | Role、Workspace境界、Head Maid delegation |
| `05-task-lifecycle.md` | quick／durable、Planning、実行、Review、完了 |
| `06-human-gates-and-limits.md` | Human Gateと無限実行防止 |
| `07-interaction-policy.md` | reaction、通知回数、thread UX |
| `08-temporal-and-sqlite.md` | Temporalと業務SQLiteの責務分離 |
| `09-agent-runtimes-and-model-routing.md` | Codex／Claude、Model tier、権限 |
| `10-execution-nodes-and-security.md` | Mac／Linux／Lima Nodeとsandbox |
| `11-yashiki-design.md` | `meidoya-yashiki`の設計 |
| `12-implementation-roadmap.md` | 実装順とDefinition of Done |
| `13-hermes-fleet-migration.md` | 既存資産の移植／廃棄分類 |
| `DESCRIPTION.md` | OSS向け説明文候補 |
| `config.example.yaml` | Environment／Workspace設定例 |
| `workflow-policy.example.yaml` | 固定パイプラインのpolicy設定例 |
| `node.example.yaml` | Execution Nodeローカル設定例 |
| `schema-outline.sql` | 業務SQLiteのschema骨格 |
| `SOURCES.md` | 参考資料 |
