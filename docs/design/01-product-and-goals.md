# Product and Goals

## 1. Product identity

```text
Product: Meidoya
Core repository: meidoya
Infrastructure repository: meidoya-yashiki
```

Meidoyaは、Coding Agentを直接操作するための汎用LLM frameworkではありません。ユーザーとAgentの間に入り、受付、Task化、Planning、委譲、質問待ち、完了通知を一貫して管理する**local-firstな秘書Control Plane**です。

## 2. Core promise

> **One Maid per workspace. One Head Maid across them all. Questions and results only.**

### 2.1 Workspace専属Maid

各Workspaceには論理的に1体のMaidが常駐します。常駐するのは長寿命Workflowとidentityであり、Codex processを常時起動するわけではありません。

```text
#work-grammarxiv → Maid(work-grammarxiv)
#work-it         → Maid(work-it)
#work-music      → Maid(work-music)
```

Workspace固有入口からは、そのWorkspaceの外へ出ません。

### 2.2 Head Maid

Head Maidは、明示grantされたWorkspaceのMaidへ依頼を委譲できます。対象WorkspaceのManagerやWorkerを直接起動せず、必ずMaidを経由します。

### 2.3 Quiet by default

受付後の進捗は内部に記録しますが、外部threadへ逐次投稿しません。外部通知は質問、Human Gate、完了、失敗、実行上限到達に限定します。

## 3. Functional goals

- Slack、Discord、CLIを共通の入口として扱う
- Ingress BindingでWorkspace scopeをfail-closedに固定する
- 即答可能な依頼はfast laneで処理する
- 調査、実装、複数Step、長時間処理はdurable task化する
- cron／定期実行を通常Taskと同じ処理経路へ流す
- PlanningとReviewで任意のHuman Gateを設定できる
- User input待ちの間はAgent processを保持しない
- Head Maid、Maid、ManagerはCodexを利用する
- WorkerはCodex／Claudeとlogical model tierを選べる
- ManagerがWorker provider／tierを提案し、policyが検証する
- Mac／Linux／LimaのExecution NodeへTaskをroutingする
- 無限実行をStep数、loop回数、時間、no-progressで止める
- reaction、通知回数、message edit／postを決定論的に制御する
- 会社利用ではChatを外し、CLI／Core／Nodeだけで利用できる

## 4. Non-goals

MVPでは次を作りません。

- 独自LLM agent loop
- Hermes互換Profile／Kanban／cron
- Takt互換Workflow engine
- 任意のYAMLで何でも書ける汎用Workflow DSL
- 全chat platformへの対応
- Web dashboardの完全版
- Cloud multi-tenant SaaS
- 複数組織向けの共有Subscription credential
- Human Gateを回避する完全自律production operation

## 5. Terminology

| Term | 意味 |
|---|---|
| `Environment` | 個人用、会社用など、独立したMeidoya全体 |
| `Workspace` | 1つの業務領域。1体のMaidを持つhard scope |
| `Project` | Workspace内の製品／案件 |
| `Repository` | 実際のGit repository |
| `HeadMaid` | Workspace横断の総合秘書 |
| `Maid` | Workspace専属の受付役 |
| `Manager` | Task計画・配置・Review判断の所有者 |
| `Worker` | 1 Stepを実行するCodex／Claude Agent |
| `WorkerProfile` | researcher、implementer、reviewer等の専門性 |
| `Task` | durableまたはinlineな仕事の単位 |
| `Step` | Task内の実行単位 |
| `Checkpoint` | ユーザー判断を待つHuman Gate |
| `ExecutionNode` | Agent processを実行するMac／Linux／Lima daemon |
| `Yashiki` | Execution Nodeを構築・運用するinfra repository |

## 6. Design test

新機能を追加する前に、次の質問へYesで答えられることを条件とします。

> ユーザーの依頼をWorkspace境界内で静かに確実に処理し、必要な時だけ話しかけるために、本当に必要か。
