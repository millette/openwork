# Importing earlier chats

OpenWork runs on OpenCode v2. Chats created with the earlier OpenCode v1
engine stay in that engine's SQLite database until the person brings them
over once. Nothing is imported without their consent.

## API

- `GET /engine/status` (client auth) reports `v1HistoryAvailable` (an earlier
  chat database exists for the active profile) and `migration`, the import
  status: `state` (`idle`, `running`, `completed`, `error`), `phase` while
  running (`starting`, `converting`, `copying`), `imported`, `skipped`,
  `total`, `startedAt`, `error`, and `backupPath`.
- `POST /engine/v1-history/import` (host-token auth, body `{}`) starts the
  import and returns the same status. A request while an import is running
  returns the running status instead of starting another.

When `v1HistoryAvailable` is true, the desktop app offers to bring over
earlier chats and shows progress while the import runs. Counts only move while
copying, so progress is indeterminate before that. A failed import can be
retried; chats already copied are skipped.

## What the import does

The import snapshots the active profile's v1 SQLite database using SQLite
backup (or `VACUUM INTO` on Bun), including committed WAL writes, without
modifying the original. It first checks that the snapshot and a backup of the
v2 chat database fit on disk. A temporary, isolated instance of the pinned v2
engine opens the snapshot and performs OpenCode's native conversion. OpenWork
waits for `/api/experimental/migration/v1` to report completion, backs up the
v2 chat database, then exports converted chats and imports them into the
running v2 engine using its native APIs. Parents precede children. Existing
IDs are skipped, so retries preserve v2 conversations and do not duplicate
imports. Temporary snapshots and the converter are cleaned up afterward.

The import can partially complete if a chat fails; retrying imports the
remaining chats. Existing imported IDs are never overwritten. The import
covers local history across workspaces in the active profile, not history on
connected remote servers. Development profiles remain isolated.

OpenCode's conversion resets session permissions and revert state, converts
interrupted tool activity, and may omit malformed rows or unsupported
attachments. Its transfer API exports settled messages. Review permissions
before continuing imported chats. The import does not rewrite configuration,
skills, or plugin files; v1 plugins need v2-compatible replacements.

## Upstream contract

- [Native migration](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/database/v1-migration.bun.ts)
- [Migration status API](https://github.com/anomalyco/opencode/blob/v2/packages/protocol/src/groups/migration.ts)
- [Native session transfer](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/transfer.ts)
- [V1 compatibility guide](https://github.com/anomalyco/opencode/blob/v2/services/www/src/docs/content/migrate-v1.mdx)

## Verification

`evals/specs/v1-chat-history-import.e2e.test.ts` seeds earlier chats in a real
desktop, accepts the offer, and checks that chats and their messages are
copied with a backup, a retry copies nothing twice, and the original history
is unchanged.
