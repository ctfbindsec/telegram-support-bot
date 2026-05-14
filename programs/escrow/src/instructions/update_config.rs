use anchor_lang::prelude::*;
use crate::state::ConfigAccount;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ConfigAccount>,

    pub authority: Signer<'info>,
}

pub fn update_config(
    ctx: Context<UpdateConfig>,
    llm_model: Option<String>,
    llm_knowledge: Option<String>,
    sla_minutes: Option<u32>,
    escrow_lamports: Option<u64>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    if let Some(model) = llm_model {
        config.llm_model = model;
    }
    if let Some(knowledge) = llm_knowledge {
        config.llm_knowledge = knowledge;
    }
    if let Some(sla) = sla_minutes {
        config.sla_minutes = sla;
    }
    if let Some(lamports) = escrow_lamports {
        config.escrow_lamports = lamports;
    }
    Ok(())
}
