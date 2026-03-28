/**
 * Discord Bot for TCG Price Alerts
 * Uses slash commands: /alert, /search, /list, /remove, /history, /upgrade, /help
 */

import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
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
    saveFeedback,
} from './db.js';
import { searchCard, SUPPORTED_GAMES } from './tcgplayer.js';

const log = createLogger('discord');

let client = null;

/**
 * Format price for display
 */
function fmtPrice(price) {
    if (price === null || price === undefined) return 'N/A';
    return `$${Number(price).toFixed(2)}`;
}

/**
 * Define slash commands
 */
function buildCommands() {
    const gameChoices = SUPPORTED_GAMES.map(g => ({ name: g.label, value: g.key }));

    return [
        new SlashCommandBuilder()
            .setName('alert')
            .setDescription('Set a price alert for a TCG card')
            .addStringOption(opt =>
                opt.setName('card').setDescription('Card name to track').setRequired(true))
            .addNumberOption(opt =>
                opt.setName('price').setDescription('Target price (alert when below)').setRequired(true))
            .addStringOption(opt =>
                opt.setName('game').setDescription('Card game').addChoices(...gameChoices)),

        new SlashCommandBuilder()
            .setName('search')
            .setDescription('Search TCGPlayer for a card')
            .addStringOption(opt =>
                opt.setName('card').setDescription('Card name to search').setRequired(true))
            .addStringOption(opt =>
                opt.setName('game').setDescription('Card game').addChoices(...gameChoices)),

        new SlashCommandBuilder()
            .setName('list')
            .setDescription('View your active price alerts'),

        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove a price alert')
            .addIntegerOption(opt =>
                opt.setName('id').setDescription('Alert ID (optional — shows picker if omitted)')),

        new SlashCommandBuilder()
            .setName('history')
            .setDescription('View price history for an alert (paid tier)')
            .addIntegerOption(opt =>
                opt.setName('id').setDescription('Alert ID').setRequired(true)),

        new SlashCommandBuilder()
            .setName('upgrade')
            .setDescription('Info about upgrading to paid tier'),

        new SlashCommandBuilder()
            .setName('tcghelp')
            .setDescription('Show TCG Price Bot help'),

        new SlashCommandBuilder()
            .setName('tcgstats')
            .setDescription('View bot statistics'),

        new SlashCommandBuilder()
            .setName('feedback')
            .setDescription('Send feedback or report an issue')
            .addStringOption(opt =>
                opt.setName('message').setDescription('Your feedback or issue').setRequired(true)),
    ].map(cmd => cmd.toJSON());
}

/**
 * Register slash commands with Discord
 */
async function registerCommands(token, appId) {
    const rest = new REST({ version: '10' }).setToken(token);

    try {
        log.info('Registering Discord slash commands...');
        await rest.put(Routes.applicationCommands(appId), { body: buildCommands() });
        log.info('Discord slash commands registered');
    } catch (err) {
        log.error(`Failed to register slash commands: ${err.message}`);
    }
}

/**
 * Initialize and start the Discord bot
 */
export async function startDiscordBot() {
    const token = process.env.DISCORD_BOT_TOKEN;
    const appId = process.env.DISCORD_APP_ID;

    if (!token) {
        log.warn('DISCORD_BOT_TOKEN not set, skipping Discord bot');
        return null;
    }

    if (!appId) {
        log.warn('DISCORD_APP_ID not set, cannot register slash commands');
        return null;
    }

    // Register slash commands
    await registerCommands(token, appId);

    client = new Client({
        intents: [GatewayIntentBits.Guilds],
    });

    client.on('ready', () => {
        log.info(`Discord bot logged in as ${client.user.tag}`);
    });

    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) return;

        const userId = interaction.user.id;
        const username = interaction.user.username;

        try {
            switch (interaction.commandName) {
                case 'alert':
                    await handleAlert(interaction, userId, username);
                    break;
                case 'search':
                    await handleSearch(interaction);
                    break;
                case 'list':
                    await handleList(interaction, userId, username);
                    break;
                case 'remove':
                    await handleRemove(interaction, userId, username);
                    break;
                case 'history':
                    await handleHistory(interaction, userId, username);
                    break;
                case 'upgrade':
                    await handleUpgrade(interaction, userId, username);
                    break;
                case 'tcghelp':
                    await handleHelp(interaction);
                    break;
                case 'tcgstats':
                    await handleStats(interaction);
                    break;
                case 'feedback':
                    await handleFeedback(interaction, userId, username);
                    break;
                default:
                    await interaction.reply({ content: 'Unknown command.', ephemeral: true });
            }
        } catch (err) {
            log.error(`Discord command error (${interaction.commandName}): ${err.message}`);
            const reply = interaction.replied || interaction.deferred
                ? interaction.followUp.bind(interaction)
                : interaction.reply.bind(interaction);
            await reply({ content: 'An error occurred processing your command.', ephemeral: true });
        }
    });

    // ─── Handle select menus & buttons ────────────────────────
    client.on('interactionCreate', async (interaction) => {
        if (interaction.isStringSelectMenu() && interaction.customId === 'remove_alert') {
            const alertId = parseInt(interaction.values[0]);
            const userId = interaction.user.id;
            const username = interaction.user.username;
            const user = getOrCreateUser('discord', userId, username);
            const alert = getAlert(alertId, user.id);

            if (!alert) {
                await interaction.update({ content: `Alert #${alertId} not found.`, components: [], embeds: [] });
                return;
            }

            removeAlert(alertId, user.id);
            await interaction.update({
                content: `Alert #${alertId} ("${alert.card_name}") removed.`,
                components: [],
                embeds: [],
            });
        }
    });

    // ─── Register notifier ─────────────────────────────────────
    registerNotifier(async (alert, card, currentPrice) => {
        if (alert.platform !== 'discord') return;

        try {
            const discordUser = await client.users.fetch(alert.platform_user_id);
            if (!discordUser) return;

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('PRICE ALERT!')
                .setDescription(`**${alert.card_name}** has dropped to ${fmtPrice(currentPrice)}!`)
                .addFields(
                    { name: 'Your Target', value: fmtPrice(alert.target_price), inline: true },
                    { name: 'Current Price', value: fmtPrice(currentPrice), inline: true },
                    { name: 'Game', value: alert.game === 'any' ? 'All' : alert.game, inline: true },
                )
                .setTimestamp();

            if (card?.setName) embed.addFields({ name: 'Set', value: card.setName, inline: true });
            if (card?.lowestPrice) embed.addFields({ name: 'Lowest Price', value: fmtPrice(card.lowestPrice), inline: true });
            if (card?.totalListings) embed.addFields({ name: 'Listings', value: String(card.totalListings), inline: true });
            if (card?.url) embed.setURL(card.url);
            if (card?.imageUrl) embed.setThumbnail(card.imageUrl);

            embed.setFooter({ text: `Alert #${alert.id} | Use /remove to stop` });

            await discordUser.send({ embeds: [embed] });
            log.info(`Discord notification sent to ${alert.platform_user_id} for alert #${alert.id}`);
        } catch (err) {
            log.error(`Failed to send Discord notification: ${err.message}`);
        }
    });

    await client.login(token);
    log.info('Discord bot started');
    return client;
}

// ─── Command Handlers ───────────────────────────────────────────

async function handleAlert(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const cardName = interaction.options.getString('card');
    const targetPrice = interaction.options.getNumber('price');
    const game = interaction.options.getString('game') ?? 'any';

    // Check alert limit
    const { allowed, count, limit } = canCreateAlert(user.id, user.tier);
    if (!allowed) {
        await interaction.reply({
            content: `You've reached the free tier limit of ${limit} active alerts (current: ${count}). Remove an alert with /remove or /upgrade for unlimited.`,
            ephemeral: true,
        });
        return;
    }

    await interaction.deferReply();

    // Look up the card on TCGPlayer
    const results = await searchCard(cardName, game, 1);
    const card = results[0] ?? null;

    const alert = createAlert(user.id, {
        cardName,
        game,
        targetPrice,
        productId: card?.productId ?? null,
        productUrl: card?.url ?? null,
        imageUrl: card?.imageUrl ?? null,
        setName: card?.setName ?? null,
        currentPrice: card?.marketPrice ?? null,
    });

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle(`Alert #${alert.id} Created`)
        .setDescription(`Tracking **${cardName}** below ${fmtPrice(targetPrice)}`)
        .addFields(
            { name: 'Game', value: game === 'any' ? 'All Games' : game, inline: true },
            { name: 'Target', value: fmtPrice(targetPrice), inline: true },
            { name: 'Current', value: card?.marketPrice ? fmtPrice(card.marketPrice) : 'Checking...', inline: true },
        )
        .setTimestamp();

    if (card?.imageUrl) embed.setThumbnail(card.imageUrl);
    if (card?.url) embed.setURL(card.url);
    if (card?.setName) embed.addFields({ name: 'Set', value: card.setName, inline: true });

    embed.setFooter({ text: 'Prices checked every 30 minutes' });

    await interaction.editReply({ embeds: [embed] });
}

async function handleSearch(interaction) {
    const cardName = interaction.options.getString('card');
    const game = interaction.options.getString('game') ?? 'any';

    await interaction.deferReply();

    const results = await searchCard(cardName, game, 5);
    if (results.length === 0) {
        await interaction.editReply(`No results found for "${cardName}". Try a different search term.`);
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle(`Search: "${cardName}"`)
        .setTimestamp();

    for (const card of results) {
        const priceInfo = [
            `Market: ${fmtPrice(card.marketPrice)}`,
            `Low: ${fmtPrice(card.lowestPrice)}`,
            `Listings: ${card.totalListings}`,
        ].join(' | ');

        embed.addFields({
            name: `${card.name} (${card.game})`,
            value: `${card.setName ?? 'N/A'} | ${priceInfo}\n[View](${card.url})`,
        });
    }

    if (results[0]?.imageUrl) embed.setThumbnail(results[0].imageUrl);

    await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const alerts = getUserAlerts(user.id);

    if (alerts.length === 0) {
        await interaction.reply({
            content: 'You have no active alerts. Create one with /alert.',
            ephemeral: true,
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Your Active Alerts')
        .setTimestamp();

    for (const a of alerts) {
        const gameLabel = a.game === 'any' ? 'All' : a.game;
        const priceInfo = a.current_price ? fmtPrice(a.current_price) : 'checking...';
        const triggerIcon = a.triggered ? ' [TRIGGERED]' : '';

        embed.addFields({
            name: `#${a.id} - ${a.card_name}${triggerIcon}`,
            value: `Game: ${gameLabel} | Target: ${fmtPrice(a.target_price)} | Current: ${priceInfo}`,
        });
    }

    const { limit } = canCreateAlert(user.id, user.tier);
    const tierInfo = user.tier === 'free'
        ? `Alerts: ${alerts.length}/${limit} (free tier)`
        : `Alerts: ${alerts.length} (paid - unlimited)`;

    embed.setFooter({ text: tierInfo });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleRemove(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const alertId = interaction.options.getInteger('id');

    // If no ID provided, show a dropdown picker
    if (alertId === null) {
        const alerts = getUserAlerts(user.id);
        if (alerts.length === 0) {
            await interaction.reply({ content: 'You have no active alerts.', ephemeral: true });
            return;
        }

        const select = new StringSelectMenuBuilder()
            .setCustomId('remove_alert')
            .setPlaceholder('Pick an alert to remove')
            .addOptions(alerts.slice(0, 25).map(a => ({
                label: `#${a.id} — ${a.card_name}`.slice(0, 100),
                description: `Target: ${fmtPrice(a.target_price)} | Current: ${a.current_price ? fmtPrice(a.current_price) : '...'}`.slice(0, 100),
                value: String(a.id),
            })));

        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ content: 'Which alert do you want to remove?', components: [row], ephemeral: true });
        return;
    }

    const alert = getAlert(alertId, user.id);
    if (!alert) {
        await interaction.reply({
            content: `Alert #${alertId} not found. Use /list to see your alerts.`,
            ephemeral: true,
        });
        return;
    }

    removeAlert(alertId, user.id);
    await interaction.reply({ content: `Alert #${alertId} ("${alert.card_name}") removed.`, ephemeral: true });
}

async function handleHistory(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);

    if (user.tier !== 'paid') {
        await interaction.reply({
            content: 'Price history is available for paid tier users. Use /upgrade for details.',
            ephemeral: true,
        });
        return;
    }

    const alertId = interaction.options.getInteger('id');
    const alert = getAlert(alertId, user.id);

    if (!alert) {
        await interaction.reply({ content: `Alert #${alertId} not found.`, ephemeral: true });
        return;
    }

    const history = getPriceHistory(alertId, 20);
    if (history.length === 0) {
        await interaction.reply({
            content: `No price history yet for alert #${alertId}. Prices are checked every 30 minutes.`,
            ephemeral: true,
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle(`Price History: ${alert.card_name}`)
        .setDescription(`Target: ${fmtPrice(alert.target_price)}`)
        .setTimestamp();

    const lines = history.slice(0, 15).map(h => {
        const date = h.checked_at.replace('T', ' ').slice(0, 16);
        return `\`${date}\` Market: ${fmtPrice(h.market_price)} Low: ${fmtPrice(h.lowest_price)}`;
    });

    embed.addFields({ name: 'Recent Checks', value: lines.join('\n') });
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleUpgrade(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);

    if (user.tier === 'paid') {
        await interaction.reply({
            content: 'You are already on the paid tier! Enjoy unlimited alerts and price history.',
            ephemeral: true,
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('Upgrade to Paid Tier - $5/month')
        .addFields(
            { name: 'Free Tier', value: '- 3 active alerts\n- Price notifications' },
            { name: 'Paid Tier ($5/mo)', value: '- Unlimited alerts\n- Full price history\n- Priority checks' },
        )
        .setFooter({ text: 'Payment integration coming soon! Contact @lulzasaur to upgrade.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleHelp(interaction) {
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('TCG Price Alert Bot')
        .setDescription('Track card prices on TCGPlayer and get alerts when they drop!')
        .addFields(
            { name: '/alert [card] [price] [game]', value: 'Set a price alert' },
            { name: '/search [card] [game]', value: 'Search TCGPlayer for prices' },
            { name: '/list', value: 'View your active alerts' },
            { name: '/remove [id]', value: 'Remove an alert' },
            { name: '/history [id]', value: 'View price history (paid)' },
            { name: '/upgrade', value: 'Upgrade to paid tier' },
        )
        .setFooter({ text: 'Supports: Pokemon, MTG, Yu-Gi-Oh!, Lorcana' });

    await interaction.reply({ embeds: [embed] });
}

async function handleStats(interaction) {
    const stats = getStats();
    const embed = new EmbedBuilder()
        .setColor(0x1ABC9C)
        .setTitle('Bot Statistics')
        .addFields(
            { name: 'Users', value: String(stats.totalUsers), inline: true },
            { name: 'Active Alerts', value: String(stats.activeAlerts), inline: true },
            { name: 'Triggered', value: String(stats.triggeredAlerts), inline: true },
            { name: 'Price Checks', value: String(stats.totalPriceChecks), inline: true },
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

async function handleFeedback(interaction, userId, username) {
    const user = getOrCreateUser('discord', userId, username);
    const message = interaction.options.getString('message');

    saveFeedback(user.id, message);
    log.info(`Feedback from ${username} (${userId}): ${message}`);

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('Feedback Received')
        .setDescription('Thanks! We read every message and use it to improve the bot.')
        .addFields({
            name: 'Need more help?',
            value: 'Email us at **lulzasaur9192@gmail.com**',
        })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export function stopDiscordBot() {
    if (client) {
        client.destroy();
        log.info('Discord bot stopped');
    }
}
