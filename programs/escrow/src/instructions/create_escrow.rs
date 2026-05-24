use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{ConfigAccount, EscrowAccount, EscrowStatus};

#[derive(Accounts)]
#[instruction(ticket_id: u64)]
pub struct CreateEscrow<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(
        init,
        payer = customer,
        space = EscrowAccount::SPACE,
        seeds = [b"escrow", &ticket_id.to_le_bytes()],
        bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    #[account(mut)]
    pub customer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_escrow(ctx: Context<CreateEscrow>, ticket_id: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    escrow.customer = ctx.accounts.customer.key();
    escrow.ticket_id = ticket_id;
    escrow.lamports_locked = config.escrow_lamports;
    escrow.status = EscrowStatus::Active;
    escrow.created_at = clock.unix_timestamp;
    escrow.bump = ctx.bumps.escrow;

    // Transfer SOL from customer to escrow PDA
    let transfer_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.customer.to_account_info(),
            to: escrow.to_account_info(),
        },
    );
    system_program::transfer(transfer_ctx, config.escrow_lamports)?;

    Ok(())
}
