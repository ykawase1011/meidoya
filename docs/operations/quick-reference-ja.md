# Meidoya ローカル運用クイックリファレンス

Meidoyaを手元で試す最短構成は、Docker上の実Temporal、ホスト上の
`meidoyad`、`meidoya-node`、認証済みの実CodexまたはClaudeを使う
`local:start`です。fake runtimeは使いません。Yashiki/Limaによる隔離VMは
別の配備方式であり、2026-08-25の受入テスト用VMは検証後に削除済みです。

## 1. 今回の手動テスト環境

```bash
export BASE="${MEIDOYA_HOME:-$HOME/meidoya}"
cd "$BASE/repositories/meidoya"

export MEIDOYA_CONFIG="$BASE/config/config.yaml"
export MEIDOYA_NODE_CONFIG="$BASE/config/node.yaml"
export MEIDOYA_SOCKET="$BASE/data/meidoya.sock"
export MEIDOYA_PROFILE=manual
```

対象プロジェクトとCLIで指定するプロジェクトIDは、`meidoya init`で登録した値を
使います。シェルを新しく開くたびに上記の環境変数を設定します。
通常の`~/.config/meidoya`を誤って上書きしないため、この手順では設定とデータを
`$BASE`にまとめています。リポジトリ本体は`$BASE/repositories/meidoya`、
設定・データ・秘密はそれぞれ別ディレクトリです。

## 2. 起動と正常性確認

Docker Desktopを起動し、ターミナル1で次を実行したままにします。

```bash
pnpm local:start
```

これはTemporal/PostgreSQL/UIを起動し、ビルド後に`meidoyad`と
`meidoya-node`を監督します。ターミナル2で同じ環境変数を設定して確認します。

Docker Hubへ接続できない場合は、公式Temporal CLIも利用できます。ターミナル1で
永続DB付きの開発サーバーを起動し、ターミナル2でMeidoyaだけを起動します。

```bash
# ターミナル1
temporal server start-dev \
  --ip 127.0.0.1 \
  --port 7233 \
  --ui-port 8080 \
  --db-filename "$BASE/data/temporal.db"

# ターミナル2
pnpm build
node tools/local-run.mjs
```

この経路では`pnpm local:start`を使いません。`config.yaml`と`node.yaml`のTemporal
addressはどちらも`127.0.0.1:7233`にします。

```bash
pnpm meidoya doctor
pnpm meidoya status
```

`doctor`は設定、Node.js、Codex/Claude、Temporal、Unix socket、CLIセッション、
Control Plane、実行ノードを診断します。`status`は現在のControl Plane全体の
運用状態を見るコマンドです。Temporal UIは <http://localhost:8080> です。

## 3. 指示、一覧、詳細、監視

```bash
pnpm meidoya submit \
  "README.mdを読み、見出しと用途を報告してください。ファイルは変更しないでください。" \
  --pipeline quick \
  --project manual-project

pnpm meidoya task list --limit 20
pnpm meidoya task list --status running
pnpm meidoya task list --status completed
pnpm meidoya task get <task-id>
pnpm meidoya task watch <task-id>
pnpm meidoya task cancel <task-id> --reason "operator request"
```

`submit`は既定で完了までイベントを表示します。`--detach`を付けると投入後すぐ
戻るため、`task watch`で追跡します。承認や質問待ちになった場合は`task get`で
checkpoint IDを確認し、次のように回答します。

```bash
pnpm meidoya task answer <task-id> --checkpoint <checkpoint-id> "承認します"
```

Slack／Discordで「進行中のタスクは？」と尋ねると未完了Taskだけを状態別に表示します。
「確認待ちは？」「完了済みは？」「全タスクを見せて」の使い分けと、各状態へ変わる
タイミングは[`task-status-ja.md`](./task-status-ja.md)を参照してください。

## 4. 定期実行

定期実行はホストOSの`crontab`ではなく、Control PlaneがTemporal Scheduleとして
管理します。自然言語から登録する場合は、専用CLI入口を使えます。

```bash
pnpm meidoya schedule add \
  "平日の朝9時にREADME.mdを確認して要点を報告して" \
  --project <project-id>
```

`schedule add`はScheduleとしての解釈をMaidへ明示します。Maidは5フィールドの
cron式、名前、実行内容へ変換し、時刻帯の指定がなければ`environment.timezone`を
使って有効状態で登録します。頻度や実行時刻が曖昧な場合は登録せず、再入力を案内します。
登録後は続けて現在のSchedule一覧を表示します。`--detach`を付けると解釈依頼の
投入後すぐ戻ります。

通常のCLI依頼やSlack／Discordのプロンプトも、定期登録を明示すれば同じ経路を
利用します。

```bash
pnpm meidoya submit "毎週月曜の10時に依存関係を確認して報告して"
```

自然言語解釈には、Maid用のCodexまたはClaude runtime設定が必要です。モデルを
使わず、登録内容を完全に固定したい場合は従来どおりcron式を直接指定します。

```bash
pnpm meidoya schedule create \
  --name readme-check \
  --cron "0 9 * * 1-5" \
  --timezone Asia/Tokyo \
  --summary "README.mdを確認して要点を報告する" \
  --enabled

pnpm meidoya schedule list
pnpm meidoya schedule run-now <schedule-id>
pnpm meidoya schedule pause <schedule-id>
pnpm meidoya schedule resume <schedule-id>
pnpm meidoya schedule delete <schedule-id>
```

## 5. パイプラインと安全上の注意

- 最初は読み取り中心の`quick`を使います。
- 初期生成された設定はquality gateが空です。`coding`を本格利用する前に、
  Control Plane側とnode側の両方へ許可する検証コマンドを明示します。
- `MEIDOYA_PROFILE`はworkspace名そのものではなくCLI ingressの要求です。
  実際の権限はdata directory内の`0600`セッション資格情報で検証されます。
- Codex/Claudeの認証情報を対象リポジトリやYAMLへ書きません。ホストで先に各CLIを
  認証し、`codex --version`または`claude --version`で起動可能か確認します。
- `--project`にはパスではなく設定上のプロジェクトIDを渡します。
- 通常設定に対する`meidoya init --force`は既存設定を置換するため、意図しない限り
  使用しません。

## 6. 停止とトラブルシュート

ターミナル1で`Ctrl-C`を押すと`meidoyad`と`meidoya-node`がdrainして停止します。
Temporalは別途停止します。

```bash
pnpm temporal:down
```

主な確認先は次のとおりです。

- Temporalが失敗: Dockerの稼働を確認し、`pnpm temporal:logs`を見る。
- execution nodeがoffline: `pnpm local:start`のターミナルが生きているか確認する。
- profile/sessionエラー: 4個の`MEIDOYA_*`環境変数と`$BASE/data`を確認する。
- runtimeエラー: `codex --version`または`claude --version`とログイン状態を確認する。
- 変更確認: 対象プロジェクトで`git status --short`を実行する。

Slack／Discord受信を使う場合は
[`chat-ingress-ja.md`](./chat-ingress-ja.md)も参照してください。
