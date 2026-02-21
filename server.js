require('dotenv').config();

const { addonBuilder } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { getWatchlist, getFilmMeta, rateFilm, hasSession } = require('./letterboxd');

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
            name: `${USERNAME}'s Watchlist`,
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
                    return {
                        id: meta.imdbId,
                        type: 'movie',
                        name: film.title,
                        poster: meta.poster,
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

    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

    // Return rating buttons instantly — no async work, no Puppeteer, no timeouts.
    const streams = [
        {
            name: 'Letterboxio',
            description: 'Rate this film on Letterboxd',
            url: `${baseUrl}/noop`,
        },
        ...STAR_OPTIONS.map(opt => ({
            name: 'Rate on Letterboxd',
            description: opt.label,
            url: `${baseUrl}/rate/${encodeURIComponent(id)}/${encodeURIComponent(opt.stars)}`,
        })),
    ];

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

app.get('/rate/:imdbId/:stars', async (req, res) => {
    const { imdbId, stars } = req.params;
    console.log(`[rate] ${imdbId} → ${stars} stars`);

    if (!hasSession()) {
        console.error('[rate] No session cookies set in .env');
        return serveM3U8(res);
    }

    const slug = await resolveSlugFromImdb(imdbId);
    if (!slug) {
        console.error(`[rate] Could not resolve slug for ${imdbId}`);
        return serveM3U8(res);
    }

    const result = await rateFilm(slug, stars);
    console.log(`[rate] ${result.success ? 'OK' : 'FAILED: ' + result.error}`);
    serveM3U8(res);
});

// ── /noop endpoint ────────────────────────────────────────────────────────────

app.get('/noop', (req, res) => {
    serveM3U8(res);
});

// ── Slug resolution ───────────────────────────────────────────────────────────

const imdbToSlugCache = new Map();

async function resolveSlugFromImdb(imdbId) {
    if (imdbToSlugCache.has(imdbId)) return imdbToSlugCache.get(imdbId);

    // Check watchlist cache first (fast, no extra requests if catalog already loaded)
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

    // Fall back to Letterboxd search by IMDB id
    try {
        const res = await axios.get(`https://letterboxd.com/search/films/${imdbId}/`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000,
        });
        const $ = cheerio.load(res.data);
        const href = $('li.film-detail h2.film-title a').first().attr('href');
        if (href) {
            const slug = href.replace(/^\/film\//, '').replace(/\/$/, '');
            imdbToSlugCache.set(imdbId, slug);
            return slug;
        }
    } catch (err) {
        console.error('[resolveSlug] search failed:', err.message);
    }

    return null;
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
});
