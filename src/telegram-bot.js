/**
 * Telegram Bot for TCG Price Alerts
 * Commands: /start, /alert, /search, /list, /remove, /history, /upgrade, /help
 */

import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from './logger.js';
import { registerNotifier } from './price-checker.js';
import {
    getOrCreateUser,
    canCreateAlert,
    createAlert,
    getUserAlerts,
    removeAlert,
    getAlert,
    getPriceHistory,
    getStats,
} from './db.js';
import { searchCard, SUPPORTED_GAMES } from './tcgplayer.js';

const log = createLogger('telegram');

let bot = null;

/**
 * Format price for display
 */
function fmtPrice(price) {
    if (price === null || price === undefined) return 'N/A';
    return `$${Number(price).toFixed(2)}`;
}

/**
 * Parse the /alert command arguments
 * Supports formats:
 *   /alert charizard 50
 *   /alert pokemon charizard vmax 25.00
 *   /alert mtg black lotus 5000
 */
function parseAlertArgs(text) {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) return null;

    const gameKeys = SUPPORTED_GAMES.map(g => g.key);

    let game = 'any';
    let startIdx = 0;

    // Check if first word is a game name
    if (gameKeys.includes(parts[0].toLowerCase())) {
        game = parts[0].toLowerCase();
        startIdx = 1;
    }

    // Last element should be the price
    const priceStr = parts[parts.length - 1];
    const targetPrice = parseFloat(priceStr.replace(/[$,]/g, ''));
    if (isNaN(targetPrice) || targetPrice <= 0) return null;

    // Everything between game and price is the card name
    const cardName = parts.slice(startIdx, parts.length - 1).join(' ');
    if (!cardName) return null;

    return { cardName, game, targetPrice };
}

/**
 * Initialize and start the Telegram bot
 */
export async function startTelegramBot() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        log.warn('TELEGRAM_BOT_TOKEN not set, skipping Telegram bot');
        return null;
    }

    bot = new TelegramBot(token, { polling: true });
    log.info('Telegram bot starting...');

    // ─── /start ─────────────────────────────────────────────────
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const user = getOrCreateUser('telegram', String(chatId), msg.from?.username ?? msg.from?.first_name);

        const welcome = [
            `Welcome to TCG Price Alert Bot!`,
            ``,
            `I track card prices on TCGPlayer for Pokemon, MTG, Yu-Gi-Oh!, and Lorcana.`,
            ``,
            `Set a price alert and I'll notify you when a card drops below your target price.`,
            ``,
            `**Commands:**`,
            `/alert [game] [card name] [price] - Set a price alert`,
            `/search [game] [card name] - Search for a card`,
            `/list - View your active alerts`,
            `/remove [id] - Remove an alert`,
            `/history [id] - View price history for an alert`,
            `/help - Show this help message`,
            ``,
            `**Games:** pokemon, mtg, yugioh, lorcana (or omit for all)`,
            ``,
            `**Examples:**`,
            `/alert pokemon charizard vmax 50`,
            `/alert mtg black lotus 5000`,
            `/search yugioh blue-eyes white dragon`,
            ``,
            `**Free tier:** ${3} active alerts`,
            `**Paid tier ($5/mo):** Unlimited alerts + price history`,
            ``,
            `Your tier: ${user.tier.toUpperCase()}`,
        ].join('\n');

        await bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    });

    // ─── /help ──────────────────────────────────────────────────
    bot.onText(/\/help/, async (msg) => {
        const chatId = msg.chat.id;
        const help = [
            `**TCG Price Alert Bot - Commands**`,
            ``,
            `/alert [game] [card name] [price]`,
            `  Set a price alert. I'll notify you when the card drops below your target.`,
            `  Games: pokemon, mtg, yugioh, lorcana (optional, defaults to all)`,
            `  Example: /alert pokemon pikachu vmax 15`,
            ``,
            `/search [game] [card name]`,
            `  Search TCGPlayer for a card and see current prices.`,
            `  Example: /search mtg lightning bolt`,
            ``,
            `/list`,
            `  View all your active price alerts.`,
            ``,
            `/remove [id]`,
            `  Remove an alert by its ID (shown in /list).`,
            ``,
            `/history [id]`,
            `  View price check history for an alert (paid tier).`,
            ``,
            `/upgrade`,
            `  Info about upgrading to paid tier.`,
            ``,
            `/stats`,
            `  View bot statistics.`,
        ].join('\n');

        await bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
    });

    // ─── /search ────────────────────────────────────────────────
    bot.onText(/\/search\s+(.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const args = match[1].trim().split(/\s+/);

        const gameKeys = SUPPORTED_GAMES.map(g => g.key);
        let game = 'any';
        let startIdx = 0;

        if (gameKeys.includes(args[0]?.toLowerCase())) {
            game = args[0].toLowerCase();
            startIdx = 1;
        }

        const cardName = args.slice(startIdx).join(' ');
        if (!cardName) {
            await bot.sendMessage(chatId, 'Usage: /search [game] [card name]\nExample: /search pokemon charizard');
            return;
        }

        await bot.sendMessage(chatId, `Searching TCGPlayer for "${cardName}"...`);

        const results = await searchCard(cardName, game, 5);
        if (results.length === 0) {
            await bot.sendMessage(chatId, `No results found for "${cardName}". Try a different search term.`);
            return;
        }

        const lines = results.map((card, i) => {
            return [
                `**${i + 1}. ${card.name}**`,
                `   Game: ${card.game} | Set: ${card.setName ?? 'N/A'}`,
                `   Market: ${fmtPrice(card.marketPrice)} | Low: ${fmtPrice(card.lowestPrice)}`,
                `   Listings: ${card.totalListings} | [View](${card.url})`,
            ].join('\n');
        });

        const response = [`**Search Results for "${cardName}"**`, '', ...lines].join('\n');
        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    // ─── /alert ─────────────────────────────────────────────────
    bot.onText(/\/alert\s+(.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = getOrCreateUser('telegram', String(chatId), msg.from?.username ?? msg.from?.first_name);

        const parsed = parseAlertArgs(match[1]);
        if (!parsed) {
            await bot.sendMessage(chatId,
                'Usage: /alert [game] [card name] [target price]\n' +
                'Example: /alert pokemon charizard vmax 50\n' +
                'Example: /alert mtg black lotus 5000\n\n' +
                'Games: pokemon, mtg, yugioh, lorcana (optional)',
            );
            return;
        }

        // Check alert limit
        const { allowed, count, limit } = canCreateAlert(user.id, user.tier);
        if (!allowed) {
            await bot.sendMessage(chatId,
                `You've reached the free tier limit of ${limit} active alerts (current: ${count}).\n` +
                `Remove an existing alert with /remove [id] or /upgrade for unlimited alerts.`,
            );
            return;
        }

        await bot.sendMessage(chatId, `Searching for "${parsed.cardName}"...`);

        // Look up the card on TCGPlayer
        const results = await searchCard(parsed.cardName, parsed.game, 1);
        const card = results[0] ?? null;

        const alert = createAlert(user.id, {
            cardName: parsed.cardName,
            game: parsed.game,
            targetPrice: parsed.targetPrice,
            productId: card?.productId ?? null,
            productUrl: card?.url ?? null,
            imageUrl: card?.imageUrl ?? null,
            setName: card?.setName ?? null,
            currentPrice: card?.marketPrice ?? null,
        });

        const currentPriceStr = card?.marketPrice ? fmtPrice(card.marketPrice) : 'unknown';
        const status = card?.marketPrice && card.marketPrice <= parsed.targetPrice
            ? 'Currently BELOW your target!'
            : `Currently ${currentPriceStr}`;

        const response = [
            `Alert #${alert.id} created!`,
            ``,
            `Card: ${parsed.cardName}`,
            `Game: ${parsed.game === 'any' ? 'All' : parsed.game}`,
            `Target Price: ${fmtPrice(parsed.targetPrice)}`,
            `Current Price: ${currentPriceStr}`,
            `Status: ${status}`,
            card?.url ? `\n[View on TCGPlayer](${card.url})` : '',
            ``,
            `I'll check prices every 30 minutes and notify you when it drops below ${fmtPrice(parsed.targetPrice)}.`,
        ].join('\n');

        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    // ─── /list ──────────────────────────────────────────────────
    bot.onText(/\/list/, async (msg) => {
        const chatId = msg.chat.id;
        const user = getOrCreateUser('telegram', String(chatId), msg.from?.username ?? msg.from?.first_name);

        const alerts = getUserAlerts(user.id);
        if (alerts.length === 0) {
            await bot.sendMessage(chatId, 'You have no active alerts. Create one with /alert [game] [card name] [price]');
            return;
        }

        const lines = alerts.map((a) => {
            const gameLabel = a.game === 'any' ? 'All' : a.game;
            const priceInfo = a.current_price ? fmtPrice(a.current_price) : 'checking...';
            const triggerIcon = a.triggered ? ' [TRIGGERED]' : '';
            return `**#${a.id}** ${a.card_name} (${gameLabel})\n   Target: ${fmtPrice(a.target_price)} | Current: ${priceInfo}${triggerIcon}`;
        });

        const { count, limit } = canCreateAlert(user.id, user.tier);
        const tierInfo = user.tier === 'free'
            ? `\nAlerts: ${alerts.length}/${limit} (free tier)`
            : `\nAlerts: ${alerts.length} (paid tier - unlimited)`;

        const response = [`**Your Active Alerts**`, '', ...lines, tierInfo].join('\n');
        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    });

    // ─── /remove ────────────────────────────────────────────────
    bot.onText(/\/remove\s+(\d+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = getOrCreateUser('telegram', String(chatId), msg.from?.username ?? msg.from?.first_name);

        const alertId = parseInt(match[1], 10);
        const alert = getAlert(alertId, user.id);

        if (!alert) {
            await bot.sendMessage(chatId, `Alert #${alertId} not found. Use /list to see your alerts.`);
            return;
        }

        removeAlert(alertId, user.id);
        await bot.sendMessage(chatId, `Alert #${alertId} ("${alert.card_name}") has been removed.`);
    });

    // ─── /history ───────────────────────────────────────────────
    bot.onText(/\/history\s+(\d+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const user = getOrCreateUser('telegram', String(chatId), msg.from?.username ?? msg.from?.first_name);

        if (user.tier !== 'paid') {
            await bot.sendMessage(chatId, 'Price history is available for paid tier users. Use /upgrade for details.');
            return;
        }

        const alertId = parseInt(match[1], 10);
        const alert = getAlert(alertId, user.id);

        if (!alert) {
            await bot.sendMessage(chatId, `Alert #${alertId} not found.`);
            return;
        }

        const history = getPriceHistory(alertId, 20);
        if (history.length === 0) {
            await bot.sendMessage(chatId, `No price history yet for alert #${alertId}. Prices are checked every 30 minutes.`);
            return;
        }

        const lines = history.map(h => {
            const date = h.checked_at.replace('T', ' ').slice(0, 16);
            return `${date} - Market: ${fmtPrice(h.market_price)} | Low: ${fmtPrice(h.lowest_price)}`;
        });

        const response = [
            `**Price History: ${alert.card_name}**`,
            `Target: ${fmtPrice(alert.target_price)}`,
            '',
            ...lines,
        ].join('\n');

        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    });

    // ─── /upgrade ───────────────────────────────────────────────
    bot.onText(/\/upgrade/, async (msg) => {
        const chatId = msg.chat.id;
        const user = getOrCreateUser('telegram', String(chatId), msg.from?.username ?? msg.from?.first_name);

        if (user.tier === 'paid') {
            await bot.sendMessage(chatId, 'You are already on the paid tier! Enjoy unlimited alerts and price history.');
            return;
        }

        const upgradeMsg = [
            `**Upgrade to Paid Tier - $5/month**`,
            ``,
            `Free tier:`,
            `  - 3 active alerts`,
            `  - Price notifications`,
            ``,
            `Paid tier ($5/mo):`,
            `  - Unlimited active alerts`,
            `  - Full price history`,
            `  - Priority price checks`,
            ``,
            `Payment integration coming soon! For now, contact @lulzasaur to upgrade.`,
        ].join('\n');

        await bot.sendMessage(chatId, upgradeMsg, { parse_mode: 'Markdown' });
    });

    // ─── /stats ─────────────────────────────────────────────────
    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const stats = getStats();
        const response = [
            `**Bot Statistics**`,
            `Users: ${stats.totalUsers}`,
            `Active Alerts: ${stats.activeAlerts}`,
            `Triggered Alerts: ${stats.triggeredAlerts}`,
            `Total Price Checks: ${stats.totalPriceChecks}`,
        ].join('\n');

        await bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    });

    // ─── Register notifier ─────────────────────────────────────
    registerNotifier(async (alert, card, currentPrice) => {
        if (alert.platform !== 'telegram') return;

        const message = [
            `PRICE ALERT!`,
            ``,
            `**${alert.card_name}** has dropped to ${fmtPrice(currentPrice)}!`,
            `Your target: ${fmtPrice(alert.target_price)}`,
            ``,
            `Game: ${alert.game === 'any' ? 'All' : alert.game}`,
            card?.setName ? `Set: ${card.setName}` : '',
            `Market Price: ${fmtPrice(card?.marketPrice)}`,
            `Lowest Price: ${fmtPrice(card?.lowestPrice)}`,
            `Listings: ${card?.totalListings ?? 'N/A'}`,
            card?.url ? `\n[Buy on TCGPlayer](${card.url})` : '',
            ``,
            `Alert #${alert.id} | Use /remove ${alert.id} to stop this alert.`,
        ].filter(Boolean).join('\n');

        try {
            await bot.sendMessage(alert.platform_user_id, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            });
            log.info(`Telegram notification sent to ${alert.platform_user_id} for alert #${alert.id}`);
        } catch (err) {
            log.error(`Failed to send Telegram notification: ${err.message}`);
        }
    });

    // Handle polling errors gracefully
    bot.on('polling_error', (err) => {
        log.error(`Telegram polling error: ${err.message}`);
    });

    log.info('Telegram bot started');
    return bot;
}

export function stopTelegramBot() {
    if (bot) {
        bot.stopPolling();
        log.info('Telegram bot stopped');
    }
}
