use anchor_lang::prelude::*;
use crate::state::{ConfigAccount, EscrowAccount, EscrowStatus};
use crate::error::EscrowError;

#[derive(Accounts)]
#[instruction(ticket_id: u64)]
pub struct ReleaseEscrow<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority,
    )]
    pub config: Account<'info, ConfigAccount>,

    #[account(
        mut,
        seeds = [b"escrow", &ticket_id.to_le_bytes()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, EscrowAccount>,

    /// CHECK: provider receives the released funds
    #[account(mut)]
    pub provider: AccountInfo<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn release_escrow(ctx: Context<ReleaseEscrow>, ticket_id: u64) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.status == EscrowStatus::Active, EscrowError::InvalidStatus);
    require!(escrow.ticket_id == ticket_id, EscrowError::TicketMismatch);

    let amount = escrow.lamports_locked;
    escrow.status = EscrowStatus::Released;

    // Transfer lamports out of the escrow PDA to the provider
    **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.provider.try_borrow_mut_lamports()? += amount;

    Ok(())
}
