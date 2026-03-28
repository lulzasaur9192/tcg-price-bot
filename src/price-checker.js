/**
 * Price Checker Engine
 * Runs on a cron schedule, checks all active alerts against TCGPlayer prices,
 * and fires notifications when prices drop below thresholds.
 */

import { CronJob } from 'cron';
import { createLogger } from './logger.js';
import {
    getAllActiveAlerts,
    recordPriceCheck,
    triggerAlert,
    updateAlertPrice,
    resetTriggered,
    getStats,
} from './db.js';
import { batchCheckPrices } from './tcgplayer.js';

const log = createLogger('price-checker');

// Notification callbacks registered by bot modules
const notifiers = [];

/**
 * Register a notification callback
 * @param {Function} fn - async function(alert, card, currentPrice)
 */
export function registerNotifier(fn) {
    notifiers.push(fn);
    log.info(`Notifier registered (total: ${notifiers.length})`);
}

/**
 * Send notifications through all registered notifiers
 */
async function notify(alert, card, currentPrice) {
    for (const fn of notifiers) {
        try {
            await fn(alert, card, currentPrice);
        } catch (err) {
            log.error(`Notifier failed: ${err.message}`);
        }
    }
}

/**
 * Run a single price check cycle
 */
export async function runPriceCheck() {
    const startTime = Date.now();
    log.info('Starting price check cycle...');

    const alerts = getAllActiveAlerts();
    if (alerts.length === 0) {
        log.info('No active alerts to check');
        return { checked: 0, triggered: 0, errors: 0 };
    }

    log.info(`Checking prices for ${alerts.length} active alerts`);

    let triggered = 0;
    let errors = 0;

    try {
        const results = await batchCheckPrices(alerts);

        for (const { alert, card, currentPrice } of results) {
            if (!card || currentPrice === null) {
                log.warn(`No price found for alert #${alert.id} ("${alert.card_name}")`);
                errors++;
                continue;
            }

            // Record price check in history
            recordPriceCheck(alert.id, currentPrice, card.marketPrice, card.lowestPrice);

            // Update alert with latest price data
            updateAlertPrice(alert.id, {
                currentPrice,
                productId: card.productId,
                productUrl: card.url,
                imageUrl: card.imageUrl,
                setName: card.setName,
            });

            // Check if price has dropped below target
            if (currentPrice <= alert.target_price) {
                if (!alert.triggered) {
                    // Price just dropped below target -- fire notification
                    log.info(`TRIGGERED: Alert #${alert.id} "${alert.card_name}" $${currentPrice} <= $${alert.target_price}`);
                    triggerAlert(alert.id, currentPrice);
                    triggered++;

                    await notify(alert, card, currentPrice);
                } else {
                    log.debug(`Alert #${alert.id} already triggered, skipping notification`);
                }
            } else if (alert.triggered) {
                // Price went back up above target -- reset trigger so it can fire again
                log.info(`RESET: Alert #${alert.id} "${alert.card_name}" price back up to $${currentPrice}`);
                resetTriggered(alert.id);
            }
        }
    } catch (err) {
        log.error(`Price check cycle failed: ${err.message}`);
        errors++;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log.info(`Price check complete in ${elapsed}s: ${alerts.length} checked, ${triggered} triggered, ${errors} errors`);

    return { checked: alerts.length, triggered, errors };
}

/**
 * Start the price checker cron job
 */
export function startPriceChecker() {
    const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES ?? '30', 10);

    // Run every N minutes
    const cronExpression = `*/${intervalMinutes} * * * *`;
    log.info(`Starting price checker cron: every ${intervalMinutes} minutes (${cronExpression})`);

    const job = new CronJob(cronExpression, async () => {
        try {
            await runPriceCheck();
        } catch (err) {
            log.error(`Cron job error: ${err.message}`);
        }
    });

    job.start();

    // Also run immediately on start
    log.info('Running initial price check...');
    runPriceCheck().catch(err => log.error(`Initial price check failed: ${err.message}`));

    return job;
}
