use anchor_lang::prelude::*;
use crate::state::{ConfigAccount, EscrowAccount, EscrowStatus};
use crate::error::EscrowError;

#[derive(Accounts)]
#[instruction(ticket_id: u64)]
pub struct RefundEscrow<'info> {
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

    /// CHECK: customer receives the refund
    #[account(mut, address = escrow.customer)]
    pub customer: AccountInfo<'info>,

    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn refund_escrow(ctx: Context<RefundEscrow>, ticket_id: u64) -> Result<()> {
    let config = &ctx.accounts.config;
    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.status == EscrowStatus::Active, EscrowError::InvalidStatus);
    require!(escrow.ticket_id == ticket_id, EscrowError::TicketMismatch);

    // Enforce SLA: only refundable after sla_minutes have elapsed
    let clock = Clock::get()?;
    let sla_seconds = (config.sla_minutes as i64) * 60;
    require!(
        clock.unix_timestamp >= escrow.created_at + sla_seconds,
        EscrowError::SlaNotExpired
    );

    let amount = escrow.lamports_locked;
    escrow.status = EscrowStatus::Refunded;

    **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
    **ctx.accounts.customer.try_borrow_mut_lamports()? += amount;

    Ok(())
}
