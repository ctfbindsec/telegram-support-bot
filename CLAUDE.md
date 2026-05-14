# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # development mode with hot reload (ts-node-dev)
npm run prod      # production mode (ts-node)
npm run build     # compile TypeScript to build/
npm test          # run all Jest tests

# Run a single test file
npx jest test/command.test.ts --detectOpenHandles --forceExit --runInBand

# Lint
npx eslint src/
```

The bot requires `config/config.yaml` to exist at startup (copied from `config/config-sample.yaml`). Without it the process crashes immediately because `cache.ts` reads it synchronously at module load time.

## Architecture

### Multi-Platform Addon Pattern

The bot supports Telegram, Signal, and (partially) Web as messaging platforms. Each platform is implemented as an **Addon** class that fulfills the `Addon` interface (`src/interfaces.ts`). Both `TelegramAddon` and `SignalAddon` are singletons accessed via `getInstance()`.

`src/handlers.ts:registerCommonHandlers` is the single function that wires all bot commands and event handlers. Both platform addons call it in their `start()` method, so all business logic is written once and shared across platforms.

### Unified Context

`src/interfaces.ts` defines a custom `Context` class that all business logic operates on — **this is not grammY's Context**. Platform adapters map their native message formats into this unified shape before dispatching to handlers. `src/addons/signal/mapper.ts` shows how Signal WebSocket messages are translated. `src/addons/fakectx.ts` provides a ready-made `Context` for web chat use.

### Config and Cache

`src/cache.ts` reads `config/config.yaml` via synchronous YAML parse at **module load time**. The result is stored in the singleton `cache` object that every module imports. All configuration (language strings, category definitions, spam limits, LLM settings, etc.) flows through `cache.config`. Changing config requires a process restart.

The MongoDB collection name is derived from `bot_{owner_id}_{last_5_of_bot_token}`, making each bot's data isolated within a shared MongoDB instance.

### Message Flow

**User → Staff:**
1. Incoming message → `handlers.ts:registerCommonHandlers` dispatches to `text.ts:handleText`
2. `handleText` checks for private-reply mode, category keyboard display, or falls through to `ticketHandler`
3. `ticketHandler` creates/finds the DB ticket, then calls `users.ts:chat`
4. `users.ts:chat` handles spam throttling, auto-reply (keyword match then LLM fallback), formats the ticket message, and forwards it to `config.staffchat_id`

**Staff → User:**
1. Staff reply in the staff group → `text.ts:handleText` → `staff.ts:chat`
2. `staff.ts:chat` extracts the ticket ID from the replied-to message text (pattern `#T{id} from`) or looks up by `internalIds` (message ID stored in MongoDB)
3. Sends the formatted response back to the user via the correct messenger

**File uploads** are handled separately in `src/files.ts:fileHandler`, which replicates ticket lookup and spam logic for photo/video/document types.

### Ticket State

The `Supportee` MongoDB document tracks: `ticketId` (auto-increment integer), `userid`, `messenger`, `status` (`open`/`closed`/`banned`), `category`, and `internalIds` (array of Telegram message IDs for matching staff replies).

In-memory arrays `cache.ticketIDs`, `cache.ticketStatus`, and `cache.ticketSent` track spam throttling state. These reset on process restart — only `status` persists in MongoDB.

### Permissions

`src/permissions.ts:checkPermissions` is installed as middleware in `TelegramAddon.start()`. It sets `ctx.session.admin = true` if the chat ID matches `staffchat_id` or any configured category `group_id`. Banned users have `next()` withheld silently.

### Categories and Inline Keyboards

`src/inline.ts:initInline` reads `config.categories` to generate the reply keyboard shown to users. Categories can have subgroups. Each category/subgroup registers `bot.hears()` handlers to set `ctx.session.group` and `ctx.session.groupCategory`, which routes subsequent messages to the correct staff group.

### LLM Auto-Reply

When `use_llm: true` in config, `src/addons/llm.ts` uses the llamaindex OpenAI adapter to answer questions using a static knowledge base string (`llm_knowledge` in config). The LLM is tried as a fallback after keyword-based `autoreply` patterns fail.

### Signal Addon

`SignalAddon` connects to a [signal-cli REST API](https://github.com/bbernhard/signal-cli-rest-api) over WebSocket for incoming messages and HTTP for outgoing. Group IDs require a mapping step from internal IDs to external Signal group IDs via `getGroupId()`.

### Database Migration

On startup, if `config/support.db` (SQLite) exists, `src/migrate.ts:migrateData` runs automatically to copy records into MongoDB, then renames the file to `support.old.db`. This one-time migration path exists for users upgrading from pre-v4.2.

## Testing

Tests use Jest with ts-jest. `test/mocks.ts` is loaded as a `setupFiles` entry before every test suite. It mocks:
- `src/cache` — provides a fake config with minimal required fields
- `src/db` — all DB functions are jest.fn()
- `grammy` — Bot constructor and all API methods
- `axios` and `ws` — for Signal addon tests

When writing tests, mock `middleware.reply` and `middleware.sendMessage` as `jest.spyOn` to assert outgoing messages without real network calls.

## Docker

```bash
docker-compose up -d   # starts supportbot + mongodb + signal-cli + mongo-express
```

Config is mounted at `./config:/bot/config`. MongoDB data persists in `.tmp/mongodb_data`. Signal identity data persists in the `signal` named volume.
