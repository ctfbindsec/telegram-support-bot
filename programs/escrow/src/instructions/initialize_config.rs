use anchor_lang::prelude::*;
use crate::state::ConfigAccount;

#[derive(Accounts)]
#[instruction(llm_model: String, llm_knowledge: String)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = ConfigAccount::space(llm_model.len(), llm_knowledge.len()),
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    llm_model: String,
    llm_knowledge: String,
    sla_minutes: u32,
    escrow_lamports: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.llm_model = llm_model;
    config.llm_knowledge = llm_knowledge;
    config.sla_minutes = sla_minutes;
    config.escrow_lamports = escrow_lamports;
    config.bump = ctx.bumps.config;
    Ok(())
}
