/**
 * TCGPlayer Price Fetcher
 * Uses the same public search API as the Apify tcgplayer-scraper.
 * Searches for cards and returns structured price data.
 */

import { request } from 'undici';
import { createLogger } from './logger.js';

const log = createLogger('tcgplayer');

const SEARCH_API_URL = 'https://mp-search-api.tcgplayer.com/v1/search/request';
const TCGPLAYER_BASE = 'https://www.tcgplayer.com';
const TCGPLAYER_CDN = 'https://tcgplayer-cdn.tcgplayer.com/product';

// Map our game names to TCGPlayer's productLineName values
const GAME_FILTER_MAP = {
    pokemon: 'Pokemon',
    mtg: 'Magic',
    yugioh: 'YuGiOh',
    lorcana: 'Lorcana',
    any: null,
};

// In-memory cache: key -> { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Build the TCGPlayer search API URL
 */
function buildSearchUrl(query) {
    const params = new URLSearchParams();
    params.set('q', query);
    params.set('isList', 'false');
    return `${SEARCH_API_URL}?${params.toString()}`;
}

/**
 * Build the POST body for the TCGPlayer search API
 */
function buildSearchBody(game = 'any', from = 0, size = 10) {
    const body = {
        algorithm: 'sales_exp_fields_boosting',
        from,
        size,
        filters: {
            term: {},
            range: {},
            match: {},
        },
    };

    const productLineName = GAME_FILTER_MAP[game];
    if (productLineName) {
        body.filters.term.productLineName = [productLineName];
    }

    return body;
}

/**
 * Construct a TCGPlayer product URL
 */
function buildProductUrl(product) {
    const productId = Math.floor(product.productId);
    const linePart = (product.productLineUrlName ?? '').toLowerCase().replace(/\s+/g, '-');
    const setPart = (product.setUrlName ?? '').toLowerCase().replace(/\s+/g, '-');
    const namePart = (product.productUrlName ?? '').toLowerCase().replace(/\s+/g, '-');
    const slug = [linePart, setPart, namePart].filter(Boolean).join('-');
    return `${TCGPLAYER_BASE}/product/${productId}/${slug}`;
}

/**
 * Construct an image URL
 */
function buildImageUrl(productId) {
    if (!productId) return null;
    return `${TCGPLAYER_CDN}/${Math.floor(productId)}_200w.jpg`;
}

/**
 * Parse a product from the search API into our card format
 */
function parseProduct(product) {
    const productId = product.productId ? Math.floor(product.productId) : null;
    const ca = product.customAttributes ?? {};

    return {
        productId,
        name: product.productName ?? null,
        game: product.productLineName ?? null,
        setName: product.setName ?? null,
        rarity: ca.rarityDbName ?? null,
        cardNumber: ca.number ?? null,
        marketPrice: product.marketPrice ?? null,
        medianPrice: product.medianPrice ?? null,
        lowestPrice: product.lowestPrice ?? null,
        lowestPriceWithShipping: product.lowestPriceWithShipping ?? null,
        totalListings: product.totalListings ? Math.floor(product.totalListings) : 0,
        imageUrl: buildImageUrl(productId),
        url: buildProductUrl(product),
    };
}

/**
 * Search TCGPlayer for a card
 * @param {string} query - Card name to search for
 * @param {string} game - Game filter: pokemon, mtg, yugioh, lorcana, any
 * @param {number} limit - Max results to return
 * @returns {Promise<Array>} Array of card objects
 */
export async function searchCard(query, game = 'any', limit = 5) {
    const cacheKey = `${query}|${game}|${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        log.debug(`Cache hit for "${query}" (${game})`);
        return cached.data;
    }

    const url = buildSearchUrl(query);
    const body = buildSearchBody(game, 0, limit);

    log.debug(`Searching TCGPlayer: "${query}" game=${game} limit=${limit}`);

    try {
        const { statusCode, body: responseBody } = await request(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Origin': 'https://www.tcgplayer.com',
                'Referer': 'https://www.tcgplayer.com/',
            },
            body: JSON.stringify(body),
        });

        if (statusCode !== 200) {
            const text = await responseBody.text();
            log.error(`TCGPlayer API returned ${statusCode}`, { response: text.slice(0, 200) });
            return [];
        }

        const data = await responseBody.json();

        if (!data?.results?.[0]?.results) {
            log.warn(`No results for "${query}" (${game})`);
            return [];
        }

        const products = data.results[0].results;
        const cards = products.map(parseProduct);

        // Cache results
        cache.set(cacheKey, { data: cards, expiresAt: Date.now() + CACHE_TTL_MS });

        log.info(`Found ${cards.length} results for "${query}" (${game})`);
        return cards;
    } catch (err) {
        log.error(`TCGPlayer search failed for "${query}": ${err.message}`);
        return [];
    }
}

/**
 * Get the best price match for a card name + game
 * Returns the first result (most relevant) with its market price
 */
export async function getCardPrice(cardName, game = 'any') {
    const results = await searchCard(cardName, game, 3);
    if (results.length === 0) return null;

    // Return the best match (first result from TCGPlayer's relevance ranking)
    return results[0];
}

/**
 * Batch check prices for multiple alerts
 * Groups by card name to minimize API calls
 */
export async function batchCheckPrices(alerts) {
    // Group alerts by (card_name, game) to deduplicate searches
    const groups = new Map();
    for (const alert of alerts) {
        const key = `${alert.card_name.toLowerCase()}|${alert.game}`;
        if (!groups.has(key)) {
            groups.set(key, { cardName: alert.card_name, game: alert.game, alerts: [] });
        }
        groups.get(key).alerts.push(alert);
    }

    const results = [];

    for (const [, group] of groups) {
        // Small delay between requests to avoid hammering the API
        await sleep(500);

        const cards = await searchCard(group.cardName, group.game, 5);

        for (const alert of group.alerts) {
            // Find best matching card from results
            let bestMatch = null;

            if (alert.product_id) {
                // If we have a product ID from a previous check, try to match it
                bestMatch = cards.find(c => c.productId === alert.product_id);
            }

            if (!bestMatch && cards.length > 0) {
                // Fall back to the top result
                bestMatch = cards[0];
            }

            results.push({
                alert,
                card: bestMatch,
                currentPrice: bestMatch?.marketPrice ?? bestMatch?.lowestPrice ?? null,
            });
        }
    }

    return results;
}

/**
 * Clear the cache
 */
export function clearCache() {
    cache.clear();
    log.info('Price cache cleared');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Supported games for user-facing lists
export const SUPPORTED_GAMES = [
    { key: 'pokemon', label: 'Pokemon' },
    { key: 'mtg', label: 'Magic: The Gathering' },
    { key: 'yugioh', label: 'Yu-Gi-Oh!' },
    { key: 'lorcana', label: 'Disney Lorcana' },
    { key: 'any', label: 'All Games' },
];
