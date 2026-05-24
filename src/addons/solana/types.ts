export interface OnChainConfig {
  llmModel: string;
  llmKnowledge: string;
  slaMinutes: number;
  escrowLamports: number;
}

export interface EscrowInfo {
  /** Base58 address of the escrow PDA */
  address: string;
  /** Required deposit in lamports */
  lamports: number;
}
