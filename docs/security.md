# Security & Cost Analysis

## 1. AI Prompt Injection

### Threat model

The LLM receives two inputs: (a) a system prompt containing the operator's knowledge base and (b) the end-user's Telegram message. A malicious user can craft a message that attempts to override the system prompt, extract the knowledge base, or cause the model to behave as a different agent.

### Mitigations implemented (`src/addons/llm-guard.ts`)

| Layer | Mechanism | Location |
|---|---|---|
| **Length cap** | User input truncated to 1 500 chars before reaching the LLM | `sanitizeUserInput()` |
| **Pattern blocklist** | 13 regex patterns covering "ignore previous instructions", "act as", "jailbreak", "DAN mode", role-prefix injection (`system:`/`assistant:`), and related variants — blocked messages return `null` and fall through to a human staff member | `INJECTION_PATTERNS` |
| **Delimiter strip** | Triple-quotes `"""` (used as knowledge-base boundary) are collapsed; XML role tags (`<system>`, `<assistant>`, `<user>`) are stripped | `sanitizeUserInput()` |
| **Whitespace normalisation** | 4+ consecutive whitespace chars collapsed to prevent invisible token stuffing | `sanitizeUserInput()` |
| **Hardened system prompt** | Explicit cannot-be-overridden constraint block; knowledge base wrapped in `###KNOWLEDGE_START###` / `###KNOWLEDGE_END###` markers; user input wrapped in `<user_message>` tags so the model has a clear structural boundary | `buildSystemPrompt()` |
| **Knowledge base self-sanitisation** | `###KNOWLEDGE_START/END###` markers are stripped from the on-chain knowledge base before it is embedded in the prompt, preventing an operator from accidentally or maliciously injecting delimiter breaks | `buildSystemPrompt()` |
| **Output validation** | Responses matching `/^null$/i` or empty strings are dropped before being sent to the user | `getResponseFromLLM()` |

### Residual risks and further hardening

- **Indirect prompt injection via knowledge base**: if the on-chain knowledge base itself contains adversarial instructions (e.g. a compromised `update_config` call), the LLM may be manipulated. Mitigations: (1) rate-limit `update_config` calls on-chain; (2) add a human review step before committing new knowledge base text; (3) consider storing a hash of the approved KB and verifying it on read.
- **Model-specific bypass techniques**: no blocklist is exhaustive. Periodic red-teaming against the deployed model is recommended, especially when upgrading `llm_model`.
- **LLM output used downstream**: currently the response is only sent as a Telegram message. If future work feeds LLM output into other systems (SQL, shell, etc.), output must be treated as untrusted and sanitised at those consumption points.

---

## 2. Solana Key Management

### Mitigations implemented (`src/addons/solana/index.ts`)

| Check | What it does |
|---|---|
| **Keypair file permissions** | `loadKeypair()` reads the unix file mode and throws if the file is world-readable or group-readable (anything other than `0600` / `0400`). Prevents accidental secret exposure via misconfigured filesystem permissions. |
| **Keypair format validation** | Asserts the parsed JSON is an array of exactly 64 bytes before calling `Keypair.fromSecretKey`. |
| **Program account owner check** | `readChainConfig()` verifies that the `ConfigAccount` PDA is owned by the expected program ID, not a spoofed account. |
| **Transaction simulation** | `simulateTransaction()` dry-runs every `release_escrow` and `refund_escrow` instruction before sending. Catches wrong escrow status, wrong authority, or insufficient lamports before spending fees. |
| **Customer pubkey validation** | `parsePublicKey()` wraps `new PublicKey()` in a try/catch and throws a descriptive error for invalid base58 strings, preventing transaction construction with malformed addresses. |

### Recommendations for production

- Store the bot authority keypair using a secrets manager (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager) rather than a file on disk. Mount the secret as an environment variable or a RAM-backed tmpfs.
- Consider a multisig authority (e.g. Squads Protocol) so no single key can release all escrows unilaterally.
- Rotate the bot keypair periodically; the `update_config` instruction supports changing authority without migrating escrow accounts.
- Monitor the authority wallet balance — if it drops too low, `release_escrow` transactions will fail due to insufficient fee-payer balance.

---

## 3. Cost Basis & Transaction ROI

All figures use Solana mainnet base fees as of 2025. SOL price is illustrative at **$150 / SOL**.

### Per-ticket transaction costs (paid by the bot operator)

| Event | Instruction | Fee (lamports) | Fee (USD) |
|---|---|---|---|
| Startup (one-time) | `initialize_config` | ~5 000 | ~$0.0008 |
| New ticket | `create_escrow` (customer pays) | customer pays rent + escrow | — |
| Resolution | `release_escrow` | ~5 000 | ~$0.0008 |
| SLA breach | `refund_escrow` | ~5 000 | ~$0.0008 |

> Rent for `EscrowAccount` (SPACE = 58 bytes) ≈ 890 880 lamports (~$0.13). This is paid by the customer as part of the escrow deposit and is recovered when the account is closed (future work: close the account after release/refund to return rent).

### Customer escrow deposit

The default is **0.01 SOL** (`solana_escrow_lamports: 10_000_000`).

| | Value |
|---|---|
| Escrow amount | 0.01 SOL ≈ $1.50 |
| Operator receives on resolution | 0.01 SOL − ~$0.002 in fees ≈ **$1.498** |
| Customer receives on SLA refund | 0.01 SOL − ~$0.001 in fees ≈ **$1.499** |

### RPC costs

| Tier | Cost | Suitable for |
|---|---|---|
| Public RPC (`api.mainnet-beta.solana.com`) | Free | Development / low volume |
| Helius / QuickNode starter | $50–100 / month | Up to ~100k requests/day |
| Dedicated node | $300–600 / month | High-volume production |

### Break-even analysis

At the default 0.01 SOL escrow, the operator keeps the escrow on every resolved ticket. With public RPC:

- **Break-even at ~0 tickets** (fees per ticket < $0.002, well below the $1.50 escrow).
- At 1 000 resolved tickets/month: **~$1 500 gross revenue** from escrow, ~$2 in Solana fees, plus RPC cost.

### Tuning recommendations

- Raise `solana_escrow_lamports` for premium support tiers.
- Set `solana_sla_minutes` to a realistic response SLA; a too-short SLA will trigger unnecessary refunds.
- Close escrow accounts after release/refund (add a `close_escrow` instruction) to recover rent back to the customer, improving UX and reducing friction.

---

## 4. Vulnerability Assessment Summary

| Vector | Severity | Status |
|---|---|---|
| LLM prompt injection via user message | High | Mitigated (blocklist + hardened prompt + delimiter isolation) |
| LLM indirect injection via on-chain knowledge base | Medium | Partial (KB sanitised on read; operator-side controls needed) |
| Keypair file world-readable | High | Mitigated (permission check on startup) |
| Spoofed ConfigAccount (wrong program owner) | High | Mitigated (owner check on deserialization) |
| Invalid customer pubkey in refund | Medium | Mitigated (explicit validation before tx build) |
| Transaction fails silently after escrow closed | Medium | Mitigated (simulation before submit) |
| LLM response leaks knowledge base verbatim | Medium | Partial (prompt instructs model not to; no structural output filter yet) |
| Escrow double-release (race condition) | Low | Mitigated on-chain (Anchor `EscrowStatus` enum guard) |
| RPC endpoint substitution (MITM) | Low | Use HTTPS RPC endpoints; consider certificate pinning |
