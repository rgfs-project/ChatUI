# Claude data export: observed format

What ChatUI's Claude importer (Phase 13e) relies on, recorded from a real export. Anything not listed as observed is **UNVERIFIED**, and the importer either skips it with a report or refuses the archive.

## Provenance

- **Source:** the operator's own account export (claude.ai → Settings → Privacy → Export data), downloaded on 2026-09-30 as four ZIPs: `conversations-000.zip`, `memories-000.zip`, `feedback-000.zip`, `light_metadata-000.zip`.
- **Fixtures:** `tests/fixtures/claude-export/`, produced by `node scripts/sanitize-export.ts claude …`.
  - Kept: every field name, nesting, type, count and edge case; structural enums (block `type`, `sender`, tool names, languages, MIME types); UUID linkage (with fresh UUIDs); timestamp formats (shifted by 100 days).
  - Replaced: all text (titles, messages, thinking, summaries, file contents, memories, reflections, account and login data), and file names inside paths.
  - The run fails if any original text of six or more characters survives outside kept structure. The key/type shape of the sanitized `conversations.json` was verified identical to the original.
- The ZIP entries carry the 1980-01-01 DOS timestamp.

## Archives and entries (observed)

| ZIP                      | Entry                              | Imported?                                                     |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `conversations-000.zip`  | `conversations.json`               | Yes: conversations, text attachments, `create_file` artifacts |
| `memories-000.zip`       | `memories/<account-uuid>.json`     | Yes: memory files, as memories (only when selected)           |
| `feedback-000.zip`       | `reflections/<account-uuid>.json`  | No: Claude's usage reflections; reported as skipped           |
| `light_metadata-000.zip` | `users.json`, `login_history.json` | No: account and sign-in data; reported as skipped             |

Each ZIP can be imported on its own, or several entries can be combined in one ZIP. A ZIP nested inside a ZIP is UNVERIFIED and is refused, not unpacked.

## `conversations.json` (observed)

An array of conversations:

- `uuid` (lowercase UUID) → the ChatUI conversation id.
- `name` → the title. An empty name was observed; it becomes "Untitled chat". Line breaks are collapsed, and the title is cut to 200 characters.
- `summary` (sometimes empty): not imported.
- `created_at`, `updated_at`: `YYYY-MM-DDTHH:MM:SS.ffffffZ` (microseconds). Truncated to milliseconds.
- `account.uuid`: never used (the destination is the signed-in user).
- `chat_messages[]`, each with:
  - `uuid`, and `sender`: `human` or `assistant` (the only values observed).
  - `text`, and `content[]` (typed blocks).
  - `created_at`, `updated_at` (microseconds).
  - `attachments[]`, `files[]`, `parent_message_uuid`.
- A conversation with no messages was observed (imported empty).
- A human and an assistant message with empty `content` were observed (imported with empty bodies).

**Message order.** In every observed conversation, the array order is one linear chain: each message's `parent_message_uuid` is the previous message's `uuid`, and the first message's parent is `00000000-0000-4000-8000-000000000000`. Branches (a parent with several children, from edits or retries) were **not observed** (UNVERIFIED). The importer then keeps the path to the most recently created leaf and reports the other messages as skipped.

**Content blocks** (`content[].type`), all observed:

- `text` (`text`, `citations[]`, `start_timestamp`/`stop_timestamp`, `flags`): joined with a blank line into the message body. `citations` are not imported.
- `thinking` (`thinking`, `summaries[].summary`, `cut_off`, `truncated`, `hidden`, `thinking_hidden`, …): joined into the reasoning block.
- `tool_use` (`id`, `name`, `input`, `display_content`, `integration_name`, `tool_origin`, `message`, …) and `tool_result` (`tool_use_id`, `name`, `content[]` of `text` or `local_resource`, `is_error`, `meta`): not imported (ChatUI stores no tool transcripts, contracts §4.3), and counted in the import report. The exception is below.
  - `create_file` (`input.path` like `/mnt/user-data/outputs/<name>.<ext>`, `input.file_text`, `input.description`; `display_content.type: "code_block"` with `language` and `filename`): each becomes an **imported artifact**. Its name is the basename of `path` (ChatUI's artifact name rules apply; others are skipped and reported), its bytes are `file_text`, and its language comes from `display_content.language`.
  - Other observed tools (`present_files`, `visualize:read_me`): skipped and counted.
- `token_budget`: ignored.
- Legacy artifact blocks (the older `artifacts` tool with `create`/`update` commands) were **not observed** (UNVERIFIED). They are reported as unsupported tool calls, never imported.

**Attachments**:

- `attachments[]` (`file_name`, `file_size`, `file_type` — only `txt` was observed — and `extracted_content`) become a ChatUI text attachment containing `extracted_content`, linked to the user message.
- `files[]` (`file_uuid`, `file_name`) carry no bytes in the export. They are skipped and reported by name.

## `memories/<account-uuid>.json` (observed)

`{ account_uuid, memory_files: [{ path, content, updated_at }] }`:

- `path` like `/areas/<name>.md`; `updated_at` with an offset (`+00:00`) and microseconds.
- Each file becomes an approved-memory candidate named after the basename without `.md` (ChatUI's memory name rules apply). It is imported only if the user selects it in the preview.
- A file over 4,096 bytes is skipped as too long.

## IDs and repeat imports

Conversation and message ids are Claude's own UUIDs. Attachment, artifact and memory ids are derived deterministically (SHA-256 of the source ids, formatted as a UUID). Importing the same export again finds everything identical. The duplicate-import key is SHA-256 over the sorted entry names and checksums.

## Not supported

Projects, shared links, images and other binary uploads, citations, tool transcripts, reflections, and account and login metadata. The importer reports these instead of inventing an equivalent.
