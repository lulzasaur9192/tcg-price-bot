/**
 * CLI tool to manually run a price check
 * Usage: node src/check-prices-cli.js [card name] [game]
 *
 * If no arguments, runs the full price check cycle for all alerts.
 * With arguments, searches TCGPlayer and prints results.
 */

import { createLogger } from './logger.js';
import { searchCard, SUPPORTED_GAMES } from './tcgplayer.js';
import { runPriceCheck } from './price-checker.js';

const log = createLogger('cli');

function fmtPrice(price) {
    if (price === null || price === undefined) return 'N/A';
    return `$${Number(price).toFixed(2)}`;
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        // Run a full price check cycle
        log.info('Running full price check cycle...');
        const result = await runPriceCheck();
        log.info('Result:', result);
        process.exit(0);
    }

    // Search mode
    const gameKeys = SUPPORTED_GAMES.map(g => g.key);
    let game = 'any';
    let startIdx = 0;

    if (gameKeys.includes(args[0]?.toLowerCase())) {
        game = args[0].toLowerCase();
        startIdx = 1;
    }

    const cardName = args.slice(startIdx).join(' ');
    if (!cardName) {
        console.log('Usage:');
        console.log('  node src/check-prices-cli.js                    # Run full price check');
        console.log('  node src/check-prices-cli.js [card name]        # Search for a card');
        console.log('  node src/check-prices-cli.js [game] [card name] # Search with game filter');
        console.log('');
        console.log('Games:', gameKeys.join(', '));
        process.exit(1);
    }

    console.log(`\nSearching TCGPlayer for "${cardName}" (${game})...\n`);

    const results = await searchCard(cardName, game, 10);
    if (results.length === 0) {
        console.log('No results found.');
        process.exit(0);
    }

    console.log(`Found ${results.length} results:\n`);

    for (const card of results) {
        console.log(`  ${card.name}`);
        console.log(`    Game: ${card.game} | Set: ${card.setName ?? 'N/A'} | Rarity: ${card.rarity ?? 'N/A'}`);
        console.log(`    Market: ${fmtPrice(card.marketPrice)} | Low: ${fmtPrice(card.lowestPrice)} | Listings: ${card.totalListings}`);
        console.log(`    URL: ${card.url}`);
        console.log('');
    }

    process.exit(0);
}

main().catch(err => {
    log.error(`CLI error: ${err.message}`);
    process.exit(1);
});
