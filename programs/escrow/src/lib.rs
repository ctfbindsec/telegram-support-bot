use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod escrow {
    use super::*;

    /// One-time admin setup: initialise the on-chain config account.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        llm_model: String,
        llm_knowledge: String,
        sla_minutes: u32,
        escrow_lamports: u64,
    ) -> Result<()> {
        instructions::initialize_config(ctx, llm_model, llm_knowledge, sla_minutes, escrow_lamports)
    }

    /// Admin: update AI parameters and escrow settings on-chain.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        llm_model: Option<String>,
        llm_knowledge: Option<String>,
        sla_minutes: Option<u32>,
        escrow_lamports: Option<u64>,
    ) -> Result<()> {
        instructions::update_config(ctx, llm_model, llm_knowledge, sla_minutes, escrow_lamports)
    }

    /// Customer: lock SOL in escrow when opening a support ticket.
    pub fn create_escrow(ctx: Context<CreateEscrow>, ticket_id: u64) -> Result<()> {
        instructions::create_escrow(ctx, ticket_id)
    }

    /// Bot authority: release locked funds to the service provider on ticket resolution.
    pub fn release_escrow(ctx: Context<ReleaseEscrow>, ticket_id: u64) -> Result<()> {
        instructions::release_escrow(ctx, ticket_id)
    }

    /// Bot authority: refund customer after SLA expires without resolution.
    pub fn refund_escrow(ctx: Context<RefundEscrow>, ticket_id: u64) -> Result<()> {
        instructions::refund_escrow(ctx, ticket_id)
    }
}
