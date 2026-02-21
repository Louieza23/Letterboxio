const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BASE_URL = 'https://letterboxd.com';

// ── Cookie-based session ──────────────────────────────────────────────────────
// Rather than scraping the login form (blocked by Cloudflare), we use session
// cookies copied directly from the browser. Set these in .env.

function hasSession() {
    return !!(process.env.LETTERBOXD_USERNAME && process.env.LETTERBOXD_PASSWORD);
}

// ── Simple in-memory cache ────────────────────────────────────────────────────

const cache = new Map();

function setCache(key, value, ttlMs) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function getCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
    return entry.value;
}

// ── Shared request headers ────────────────────────────────────────────────────

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
};

// ── Watchlist scraping ────────────────────────────────────────────────────────

async function fetchWatchlistPage(username, page = 1) {
    const url = `${BASE_URL}/${username}/watchlist/page/${page}/`;
    const res = await axios.get(url, { headers: BASE_HEADERS, timeout: 10000 });
    const $ = cheerio.load(res.data);

    const films = [];
    // Letterboxd uses React components — film data lives on the parent div
    $('div.react-component[data-item-slug]').each((_, el) => {
        const slug = $(el).attr('data-item-slug');
        const title = $(el).attr('data-item-name')?.replace(/\s*\(\d{4}\)\s*$/, '').trim()
            || $(el).find('img').attr('alt')
            || slug;
        const filmId = $(el).attr('data-film-id');
        if (slug) films.push({ slug, title, filmId });
    });

    const hasNext = $('a.next').length > 0;
    return { films, hasNext };
}

async function getWatchlist(username) {
    const cacheKey = `watchlist:${username}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    const allFilms = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
        try {
            const result = await fetchWatchlistPage(username, page);
            allFilms.push(...result.films);
            hasNext = result.hasNext;
            page++;
            if (hasNext) await new Promise(r => setTimeout(r, 300));
        } catch (err) {
            console.error(`Error fetching watchlist page ${page}:`, err.message);
            break;
        }
    }

    setCache(cacheKey, allFilms, 5 * 60 * 1000); // 5 minutes
    return allFilms;
}

// ── Film metadata (IMDB ID, poster, year) ────────────────────────────────────

async function getFilmMeta(slug) {
    const cacheKey = `meta:${slug}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
        const url = `${BASE_URL}/film/${slug}/`;
        const res = await axios.get(url, { headers: BASE_HEADERS, timeout: 10000 });
        const $ = cheerio.load(res.data);

        let imdbId = null;
        $('a[href*="imdb.com/title/"]').each((_, el) => {
            const href = $(el).attr('href');
            const match = href.match(/imdb\.com\/title\/(tt\d+)/);
            if (match) { imdbId = match[1]; return false; }
        });

        const year = $('meta[property="og:title"]').attr('content')?.match(/\((\d{4})\)/)?.[1] || null;
        const description = $('meta[property="og:description"]').attr('content') || null;

        // og:image is a landscape/square crop — convert to portrait by swapping
        // the crop dimensions in the URL to Letterboxd's portrait size (230x345).
        // e.g. gosford-park-1200-1200-675-675-crop-000000.jpg
        //   →  gosford-park-0-230-0-345-crop-000000.jpg
        let poster = $('meta[property="og:image"]').attr('content') || null;
        if (poster && poster.includes('a.ltrbxd.com/resized/')) {
            poster = poster.replace(/-\d+-\d+-\d+-\d+-crop-([^.?]+)/, '-0-230-0-345-crop-$1');
        }

        const meta = { imdbId, year, poster, description };
        setCache(cacheKey, meta, 6 * 60 * 60 * 1000); // 6 hours
        return meta;
    } catch (err) {
        console.error(`Error fetching meta for ${slug}:`, err.message);
        return { imdbId: null, year: null, poster: null, description: null };
    }
}

// ── User's existing rating (via logged-in Puppeteer session) ─────────────────
// The URL /{username}/film/{slug}/ does NOT exist on Letterboxd (404).
// The user's personal rating is shown on /film/{slug}/ only when logged in.
// So we reuse the existing Puppeteer session (already logged in) to scrape it.

async function getUserRating(username, slug) {
    const cacheKey = `userrating:${username}:${slug}`;
    const cached = getCache(cacheKey);
    if (cached !== null) return cached;

    // If no session configured, skip silently
    if (!hasSession()) {
        setCache(cacheKey, null, 5 * 60 * 1000);
        return null;
    }

    let page;
    try {
        const b = await ensureBrowserLoggedIn();
        page = await b.newPage();

        // Block images/styles/fonts to save memory
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const filmUrl = `${BASE_URL}/film/${slug}/`;
        await page.goto(filmUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // The user's personal rating lives inside the #film-rating-widget,
        // specifically on the div.rateit element's data-rateit-value attribute
        // (1–10 scale, divide by 2 for stars) OR as a span.rating.rated-N inside
        // the aside#sidebar .your-rating section.
        const ratingClass = await page.evaluate(() => {
            // Most reliable: the rateit widget stores the current value in data-rateit-value
            const rateit = document.querySelector('#film-rating-widget div.rateit[data-rateit-value]');
            if (rateit) {
                const val = rateit.getAttribute('data-rateit-value');
                if (val && val !== '0') return `rateit:${val}`;
            }
            // Fallback: span.rating inside the user's own rating section (not community)
            const userSection = document.querySelector('.your-rating span.rating[class*="rated-"], #film-rating-widget span.rating[class*="rated-"]');
            return userSection ? userSection.className : null;
        });

        await page.close();

        if (!ratingClass) {
            setCache(cacheKey, null, 5 * 60 * 1000);
            return null;
        }

        let stars;
        if (ratingClass.startsWith('rateit:')) {
            // data-rateit-value is on a 1–10 scale
            const val = parseInt(ratingClass.slice(7), 10);
            if (!val) { setCache(cacheKey, null, 5 * 60 * 1000); return null; }
            stars = val / 2;
        } else {
            const match = ratingClass.match(/rated-(\d+)/);
            if (!match) { setCache(cacheKey, null, 5 * 60 * 1000); return null; }
            stars = parseInt(match[1], 10) / 2; // e.g. rated-8 → 4 stars
        }
        setCache(cacheKey, stars, 5 * 60 * 1000);
        console.log(`[getUserRating] ${username}/${slug}: ${stars} stars`);
        return stars;
    } catch (err) {
        if (page) await page.close().catch(() => {});
        console.error(`[getUserRating] ${username}/${slug}:`, err.message);
        return null;
    }
}

// ── Rating (via Puppeteer) ────────────────────────────────────────────────────
// We use a real headless browser to bypass Cloudflare's bot protection.
// The browser is launched once and reused across rating calls.

// Letterboxd stores ratings as 1–10 internally (half-star increments)
const RATING_MAP = {
    '0.5': 1, '1': 2, '1.5': 3, '2': 4, '2.5': 5,
    '3': 6, '3.5': 7, '4': 8, '4.5': 9, '5': 10,
};

let browser = null;
let browserLoggedIn = false;

async function getBrowser() {
    if (browser && browser.connected) return browser;
    console.log('[puppeteer] Launching browser...');
    browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // critical for Railway/Docker containers
            '--disable-gpu',
        ],
    });
    browserLoggedIn = false;
    console.log('[puppeteer] Browser ready');
    return browser;
}

async function ensureBrowserLoggedIn() {
    const b = await getBrowser();
    if (browserLoggedIn) return b;

    const username = process.env.LETTERBOXD_USERNAME;
    const password = process.env.LETTERBOXD_PASSWORD;
    if (!username || !password) {
        throw new Error('LETTERBOXD_USERNAME and LETTERBOXD_PASSWORD required in .env for rating');
    }

    const page = await b.newPage();
    try {
        console.log('[puppeteer] Logging in to Letterboxd...');
        await page.goto(`${BASE_URL}/sign-in/`, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for the form to be present (also handles Cloudflare challenge delay)
        await page.waitForSelector('input[name="username"]', { timeout: 20000 });

        await page.type('input[name="username"]', username, { delay: 50 });
        await page.type('input[name="password"]', password, { delay: 50 });

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            page.click('input[type="submit"], button[type="submit"]'),
        ]);

        const url = page.url();
        console.log('[puppeteer] Post-login URL:', url);

        if (url.includes('/sign-in/')) {
            throw new Error('Login failed — still on sign-in page. Check credentials in .env.');
        }

        browserLoggedIn = true;
        console.log('[puppeteer] Login successful');
    } finally {
        await page.close();
    }

    return b;
}

async function rateFilm(slug, starRating) {
    const ratingValue = RATING_MAP[String(starRating)];
    if (!ratingValue) {
        return { success: false, error: `Invalid rating value: ${starRating}` };
    }

    let page;
    try {
        const b = await ensureBrowserLoggedIn();
        page = await b.newPage();

        // Block images/styles/fonts to reduce memory usage on Railway's 512MB container
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const filmUrl = `${BASE_URL}/film/${slug}/`;
        console.log(`[puppeteer] Navigating to ${filmUrl}`);
        await page.goto(filmUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Check if Cloudflare served a challenge page instead of the real page
        const pageTitle = await page.title();
        if (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required')) {
            console.log(`[puppeteer] Cloudflare challenge detected, waiting...`);
            await new Promise(r => setTimeout(r, 5000));
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        }

        // Wait for the rateit widget to render and grab its data attributes
        await page.waitForSelector('div.rateit[data-rate-action]', { timeout: 15000 });

        const widgetData = await page.evaluate(() => {
            const widget = document.querySelector('div.rateit[data-rate-action]');
            // CSRF is available in multiple places; try all
            const csrf = document.querySelector('input[name="__csrf"]')?.value
                || document.querySelector('meta[name="csrf-token"]')?.content
                || document.body.getAttribute('data-csrf');
            return {
                rateAction: widget?.getAttribute('data-rate-action'),
                csrf,
            };
        });

        console.log(`[puppeteer] rateAction=${widgetData.rateAction} csrf=${widgetData.csrf?.slice(0, 8)}...`);

        if (!widgetData.rateAction) {
            return { success: false, error: 'Could not find rating widget — may not be logged in' };
        }

        // POST directly to the rate endpoint discovered from the widget
        const result = await page.evaluate(async (rateAction, csrf, ratingValue, baseUrl) => {
            const res = await fetch(`${baseUrl}${rateAction}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ rating: ratingValue, __csrf: csrf }),
            });
            return { status: res.status, body: await res.text() };
        }, widgetData.rateAction, widgetData.csrf, ratingValue, BASE_URL);

        console.log(`[puppeteer] rating response: ${result.status} ${result.body.slice(0, 150)}`);
        await page.close();

        if (result.status === 200) {
            let parsed;
            try { parsed = JSON.parse(result.body); } catch {}
            if (parsed?.result === true) {
                cache.delete(`rating:${slug}`);
                cache.delete(`userrating:${process.env.LETTERBOXD_USERNAME}:${slug}`);
                return { success: true };
            } else {
                return { success: false, error: `Unexpected response: ${result.body.slice(0, 100)}` };
            }
        } else {
            if (result.status === 403) browserLoggedIn = false;
            return { success: false, error: `HTTP ${result.status}: ${result.body.slice(0, 100)}` };
        }
    } catch (err) {
        if (page) await page.close().catch(() => {});
        browser = null;
        browserLoggedIn = false;
        return { success: false, error: err.message };
    }
}

// ── Resolve slug from IMDB ID via Puppeteer ───────────────────────────────────
// Used as fallback for films outside the watchlist.
// Letterboxd redirects /film/imdb/{imdbId}/ to the correct film page.

async function resolveSlugFromImdbViaPuppeteer(imdbId) {
    let page;
    try {
        const b = await ensureBrowserLoggedIn();
        page = await b.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });
        await page.goto(`${BASE_URL}/film/imdb/${imdbId}/`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
        });
        const finalUrl = page.url();
        await page.close();
        // Final URL is like https://letterboxd.com/film/violent-cop/
        const match = finalUrl.match(/letterboxd\.com\/film\/([^/]+)\//);
        if (match) {
            console.log(`[resolveSlug] ${imdbId} → ${match[1]} (via Puppeteer)`);
            return match[1];
        }
        return null;
    } catch (err) {
        if (page) await page.close().catch(() => {});
        console.error(`[resolveSlug] Puppeteer failed for ${imdbId}:`, err.message);
        return null;
    }
}

module.exports = { getWatchlist, getFilmMeta, getUserRating, rateFilm, hasSession, getFromCache: getCache, resolveSlugFromImdbViaPuppeteer };
