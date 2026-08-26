# Slack・Discord受信の設定

MeidoyaはSlack Socket ModeとDiscord Gatewayを同時に起動できます。チャンネルの
ルート投稿は新規タスクになり、既存タスクのスレッド／返信は未回答checkpointへの
回答になります。Workspaceは本文ではなく、設定済みのaccountとchannelだけで
fail-closedに決定されます。

## 1. Workspace binding

`config.yaml`の対象Workspaceへ入口を追加します。Slackの`account`はTeam ID、
Discordの`account`はGuild IDです。

```yaml
workspaces:
  personal:
    ingress:
      cli:
        profile: personal
      slack:
        account: T0123456789
        channel: C0123456789
      discord:
        account: "123456789012345678"
        channel: "234567890123456789"
```

未登録チャンネル、無効binding、複数Workspaceに一致する曖昧なbindingは受理されません。

## 2. 秘密情報

トークンはYAMLやGit管理下へ書かず、Meidoyaルート外または
`$HOME/meidoya/secrets`の`0600`ファイルに置きます。

```bash
export BASE="${MEIDOYA_HOME:-$HOME/meidoya}"
mkdir -p "$BASE/secrets"
chmod 700 "$BASE/secrets"
chmod 600 "$BASE/secrets"/*.token

export MEIDOYA_SLACK_BOT_TOKEN_FILE="$BASE/secrets/slack.bot.token"
export MEIDOYA_SLACK_APP_TOKEN_FILE="$BASE/secrets/slack.app.token"
export MEIDOYA_DISCORD_BOT_TOKEN_FILE="$BASE/secrets/discord.bot.token"
```

従来の`MEIDOYA_SLACK_BOT_TOKEN`、`MEIDOYA_SLACK_APP_TOKEN`、
`MEIDOYA_DISCORD_BOT_TOKEN`も利用できますが、シェル履歴やlaunchd設定へ値を
残しにくい`*_FILE`を推奨します。ファイルにはトークン本体だけを書きます。

SlackはSocket Modeを有効化し、`connections:write`を持つApp-level tokenと、
対象チャンネルを読めるBot tokenを用意します。イベント購読は利用するチャンネルに
応じて`message.channels`または`message.groups`、Bot scopeは少なくとも
`chat:write`、履歴参照、reaction操作に必要な権限を付与します。

DiscordはDeveloper PortalでMessage Content Intentを有効にし、対象チャンネルで
View Channel、Send Messages、Read Message History、Add ReactionsをBotへ許可します。

## 3. 起動と確認

```bash
export BASE="${MEIDOYA_HOME:-$HOME/meidoya}"
cd "$BASE/repositories/meidoya"

export MEIDOYA_CONFIG="$BASE/config/config.yaml"
export MEIDOYA_NODE_CONFIG="$BASE/config/node.yaml"
export MEIDOYA_SOCKET="$BASE/data/meidoya.sock"
export MEIDOYA_PROFILE=personal

pnpm local:start
```

Dockerを使わずTemporal CLIを別ターミナルの`127.0.0.1:7233`で起動済みなら、
最後のコマンドは`pnpm build && node tools/local-run.mjs`に置き換えます。詳細は
[`quick-reference-ja.md`](./quick-reference-ja.md)を参照してください。

起動ログへ`slack ingress started`、`discord ingress started`が出ることを確認します。
切断時は指数backoffで自動再接続します。認証不足やSocket Mode未設定は
`could not start ... ingress`としてstderrへ出ます。

1. 対象チャンネルへ新しいルート投稿を送る。
2. `pnpm meidoya task list --limit 20`で`origin=chat`のタスクを確認する。
3. checkpoint通知へスレッド返信する。
4. 承認は`Approve`、`承認します`、拒否は`Reject`、`却下`を使う。
5. clarificationには任意の回答文を返信する。

同じSlack envelopeやDiscord messageが再配送されても、platform message ID由来の
idempotency keyで同じタスクへ収束します。

返答はSlackではBlock Kit、DiscordではEmbedへ整形されます。自然言語のTask一覧と
状態遷移の詳細は[`task-status-ja.md`](./task-status-ja.md)を参照してください。

## 4. Hermesからの一時切替

同じDiscord Bot tokenをHermesとMeidoyaで同時にGateway接続しません。Meidoyaを
起動する直前にHermes Gatewayだけをbootoutします。

```bash
launchctl bootout "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/ai.hermes.gateway.plist"
```

Meidoyaを停止してHermesへ戻す場合は次を実行します。

```bash
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/ai.hermes.gateway.plist"
```

Bot tokenだけをHermesの秘密管理元からMeidoya用ファイルへ materializeし、Hermesの
`.env`全体やClaude/Codexなど無関係な秘密はコピーしません。実切替前にCLIタスクを
一件完走させ、切替後はDiscordの一件だけでE2E確認します。
