import fs from 'fs';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as log from 'fancy-log';
import cache from '../../cache';
import { OnChainConfig, EscrowInfo } from './types';

// Seeds mirror the Anchor program constants
const CONFIG_SEED = Buffer.from('config');
const ESCROW_SEED = Buffer.from('escrow');

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

    const keypairData = JSON.parse(fs.readFileSync(solana_wallet_keypair_path, 'utf8'));
    this.wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));

    log.info(`SolanaService: connected to ${solana_rpc_url}`);
    log.info(`SolanaService: program ${solana_program_id}`);
    log.info(`SolanaService: authority ${this.wallet.publicKey.toBase58()}`);

    this.chainConfig = await this.readChainConfig();
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

  /**
   * Poll until the escrow PDA account is funded (or timeout).
   * Returns true when funded, false on timeout.
   */
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

  /**
   * Build and send a release_escrow instruction signed by the bot authority.
   * Funds are transferred to the authority wallet (service provider).
   * Returns the transaction signature.
   */
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
    const sig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
    log.info(`SolanaService: released escrow for ticket #${ticketId} — tx ${sig}`);
    return sig;
  }

  /**
   * Build and send a refund_escrow instruction (SLA breach / no resolution).
   * Funds are returned to the original customer account stored in the PDA.
   */
  async refundEscrow(ticketId: number, customerPubkey: string): Promise<string> {
    if (!this.connection || !this.wallet || !this.programId) {
      throw new Error('SolanaService not initialised');
    }

    const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], this.programId);
    const [escrowPda] = this.getEscrowPda(ticketId);
    const customer = new PublicKey(customerPubkey);

    const ix = buildRefundInstruction(
      this.programId,
      configPda,
      escrowPda,
      customer,
      this.wallet.publicKey,
      ticketId,
    );

    const tx = new Transaction().add(ix);
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

// ── Instruction builders (raw, no IDL dependency) ────────────────────────────

function ticketIdBuffer(ticketId: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(ticketId));
  return buf;
}

/**
 * Encode the `release_escrow` discriminator + ticket_id argument.
 * Anchor discriminator = sha256("global:release_escrow")[0..8]
 */
function buildReleaseInstruction(
  programId: PublicKey,
  configPda: PublicKey,
  escrowPda: PublicKey,
  provider: PublicKey,
  authority: PublicKey,
  ticketId: number,
) {
  const { TransactionInstruction, AccountMeta } = require('@solana/web3.js');
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
