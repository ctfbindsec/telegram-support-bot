use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Escrow is not in the expected status for this operation")]
    InvalidStatus,
    #[msg("Ticket ID does not match the escrow account")]
    TicketMismatch,
    #[msg("SLA period has not yet expired; refund not available")]
    SlaNotExpired,
}
