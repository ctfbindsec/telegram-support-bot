use anchor_lang::prelude::*;

#[account]
pub struct ConfigAccount {
    pub authority: Pubkey,
    pub llm_model: String,
    pub llm_knowledge: String,
    pub sla_minutes: u32,
    pub escrow_lamports: u64,
    pub bump: u8,
}

impl ConfigAccount {
    // discriminator (8) + pubkey (32) + 4+len (llm_model) + 4+len (llm_knowledge)
    // + u32 (4) + u64 (8) + u8 (1)
    pub fn space(llm_model_len: usize, llm_knowledge_len: usize) -> usize {
        8 + 32 + (4 + llm_model_len) + (4 + llm_knowledge_len) + 4 + 8 + 1
    }
}

#[account]
pub struct EscrowAccount {
    pub customer: Pubkey,
    pub ticket_id: u64,
    pub lamports_locked: u64,
    pub status: EscrowStatus,
    pub created_at: i64,
    pub bump: u8,
}

impl EscrowAccount {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum EscrowStatus {
    Pending,
    Active,
    Released,
    Refunded,
}
