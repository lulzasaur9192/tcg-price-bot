/**
 * TCG Price Alert Bot - Main Entry Point
 *
 * Starts:
 * 1. Database (auto-initialized on import)
 * 2. Price checker cron job
 * 3. Telegram bot (if TELEGRAM_BOT_TOKEN is set)
 * 4. Discord bot (if DISCORD_BOT_TOKEN is set)
 */

import { createLogger } from './logger.js';
import { startPriceChecker } from './price-checker.js';
import { startTelegramBot, stopTelegramBot } from './telegram-bot.js';
import { startDiscordBot, stopDiscordBot } from './discord-bot.js';
import { getStats } from './db.js';

const log = createLogger('main');

async function main() {
    log.info('========================================');
    log.info('TCG Price Alert Bot starting...');
    log.info('========================================');

    const stats = getStats();
    log.info(`Database loaded: ${stats.totalUsers} users, ${stats.activeAlerts} active alerts`);

    const enableTelegram = process.env.ENABLE_TELEGRAM !== 'false';
    const enableDiscord = process.env.ENABLE_DISCORD !== 'false';

    // Start bots
    let telegramBot = null;
    let discordBot = null;

    if (enableTelegram) {
        try {
            telegramBot = await startTelegramBot();
        } catch (err) {
            log.error(`Failed to start Telegram bot: ${err.message}`);
        }
    } else {
        log.info('Telegram bot disabled (ENABLE_TELEGRAM=false)');
    }

    if (enableDiscord) {
        try {
            discordBot = await startDiscordBot();
        } catch (err) {
            log.error(`Failed to start Discord bot: ${err.message}`);
        }
    } else {
        log.info('Discord bot disabled (ENABLE_DISCORD=false)');
    }

    if (!telegramBot && !discordBot) {
        log.warn('No bot tokens configured. Set TELEGRAM_BOT_TOKEN and/or DISCORD_BOT_TOKEN.');
        log.warn('Starting price checker only (useful for testing).');
    }

    // Start price checker cron
    const priceJob = startPriceChecker();

    log.info('========================================');
    log.info('TCG Price Alert Bot is running!');
    log.info(`Telegram: ${telegramBot ? 'ACTIVE' : 'INACTIVE'}`);
    log.info(`Discord: ${discordBot ? 'ACTIVE' : 'INACTIVE'}`);
    log.info(`Price checks: every ${process.env.CHECK_INTERVAL_MINUTES ?? 30} minutes`);
    log.info('========================================');

    // Graceful shutdown
    const shutdown = async (signal) => {
        log.info(`${signal} received, shutting down...`);

        priceJob.stop();
        stopTelegramBot();
        stopDiscordBot();

        log.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Keep the process alive
    process.on('uncaughtException', (err) => {
        log.error(`Uncaught exception: ${err.message}`);
        log.error(err.stack);
    });

    process.on('unhandledRejection', (err) => {
        log.error(`Unhandled rejection: ${err.message ?? err}`);
    });
}

main().catch((err) => {
    log.error(`Fatal error: ${err.message}`);
    log.error(err.stack);
    process.exit(1);
});
