# Hermes Fleet Migration

`hermes-fleet`は新しいruntime dependencyにせず、実装・失敗事例・安全機構の採掘元として利用します。

## 1. Move with tests

比較的そのまま移植できる候補:

```text
bounded subprocess／process-group kill
Lima clientの安全なguest exec
regular-file snapshot／no-follow
filesystem safety／dirfd helpers
project／auth lock
Keychain／SOPS execution wrappers
process evidence／preflight
```

移植時は必ず既存testも同時に持ってきます。

## 2. Rewrite around new domain

| Existing area | Target |
|---|---|
| `src/lima/*`, `src/vm/*` | `meidoya-yashiki/provider-lima` |
| Claude／Codex secret sync | `meidoya-yashiki/credentials` |
| Session／dashboard state | `meidoya/status-projector` |
| Scope schema／audit | `meidoya/workspace-scope` |
| Workboard publisher | `meidoya/interaction-policy`＋Outbox |
| Backup／recovery | `meidoya-yashiki/backup`／`recovery` |

## 3. Reference principles only

- fail-closed
- bounded output
- exact read-back verification
- deterministic identity
- paused-first activation
- idempotency
- checksum／receipt
- ownership boundary
- private-by-default projection
- no secret-bearing logs

## 4. Drop

```text
Hermes Gateway lifecycle
HERMES_HOME assumptions
Hermes Profile
Hermes Kanban adapter
Hermes cron registry wrapper
Runtime Kit Plugin／Skill／Profile asset bundle
Hermes source pin
Host Hermes restart logic
Hermes template parity
Hermes-specific Workboard convergence
```

## 5. Migration strategy

```text
1. Freeze new product features in hermes-fleet
2. Create meidoya vertical slice
3. Extract subprocess／filesystem primitives
4. Create meidoya-yashiki Lima provider
5. Run one Workspace in parallel
6. Compare completion／question／notification behavior
7. Switch Workspace ingress
8. Repeat per Workspace
9. Archive legacy runtime after rollback window
```

一括migrationは行いません。
