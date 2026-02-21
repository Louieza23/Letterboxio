require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { getWatchlist, getFilmMeta, rateFilm, hasSession, resolveSlugFromImdbViaPuppeteer } = require('./letterboxd');

const USERNAME = process.env.LETTERBOXD_USERNAME || 'snuffalobill';
const PORT = process.env.PORT || 7000;

// ── Addon manifest ─────────────────────────────────────────────────────────────

const manifest = {
    id: 'com.letterboxio.addon',
    version: '1.0.0',
    name: 'Letterboxio',
    description: `Syncs with ${USERNAME}'s Letterboxd account. Shows watchlist and allows rating films.`,
    logo: 'https://a.ltrbxd.com/logos/letterboxd-decal-dots-neg-mono-500px.png',
    resources: ['catalog', 'stream'],
    types: ['movie'],
    catalogs: [
        {
            id: 'letterboxd-watchlist',
            type: 'movie',
            name: 'Letterboxio Watchlist',
            extra: [{ name: 'skip', isRequired: false }],
        },
    ],
    idPrefixes: ['tt'],
    behaviorHints: { configurable: false },
};

const builder = new addonBuilder(manifest);

// ── Catalog handler ───────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (type !== 'movie' || id !== 'letterboxd-watchlist') {
        return { metas: [] };
    }

    console.log(`[catalog] Fetching watchlist for ${USERNAME}`);

    let films;
    try {
        films = await getWatchlist(USERNAME);
    } catch (err) {
        console.error('[catalog] Failed to fetch watchlist:', err.message);
        return { metas: [] };
    }

    // Pagination via skip
    const skip = parseInt(extra?.skip || '0', 10);
    const PAGE_SIZE = 100;
    const pageFilms = films.slice(skip, skip + PAGE_SIZE);

    // Resolve IMDB IDs concurrently (5 at a time to avoid hammering Letterboxd)
    const CONCURRENCY = 5;
    const metas = [];

    for (let i = 0; i < pageFilms.length; i += CONCURRENCY) {
        const batch = pageFilms.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
            batch.map(async (film) => {
                try {
                    const meta = await getFilmMeta(film.slug);
                    if (!meta.imdbId) return null;
                    // Cache the slug↔imdbId mapping so /rate works immediately
                    imdbToSlugCache.set(meta.imdbId, film.slug);
                    return {
                        id: meta.imdbId,
                        type: 'movie',
                        name: film.title,
                        // MetaHub is the standard Stremio poster CDN used by Cinemeta
                        // and all major addons — serves proper portrait posters by IMDB ID
                        poster: `https://images.metahub.space/poster/medium/${meta.imdbId}/img`,
                        year: meta.year ? parseInt(meta.year) : undefined,
                        description: meta.description,
                    };
                } catch {
                    return null;
                }
            })
        );
        metas.push(...results.filter(Boolean));
    }

    console.log(`[catalog] Returning ${metas.length} films`);
    return { metas };
});

// ── Stream handler (rating buttons) ──────────────────────────────────────────

const STAR_OPTIONS = [
    { stars: '5',   label: '★★★★★  5 stars' },
    { stars: '4.5', label: '★★★★½  4.5 stars' },
    { stars: '4',   label: '★★★★   4 stars' },
    { stars: '3.5', label: '★★★½   3.5 stars' },
    { stars: '3',   label: '★★★    3 stars' },
    { stars: '2.5', label: '★★½    2.5 stars' },
    { stars: '2',   label: '★★     2 stars' },
    { stars: '1.5', label: '★½     1.5 stars' },
    { stars: '1',   label: '★      1 star' },
    { stars: '0.5', label: '½      0.5 stars' },
];

builder.defineStreamHandler(({ type, id }) => {
    if (type !== 'movie') return Promise.resolve({ streams: [] });

    console.log(`[stream] Rating streams requested for ${id}`);

    let baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
    if (baseUrl && !baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

    // Return rating buttons instantly — no async work, no Puppeteer, no timeouts.
    const streams = STAR_OPTIONS.map(opt => ({
        name: 'Rate on Letterboxd',
        description: opt.label,
        url: `${baseUrl}/rate/${encodeURIComponent(id)}/${encodeURIComponent(opt.stars)}`,
    }));

    return Promise.resolve({ streams });
});

// ── Express app ───────────────────────────────────────────────────────────────

const addonInterface = builder.getInterface();
const app = express();

// CORS — required for Stremio to reach the addon
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// Manifest
app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

// Catalog: GET /catalog/movie/letterboxd-watchlist.json
app.get('/catalog/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    const extra = {};
    if (req.query.skip) extra.skip = req.query.skip;

    try {
        const result = await addonInterface.get('catalog', type, id, extra);
        res.setHeader('Cache-Control', 'max-age=300, stale-while-revalidate=600');
        res.json(result);
    } catch (err) {
        console.error('[catalog route] error:', err.message);
        res.json({ metas: [] });
    }
});

// Stream: GET /stream/movie/tt1234567.json
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    try {
        const result = await addonInterface.get('stream', type, id, {});
        res.json(result);
    } catch (err) {
        console.error('[stream route] error:', err.message);
        res.json({ streams: [] });
    }
});

// ── /rate endpoint ────────────────────────────────────────────────────────────
// Stremio "plays" this URL when the user selects a rating.
// We do the rating, then return a minimal M3U8 so Stremio closes cleanly.

app.get('/rate/:imdbId/:stars', (req, res) => {
    const { imdbId, stars } = req.params;
    console.log(`[rate] ${imdbId} → ${stars} stars`);

    // Respond immediately so Stremio closes the popup right away.
    serveM3U8(res);

    if (!hasSession()) {
        console.error('[rate] No session cookies set in .env');
        return;
    }

    // Deduplicate — Android TV fires the same request 3-4x simultaneously
    if (!deduplicateRating(imdbId, stars)) return;

    // Resolve slug then enqueue (one Puppeteer page at a time)
    resolveSlugFromImdb(imdbId).then(slug => {
        if (!slug) { console.error(`[rate] Could not resolve slug for ${imdbId}`); return; }
        enqueueRating(slug, stars);
    }).catch(err => {
        console.error(`[rate] Slug resolve error:`, err.message);
    });
});

// ── /noop endpoint ────────────────────────────────────────────────────────────

app.get('/noop', (req, res) => {
    serveM3U8(res);
});

// ── Rating deduplication & queue ──────────────────────────────────────────────
// Android TV fires the same rating request 3-4 times simultaneously.
// We deduplicate by ignoring requests for the same film within 5 seconds,
// and queue rating jobs so only one Puppeteer page runs at a time.

const recentRatings = new Map(); // imdbId → timestamp of last accepted rating
const ratingQueue = [];          // pending { slug, stars } jobs
let ratingRunning = false;

function deduplicateRating(imdbId, stars) {
    const key = `${imdbId}:${stars}`;
    const last = recentRatings.get(key);
    if (last && Date.now() - last < 5000) {
        console.log(`[rate] Duplicate ignored for ${key}`);
        return false; // duplicate
    }
    recentRatings.set(key, Date.now());
    return true;
}

function enqueueRating(slug, stars) {
    ratingQueue.push({ slug, stars });
    if (!ratingRunning) processRatingQueue();
}

async function processRatingQueue() {
    if (ratingQueue.length === 0) { ratingRunning = false; return; }
    ratingRunning = true;
    const { slug, stars } = ratingQueue.shift();
    try {
        const result = await rateFilm(slug, stars);
        console.log(`[rate] ${result.success ? 'OK' : 'FAILED: ' + result.error}`);
    } catch (err) {
        console.error(`[rate] Queue error:`, err.message);
    }
    processRatingQueue(); // process next
}

// ── Slug resolution ───────────────────────────────────────────────────────────

const imdbToSlugCache = new Map();

async function resolveSlugFromImdb(imdbId) {
    if (imdbToSlugCache.has(imdbId)) return imdbToSlugCache.get(imdbId);

    // Search watchlist cache (slug cache is pre-warmed at startup)
    try {
        const watchlist = await getWatchlist(USERNAME);
        for (const film of watchlist) {
            const meta = await getFilmMeta(film.slug);
            if (meta.imdbId === imdbId) {
                imdbToSlugCache.set(imdbId, film.slug);
                return film.slug;
            }
        }
    } catch {}

    // Not in watchlist — fall back to Puppeteer which bypasses Cloudflare.
    // Letterboxd redirects /film/imdb/{imdbId}/ to the correct film page.
    const slug = await resolveSlugFromImdbViaPuppeteer(imdbId);
    if (slug) imdbToSlugCache.set(imdbId, slug);
    return slug;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function serveM3U8(res) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.send('#EXTM3U\n#EXT-X-ENDLIST\n');
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\nLetterboxio addon running!`);
    console.log(`Add to Stremio: http://localhost:${PORT}/manifest.json\n`);
    console.log(`Letterboxd user: ${USERNAME}`);
    console.log(`Session cookies: ${hasSession() ? 'YES' : 'NO — rating will not work'}\n`);

    // Pre-warm the slug cache on startup so ratings work immediately
    // without waiting for the catalog to be opened first
    getWatchlist(USERNAME).then(async films => {
        console.log(`[startup] Pre-warming slug cache for ${films.length} films...`);
        // Low concurrency at startup to avoid memory spikes
        const CONCURRENCY = 2;
        for (let i = 0; i < films.length; i += CONCURRENCY) {
            const batch = films.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map(async film => {
                try {
                    const meta = await getFilmMeta(film.slug);
                    if (meta.imdbId) imdbToSlugCache.set(meta.imdbId, film.slug);
                } catch {}
            }));
            // Small pause between batches to keep memory pressure low
            await new Promise(r => setTimeout(r, 100));
        }
        console.log(`[startup] Slug cache ready (${imdbToSlugCache.size} entries)`);
    }).catch(err => console.error('[startup] Cache warm failed:', err.message));
});
