# Agent Runtimes and Model Routing

## 1. AgentRuntime interface

```ts
interface AgentRuntime {
  readonly id: string;

  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  resume(input: AgentResumeInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
  capabilities(): AgentRuntimeCapabilities;
}
```

Control PlaneはCodex／Claude固有型をdomainへ漏らしません。

## 2. Codex runtime

初期実装はCodex SDKをautomation pathとして利用し、必要に応じてApp Server adapterを追加します。

- Head Maid: Codex
- Maid: Codex
- Manager: Codex
- Worker: CodexまたはClaude

Codex thread／session IDをSQLiteへ保存し、Manager reviewやTask resumeで利用します。

## 3. Claude runtime

ローカル個人利用ではClaude Code CLIのheadless実行を利用します。

```text
claude -p
stream-json
session ID capture
--resume <session-id>
```

Subscription credentialは単一ユーザーのNode内に保持し、複数ユーザーへ共有するcentral serviceには利用しません。

## 4. Logical model profiles

Vendorの具体的model名をdomain logicへ書きません。

```text
high
standard
economy
```

ローカル設定で実Modelへmappingします。

```yaml
models:
  codex:
    high: sol
    standard: terra
    economy: luna
  claude:
    high: opus
    standard: sonnet
    economy: haiku
```

上記は論理例であり、model更新時はmappingだけを変更します。

## 5. Role defaults

| Role／用途 | Provider | Profile |
|---|---|---|
| Head Maid | Codex | high |
| Maid | Codex | high |
| Manager | Codex | high |
| 難しい設計／調査 | Codex／Claude | high |
| 通常実装 | Codex／Claude | standard |
| rename／定型編集 | Codex／Claude | economy |
| Security review | Codex／Claude | high |

## 6. Routing flow

```text
Maid
  → task class / risk / budget
Manager
  → provider / model profile / WorkerProfile proposal
Control Plane
  → allowlist / capability / quota / gate validation
Execution Node Resolver
  → concrete runtime and node
```

Managerは具体的なNode pathやcredentialを指定しません。

## 7. Escalation

```text
economy failure
  → standard
standard same failure
  → high
high no progress
  → needs_attention
```

Escalation回数はroot execution budgetで制限します。

## 8. Structured output

RoleごとにZod／JSON Schemaでoutputを固定します。

```text
MaidDecision
ExecutionPlan
ManagerDecision
WorkerResult
ReviewFindings
```

schema validation失敗時は、同じAgentへ1回だけrepairを依頼し、それでも失敗した場合はretry budgetを消費します。

## 9. Tool／permission policy

### Head Maid／Maid／Manager

- shellなし
- filesystem writeなし
- repository accessなし
- Control Planeのscoped toolsのみ

### Worker

WorkerProfileとStep capabilityに応じて渡します。

```text
repo.read
repo.write
shell
network
browser
package-install
external-side-effect
```

Runtime側のtool設定だけでなく、Control PlaneとOS sandboxでも強制します。

## 10. Session lifetime

- user wait中はprocessを終了
- external session IDだけ保存
- Task／Stepごとにsessionを分離
- Workspace Maidの状態を1つの巨大sessionへ蓄積しない
- Task stateはTemporal／SQLiteから再構成する
