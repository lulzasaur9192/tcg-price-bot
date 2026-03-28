/**
 * SQLite database layer for TCG Price Bot
 * Tables: users, alerts, price_checks, subscriptions
 */

import Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const log = createLogger('db');

const DB_PATH = process.env.DATABASE_PATH ?? './data/tcg-bot.db';

// Ensure the data directory exists
try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
} catch { /* already exists */ }

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL CHECK(platform IN ('telegram', 'discord')),
        platform_user_id TEXT NOT NULL,
        username TEXT,
        tier TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free', 'paid')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(platform, platform_user_id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        card_name TEXT NOT NULL,
        game TEXT NOT NULL CHECK(game IN ('pokemon', 'mtg', 'yugioh', 'lorcana', 'any')),
        target_price REAL NOT NULL,
        current_price REAL,
        product_id INTEGER,
        product_url TEXT,
        image_url TEXT,
        set_name TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        triggered INTEGER NOT NULL DEFAULT 0,
        triggered_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        price REAL NOT NULL,
        market_price REAL,
        lowest_price REAL,
        checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tier TEXT NOT NULL DEFAULT 'paid',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'cancelled', 'expired')),
        payment_method TEXT,
        external_id TEXT,
        starts_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(active);
    CREATE INDEX IF NOT EXISTS idx_price_checks_alert_id ON price_checks(alert_id);
    CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform, platform_user_id);
`);

log.info(`Database initialized at ${DB_PATH}`);

// ─── User Operations ─────────────────────────────────────────────

const stmtUpsertUser = db.prepare(`
    INSERT INTO users (platform, platform_user_id, username)
    VALUES (@platform, @platformUserId, @username)
    ON CONFLICT(platform, platform_user_id)
    DO UPDATE SET username = @username, updated_at = datetime('now')
    RETURNING *
`);

const stmtGetUser = db.prepare(`
    SELECT * FROM users WHERE platform = ? AND platform_user_id = ?
`);

export function getOrCreateUser(platform, platformUserId, username) {
    return stmtUpsertUser.get({
        platform,
        platformUserId: String(platformUserId),
        username: username ?? null,
    });
}

export function getUser(platform, platformUserId) {
    return stmtGetUser.get(platform, String(platformUserId));
}

// ─── Alert Operations ─────────────────────────────────────────────

const FREE_ALERT_LIMIT = 3;

const stmtCountActiveAlerts = db.prepare(`
    SELECT COUNT(*) as count FROM alerts WHERE user_id = ? AND active = 1
`);

const stmtCreateAlert = db.prepare(`
    INSERT INTO alerts (user_id, card_name, game, target_price, product_id, product_url, image_url, set_name, current_price)
    VALUES (@userId, @cardName, @game, @targetPrice, @productId, @productUrl, @imageUrl, @setName, @currentPrice)
    RETURNING *
`);

const stmtGetUserAlerts = db.prepare(`
    SELECT * FROM alerts WHERE user_id = ? AND active = 1 ORDER BY created_at DESC
`);

const stmtGetAllActiveAlerts = db.prepare(`
    SELECT a.*, u.platform, u.platform_user_id, u.username, u.tier
    FROM alerts a
    JOIN users u ON a.user_id = u.id
    WHERE a.active = 1
    ORDER BY a.card_name
`);

const stmtGetAlert = db.prepare(`
    SELECT * FROM alerts WHERE id = ? AND user_id = ?
`);

const stmtDeactivateAlert = db.prepare(`
    UPDATE alerts SET active = 0, updated_at = datetime('now') WHERE id = ? AND user_id = ?
`);

const stmtTriggerAlert = db.prepare(`
    UPDATE alerts SET triggered = 1, triggered_at = datetime('now'), current_price = ?, updated_at = datetime('now')
    WHERE id = ?
`);

const stmtUpdateAlertPrice = db.prepare(`
    UPDATE alerts SET current_price = ?, product_id = ?, product_url = ?, image_url = ?, set_name = ?, updated_at = datetime('now')
    WHERE id = ?
`);

const stmtResetTriggered = db.prepare(`
    UPDATE alerts SET triggered = 0, updated_at = datetime('now')
    WHERE id = ? AND triggered = 1
`);

export function canCreateAlert(userId, userTier) {
    if (userTier === 'paid') return { allowed: true, count: 0, limit: Infinity };
    const { count } = stmtCountActiveAlerts.get(userId);
    return { allowed: count < FREE_ALERT_LIMIT, count, limit: FREE_ALERT_LIMIT };
}

export function createAlert(userId, { cardName, game, targetPrice, productId, productUrl, imageUrl, setName, currentPrice }) {
    return stmtCreateAlert.get({
        userId,
        cardName,
        game: game ?? 'any',
        targetPrice,
        productId: productId ?? null,
        productUrl: productUrl ?? null,
        imageUrl: imageUrl ?? null,
        setName: setName ?? null,
        currentPrice: currentPrice ?? null,
    });
}

export function getUserAlerts(userId) {
    return stmtGetUserAlerts.all(userId);
}

export function getAllActiveAlerts() {
    return stmtGetAllActiveAlerts.all();
}

export function getAlert(alertId, userId) {
    return stmtGetAlert.get(alertId, userId);
}

export function removeAlert(alertId, userId) {
    const result = stmtDeactivateAlert.run(alertId, userId);
    return result.changes > 0;
}

export function triggerAlert(alertId, currentPrice) {
    stmtTriggerAlert.run(currentPrice, alertId);
}

export function updateAlertPrice(alertId, { currentPrice, productId, productUrl, imageUrl, setName }) {
    stmtUpdateAlertPrice.run(
        currentPrice ?? null,
        productId ?? null,
        productUrl ?? null,
        imageUrl ?? null,
        setName ?? null,
        alertId,
    );
}

export function resetTriggered(alertId) {
    stmtResetTriggered.run(alertId);
}

// ─── Price Check History ──────────────────────────────────────────

const stmtRecordPriceCheck = db.prepare(`
    INSERT INTO price_checks (alert_id, price, market_price, lowest_price)
    VALUES (?, ?, ?, ?)
`);

const stmtGetPriceHistory = db.prepare(`
    SELECT * FROM price_checks WHERE alert_id = ? ORDER BY checked_at DESC LIMIT ?
`);

export function recordPriceCheck(alertId, price, marketPrice, lowestPrice) {
    stmtRecordPriceCheck.run(alertId, price, marketPrice ?? null, lowestPrice ?? null);
}

export function getPriceHistory(alertId, limit = 50) {
    return stmtGetPriceHistory.all(alertId, limit);
}

// ─── Subscription Operations ──────────────────────────────────────

const stmtUpgradeTier = db.prepare(`
    UPDATE users SET tier = 'paid', updated_at = datetime('now') WHERE id = ?
`);

const stmtDowngradeTier = db.prepare(`
    UPDATE users SET tier = 'free', updated_at = datetime('now') WHERE id = ?
`);

export function upgradeToPaid(userId) {
    stmtUpgradeTier.run(userId);
}

export function downgradeToFree(userId) {
    stmtDowngradeTier.run(userId);
}

// ─── Stats ────────────────────────────────────────────────────────

const stmtStats = db.prepare(`
    SELECT
        (SELECT COUNT(*) FROM users) as totalUsers,
        (SELECT COUNT(*) FROM alerts WHERE active = 1) as activeAlerts,
        (SELECT COUNT(*) FROM alerts WHERE triggered = 1) as triggeredAlerts,
        (SELECT COUNT(*) FROM price_checks) as totalPriceChecks
`);

export function getStats() {
    return stmtStats.get();
}

// ─── Feedback ────────────────────────────────────────────────────

const stmtInsertFeedback = db.prepare(`
    INSERT INTO feedback (user_id, message) VALUES (?, ?)
`);

const stmtGetFeedback = db.prepare(`
    SELECT f.*, u.platform, u.username FROM feedback f JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC LIMIT ?
`);

export function saveFeedback(userId, message) {
    return stmtInsertFeedback.run(userId, message);
}

export function getRecentFeedback(limit = 50) {
    return stmtGetFeedback.all(limit);
}

export default db;

// Run migrations if called directly
if (process.argv[1]?.endsWith('db.js')) {
    log.info('Database schema created/verified successfully');
    log.info('Stats:', getStats());
    db.close();
}
