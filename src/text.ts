import * as db from './db';
import cache from './cache';
import * as staff from './staff';
import * as users from './users';
import * as middleware from './middleware';
import { Addon, Context } from './interfaces';
import { ISupportee } from './db';
import SolanaService from './addons/solana';
import * as log from 'fancy-log';

/**
 * Checks if the given message text exists in the configured categories.
 *
 * @param message - The text of the incoming message.
 * @returns True if the message is one of the categories, false otherwise.
 */
const isMessageInCategories = (message: string): boolean => {
  const { categories } = cache.config;
  return Array.isArray(categories) && categories.length > 0 &&
    categories.some(category => category.msg.includes(message));
};

/**
 * Determines if a category keyboard should be shown.
 *
 * @param ctx - The message context.
 * @returns True if the keyboard should be shown, false otherwise.
 */
const shouldReplyWithCategoryKeyboard = (ctx: Context): boolean => {
  const { categories } = cache.config;
  return Array.isArray(categories) &&
    categories.length > 0 &&
    !isMessageInCategories(ctx.message.text) &&
    !ctx.session.admin &&
    !ctx.session.group;
};

/**
 * Handles incoming text messages.
 *
 * @param bot - Instance of the Telegram addon.
 * @param ctx - The context of the message.
 * @param keys - Keyboard keys to use for replies.
 */
export function handleText(bot: Addon, ctx: Context, keys: any[] = []) {
  // Handle private replies via staff
  if (ctx.session.mode === 'private_reply') {
    return staff.privateReply(ctx);
  }

  // If conditions met, reply with the category keyboard
  if (shouldReplyWithCategoryKeyboard(ctx)) {
    return middleware.reply(ctx, cache.config.language.services, {
      reply_markup: { keyboard: keys },
    });
  }

  // In all other cases, process the ticket
  return ticketHandler(bot, ctx);
}

/**
 * Determines whether to forward the message or to handle it as a ticket.
 *
 * @param bot - Instance of the Telegram addon.
 * @param ctx - The context of the message.
 */
export async function ticketHandler(bot: Addon, ctx: Context): Promise<ISupportee | null> {
  const { chat, message, session, messenger } = ctx;
  // For private chats, check for an existing ticket; otherwise, create one.
  if (chat.type === 'private') {
    const ticket = await db.getTicketByUserId(message.from.id, session.groupCategory)
    if (!ticket) {
      await db.add(message.from.id, 'open', session.groupCategory, messenger);

      // When Solana escrow is enabled, prompt the user to fund the escrow
      // before forwarding their first message to staff.
      if (cache.config.solana_enabled) {
        await initiateEscrow(ctx, message.from.id, session.groupCategory, messenger);
        return null;
      }
    }
    users.chat(ctx, message.chat);
    return ticket;
  }

  // For non-private chats, use the staff chat handler.
  staff.chat(ctx);
}

/**
 * Sends escrow payment instructions to the user and, once payment is
 * confirmed on-chain, stores the escrow address and forwards the ticket.
 */
async function initiateEscrow(
  ctx: Context,
  userId: string,
  category: string | null,
  messenger: string,
): Promise<void> {
  try {
    const solana = SolanaService.getInstance();
    const newTicket = await db.getTicketByUserId(userId, category);
    if (!newTicket) return;

    const ticketId = newTicket.ticketId;
    const escrowInfo = solana.getEscrowInfo(ticketId);
    const solAmount = (escrowInfo.lamports / 1e9).toFixed(4);

    middleware.reply(
      ctx,
      `To open ticket #T${String(ticketId).padStart(6, '0')}, please send exactly ` +
      `${solAmount} SOL to:\n\n` +
      `\`${escrowInfo.address}\`\n\n` +
      `Your message will be forwarded to staff once payment is confirmed on-chain ` +
      `(usually within 30 seconds).`,
    );

    // Await payment in the background — do not block the handler.
    solana.awaitPayment(ticketId, 300_000).then(async (paid) => {
      if (!paid) {
        middleware.reply(ctx, 'Escrow payment not received within 5 minutes. Please try again.');
        return;
      }
      await db.setEscrow(ticketId, escrowInfo.address, '');
      // Now forward the user's first message to staff via the normal path.
      users.chat(ctx, ctx.message.chat);
    }).catch((err) => {
      log.error('SolanaService: awaitPayment error:', err);
    });
  } catch (err) {
    log.error('SolanaService: initiateEscrow error:', err);
    // On any Solana error, fall through to normal ticket flow so support isn't broken.
    users.chat(ctx, ctx.message.chat);
  }
}
