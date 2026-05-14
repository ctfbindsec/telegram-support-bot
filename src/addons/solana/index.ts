import fs from 'fs';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as log from 'fancy-log';
import cache from '../../cache';
import { OnChainConfig, EscrowInfo } from './types';

const CONFIG_SEED = Buffer.from('config');
const ESCROW_SEED = Buffer.from('escrow');

// unix octal permission mask: owner read+write only (0600) or read-only (0400)
const SAFE_KEYPAIR_MODES = [0o600, 0o400];

class SolanaService {
  private static instance: SolanaService | null = null;

  private connection: Connection | null = null;
  private wallet: Keypair | null = null;
  private programId: PublicKey | null = null;
  private chainConfig: OnChainConfig | null = null;

  private constructor() {}

  public static getInstance(): SolanaService {
    if (!SolanaService.instance) {
      SolanaService.instance = new SolanaService();
    }
    return SolanaService.instance;
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const { solana_rpc_url, solana_program_id, solana_wallet_keypair_path } = cache.config;

    this.connection = new Connection(solana_rpc_url, 'confirmed');
    this.programId = new PublicKey(solana_program_id);

    this.wallet = this.loadKeypair(solana_wallet_keypair_path);

    log.info(`SolanaService: connected to ${solana_rpc_url}`);
    log.info(`SolanaService: program ${solana_program_id}`);
    log.info(`SolanaService: authority ${this.wallet.publicKey.toBase58()}`);

    this.chainConfig = await this.readChainConfig();
  }

  /**
   * Load keypair from a JSON file and enforce that the file is not
   * world-readable (prevents accidental secret exposure).
   */
  private loadKeypair(keypairPath: string): Keypair {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(keypairPath);
    } catch {
      throw new Error(`SolanaService: keypair file not found: ${keypairPath}`);
    }

    // Check permissions on non-Windows systems
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777;
      if (!SAFE_KEYPAIR_MODES.includes(mode)) {
        throw new Error(
          `SolanaService: keypair file ${keypairPath} has unsafe permissions ` +
          `(${mode.toString(8)}). Run: chmod 600 ${keypairPath}`,
        );
      }
    }

    let keypairData: number[];
    try {
      keypairData = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
    } catch {
      throw new Error(`SolanaService: failed to parse keypair file: ${keypairPath}`);
    }

    if (!Array.isArray(keypairData) || keypairData.length !== 64) {
      throw new Error('SolanaService: keypair file must be a JSON array of 64 bytes');
    }

    return Keypair.fromSecretKey(Uint8Array.from(keypairData));
  }

  // ── On-chain config ─────────────────────────────────────────────────────────

  async readChainConfig(): Promise<OnChainConfig> {
    if (!this.connection || !this.programId) {
      throw new Error('SolanaService not initialised');
    }

    const [configPda] = PublicKey.findProgramAddressSync(
      [CONFIG_SEED],
      this.programId,
    );

    const accountInfo = await this.connection.getAccountInfo(configPda);
    if (!accountInfo) {
      log.warn('SolanaService: ConfigAccount not found on-chain; using local config');
      return this.localFallbackConfig();
    }

    // Verify the account is owned by our program (not a spoofed account)
    if (!accountInfo.owner.equals(this.programId)) {
      throw new Error(
        `SolanaService: ConfigAccount is owned by ${accountInfo.owner.toBase58()}, ` +
        `expected program ${this.programId.toBase58()}`,
      );
    }

    // Deserialise: skip 8-byte Anchor discriminator, then read fields manually.
    // Layout: authority(32) | llm_model(4+n) | llm_knowledge(4+n) | sla_minutes(4) | escrow_lamports(8) | bump(1)
    const data = accountInfo.data;
    let offset = 8; // skip discriminator
    offset += 32;   // skip authority pubkey

    const llmModelLen = data.readUInt32LE(offset); offset += 4;
    const llmModel = data.slice(offset, offset + llmModelLen).toString('utf8'); offset += llmModelLen;

    const llmKnowledgeLen = data.readUInt32LE(offset); offset += 4;
    const llmKnowledge = data.slice(offset, offset + llmKnowledgeLen).toString('utf8'); offset += llmKnowledgeLen;

    const slaMinutes = data.readUInt32LE(offset); offset += 4;
    const escrowLamports = Number(data.readBigUInt64LE(offset));

    const config: OnChainConfig = { llmModel, llmKnowledge, slaMinutes, escrowLamports };
    log.info(`SolanaService: loaded on-chain config — model=${llmModel}, sla=${slaMinutes}m, escrow=${escrowLamports} lamports`);
    return config;
  }

  getCachedChainConfig(): OnChainConfig | null {
    return this.chainConfig;
  }

  // ── Escrow PDAs ─────────────────────────────────────────────────────────────

  getEscrowPda(ticketId: number): [PublicKey, number] {
    if (!this.programId) throw new Error('SolanaService not initialised');
    const ticketIdBuf = Buffer.alloc(8);
    ticketIdBuf.writeBigUInt64LE(BigInt(ticketId));
    return PublicKey.findProgramAddressSync(
      [ESCROW_SEED, ticketIdBuf],
      this.programId,
    );
  }

  getEscrowInfo(ticketId: number): EscrowInfo {
    const [pda] = this.getEscrowPda(ticketId);
    return {
      address: pda.toBase58(),
      lamports: this.chainConfig?.escrowLamports ?? cache.config.solana_escrow_lamports,
    };
  }

  // ── Escrow lifecycle ────────────────────────────────────────────────────────

  async awaitPayment(ticketId: number, timeoutMs = 300_000): Promise<boolean> {
    if (!this.connection) throw new Error('SolanaService not initialised');
    const [escrowPda] = this.getEscrowPda(ticketId);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await this.connection.getAccountInfo(escrowPda);
      if (info && info.lamports > 0) return true;
      await delay(5000);
    }
    return false;
  }

  async releaseEscrow(ticketId: number): Promise<string> {
    if (!this.connection || !this.wallet || !this.programId) {
      throw new Error('SolanaService not initialised');
    }

    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], this.programId);
    const [escrowPda] = this.getEscrowPda(ticketId);
    const provider = this.wallet.publicKey;

    const ix = buildReleaseInstruction(
      this.programId,
      configPda,
      escrowPda,
      provider,
      this.wallet.publicKey,
      ticketId,
    );

    const tx = new Transaction().add(ix);
    await simulateTransaction(this.connection, tx, this.wallet.publicKey);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
    log.info(`SolanaService: released escrow for ticket #${ticketId} — tx ${sig}`);
    return sig;
  }

  async refundEscrow(ticketId: number, customerPubkey: string): Promise<string> {
    if (!this.connection || !this.wallet || !this.programId) {
      throw new Error('SolanaService not initialised');
    }

    // Validate the customer pubkey before building the transaction
    const customer = parsePublicKey(customerPubkey);

    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], this.programId);
    const [escrowPda] = this.getEscrowPda(ticketId);

    const ix = buildRefundInstruction(
      this.programId,
      configPda,
      escrowPda,
      customer,
      this.wallet.publicKey,
      ticketId,
    );

    const tx = new Transaction().add(ix);
    await simulateTransaction(this.connection, tx, this.wallet.publicKey);
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
    log.info(`SolanaService: refunded escrow for ticket #${ticketId} — tx ${sig}`);
    return sig;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private localFallbackConfig(): OnChainConfig {
    return {
      llmModel: cache.config.llm_model,
      llmKnowledge: cache.config.llm_knowledge,
      slaMinutes: cache.config.solana_sla_minutes,
      escrowLamports: cache.config.solana_escrow_lamports,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parsePublicKey(raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`SolanaService: invalid public key: ${raw}`);
  }
}

/**
 * Simulate a transaction and throw if the simulation reports an error.
 * This catches on-chain errors (wrong status, wrong authority, etc.)
 * before spending real SOL on a fee.
 */
async function simulateTransaction(
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey,
): Promise<void> {
  tx.feePayer = feePayer;
  // Recent blockhash is required for simulation even though we set it again before submit
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const result = await connection.simulateTransaction(tx);
  if (result.value.err) {
    throw new Error(
      `SolanaService: transaction simulation failed: ${JSON.stringify(result.value.err)}`,
    );
  }
}

function ticketIdBuffer(ticketId: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(ticketId));
  return buf;
}

function buildReleaseInstruction(
  programId: PublicKey,
  configPda: PublicKey,
  escrowPda: PublicKey,
  provider: PublicKey,
  authority: PublicKey,
  ticketId: number,
) {
  const { TransactionInstruction } = require('@solana/web3.js');
  const discriminator = anchorDiscriminator('global:release_escrow');
  const data = Buffer.concat([discriminator, ticketIdBuffer(ticketId)]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: provider, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildRefundInstruction(
  programId: PublicKey,
  configPda: PublicKey,
  escrowPda: PublicKey,
  customer: PublicKey,
  authority: PublicKey,
  ticketId: number,
) {
  const { TransactionInstruction } = require('@solana/web3.js');
  const discriminator = anchorDiscriminator('global:refund_escrow');
  const data = Buffer.concat([discriminator, ticketIdBuffer(ticketId)]);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: customer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function anchorDiscriminator(name: string): Buffer {
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(name).digest().slice(0, 8);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default SolanaService;
export { OnChainConfig, EscrowInfo } from './types';
