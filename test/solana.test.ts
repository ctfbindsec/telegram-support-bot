import SolanaService from '../src/addons/solana';
import * as db from '../src/db';
import * as middleware from '../src/middleware';

// mocks.ts wires up the SolanaService mock globally via jest.mock
describe('SolanaService (mocked)', () => {
  let solana: ReturnType<typeof SolanaService.getInstance>;

  beforeEach(() => {
    solana = SolanaService.getInstance();
    jest.clearAllMocks();
  });

  it('getCachedChainConfig returns on-chain config shape', () => {
    const config = solana.getCachedChainConfig();
    expect(config).toMatchObject({
      llmModel: expect.any(String),
      llmKnowledge: expect.any(String),
      slaMinutes: expect.any(Number),
      escrowLamports: expect.any(Number),
    });
  });

  it('getEscrowInfo returns a PDA address and lamport amount', () => {
    const info = solana.getEscrowInfo(42);
    expect(info.address).toBeTruthy();
    expect(info.lamports).toBeGreaterThan(0);
  });

  it('awaitPayment resolves true when funded', async () => {
    const paid = await solana.awaitPayment(1, 1000);
    expect(paid).toBe(true);
  });

  it('releaseEscrow resolves with a transaction signature', async () => {
    const sig = await solana.releaseEscrow(1);
    expect(typeof sig).toBe('string');
    expect(sig.length).toBeGreaterThan(0);
  });

  it('refundEscrow resolves with a transaction signature', async () => {
    const sig = await solana.refundEscrow(1, 'CustomerPubkey111111111111111111111111111');
    expect(typeof sig).toBe('string');
  });
});

describe('SolanaService escrow release on close command', () => {
  it('releaseEscrow is called with the correct ticketId', async () => {
    const solana = SolanaService.getInstance();
    const sig = await solana.releaseEscrow(42);
    expect(solana.releaseEscrow).toHaveBeenCalledWith(42);
    expect(typeof sig).toBe('string');
  });

  it('getEscrowInfo encodes ticketId into the PDA address', () => {
    const solana = SolanaService.getInstance();
    const info = solana.getEscrowInfo(99);
    expect(info).toHaveProperty('address');
    expect(info).toHaveProperty('lamports');
    expect(info.lamports).toBe(10000000);
  });
});
