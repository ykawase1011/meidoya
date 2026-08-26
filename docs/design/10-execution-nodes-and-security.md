# Execution Nodes and Security

## 1. ExecutionNode model

```ts
type ExecutionNode = {
  id: string;
  protocolVersion: number;
  platform: "darwin" | "linux";
  architecture: "arm64" | "x64";
  profile: "mac-restricted" | "linux-restricted" | "lima-trusted";
  capabilities: string[];
  allowedWorkspaces: string[];
  maxConcurrency: number;
  status: "online" | "draining" | "offline";
};
```

Nodeは起動時に自己登録し、定期heartbeatを送ります。

## 2. Task Queue routing

```text
meidoya/control
meidoya/node/mac-main
meidoya/node/lima-work-it
meidoya/node/lima-grammarxiv
```

RoleやModelごとにQueueを増やさず、provider／tier／WorkerProfileはActivity inputにします。

## 3. Mac restricted

具体的なfilesystem境界はMacのローカル設定で定義します。

```yaml
allowed_roots:
  - ~/Workspace/Repositories
  - ~/Workspace/Music
  - ~/.local/share/meidoya/worktrees
```

Task実行時は、さらに対象Projectまたはtask worktreeへ絞ります。

安全要件:

- `realpath`後にallowed root判定
- ancestor symlink／leaf symlink拒否が必要な操作ではno-follow
- User home全体をfallback許可しない
- `.ssh`、Keychain、Library等は明示許可なしで不可
- Workerごとにcwdを固定
- Agent Runtimeのpermission／sandboxを併用

Mac restrictedはVMと同等の隔離とは扱いません。信頼度の低い入力や強いshell権限はLimaへ送ります。

## 4. Linux restricted

- allowed roots
- dedicated OS userまたはrootless container
- read-only root filesystemを推奨
- workspace／tmpだけwrite許可
- network allowlist

## 5. Lima trusted

```text
Guest内:
  full filesystem／package install可

Host側:
  明示mountだけ可
  Host home全体はmountしない
  credentialは必要なものだけmaterialize
```

`trusted`はguest内で自由という意味であり、Host全体を信頼する意味ではありません。

## 6. Node registration

```ts
type NodeRegistration = {
  nodeId: string;
  nodeVersion: string;
  protocolVersion: number;
  platform: string;
  arch: string;
  profile: string;
  capabilities: string[];
  workspaceBindings: string[];
  maxConcurrency: number;
  /** Node registration token (11 section 7). 自己申告を認証する唯一の材料。 */
  credential: string;
};
```

Control Planeは登録情報とローカルpolicyを照合し、Node自己申告だけを信用しません。

照合の前に、まず「その呼び出しが本当にそのNodeか」を確認します。`nodeId`だけでは単なるselectorであり、registrationはそのNodeのworkspace binding全体を書き換え、heartbeatはbindされた全workspaceに対してstatusを反転させます。したがって`node.register`／`node.heartbeat`は、Control Planeが`<dataDir>/nodes`に0600で払い出すper-node registration tokenを必須とします（client credentialと同じ払い出し方）。tokenはNode processの環境（`MEIDOYA_NODE_TOKEN`／`MEIDOYA_NODE_TOKEN_FILE`）から渡し、Node自身のconfigからは供給しません。認証される対象がまさにその自己申告だからです。

workspace bindingはoperator policyであり、Nodeの申告ではありません。申告に無いworkspaceを足せない（widening）のと同じ権限で、申告から消えたworkspaceを外すこと（narrowing）もできません。申告が決めるのはそのNodeが実行してよい範囲（`grantedWorkspaces`）だけです。

## 7. Run scope

```ts
type AgentRunScope = {
  workspaceId: string;
  projectAccess: Array<{
    projectId: string;
    mode: "read" | "write";
  }>;
  capabilities: string[];
  networkPolicy: string;
  sideEffectPolicy: string;
};
```

Run scopeはTask作成時のWorkspaceから導出し、Worker promptから上書きできません。

## 8. Heartbeat and recovery

- Node heartbeat: online判定
- Activity heartbeat: active Agent runのphaseとsession ID
- timeout／cancel時はprocess group単位で終了
- Node crash後はTemporal retry
- external side effectが不明な場合は自動retryせず`needs_attention`

## 9. Credentials

CredentialはNodeローカルです。

```text
Mac Keychain / SOPS
  ↓ materialize
Execution Node
  ↓
Codex / Claude CLI
```

Control Plane DBにはcredential値を保存しません。hash、version、receiptのみを保持します。

## 10. Security layers

```text
Workspace scope
  + Role capability authorization
  + Agent tool restrictions
  + Runtime sandbox
  + OS / VM boundary
  + Human side-effect gate
```

単一層だけをsecurity boundaryとして扱いません。
