const express = require('express');
const cors = require('cors');
const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;

try {
    yahooFinance.setGlobalConfig({
        validation: {
            logErrors: false,
            logOptionsErrors: false
        }
    });
} catch (error) {
    console.warn('[YAHOO] Global config not applied:', error.message);
}

const QUOTE_FIELDS = [
    'symbol',
    'shortName',
    'longName',
    'regularMarketPrice',
    'regularMarketChange',
    'regularMarketChangePercent',
    'regularMarketVolume',
    'marketCap',
    'currency',
    'regularMarketDayHigh',
    'regularMarketDayLow',
    'regularMarketOpen',
    'regularMarketPreviousClose',
    'averageDailyVolume10Day',
    'averageDailyVolume3Month',
    'fiftyDayAverage',
    'twoHundredDayAverage',
    'fiftyTwoWeekHigh',
    'fiftyTwoWeekLow',
    'trailingPE',
    'marketState',
    'exchange',
    'exchangeName'
];

const YF_BATCH_SIZE = Number(process.env.YF_BATCH_SIZE || 8);
const YF_REQUEST_DELAY_MS = Number(process.env.YF_REQUEST_DELAY_MS || 150);
const YF_QUOTE_TIMEOUT_MS = Number(process.env.YF_QUOTE_TIMEOUT_MS || 8000);
const STOCK_FETCH_TIMEOUT_MS = Number(process.env.STOCK_FETCH_TIMEOUT_MS || 25000);

// Middleware
app.use(cors());
app.use(express.json());

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSymbol(rawSymbol) {
    const symbol = (rawSymbol || '').toString().trim().toUpperCase();
    if (!symbol) return '';
    return symbol.includes('.') ? symbol : `${symbol}.JK`;
}

function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function formatStock(stock, includeFullData = false) {
    if (!stock || !stock.symbol) return null;

    const price = toNumber(stock.regularMarketPrice);
    const dayHigh = toNumber(stock.regularMarketDayHigh, price);
    const dayLow = toNumber(stock.regularMarketDayLow, price);
    const volume = toNumber(stock.regularMarketVolume);
    const avgVolume = toNumber(stock.averageDailyVolume10Day, toNumber(stock.averageDailyVolume3Month, volume));

    const formatted = {
        symbol: stock.symbol,
        name: stock.shortName || stock.longName || stock.symbol,
        price,
        change: toNumber(stock.regularMarketChange),
        changePercent: toNumber(stock.regularMarketChangePercent),
        volume,
        marketCap: toNumber(stock.marketCap),
        currency: stock.currency || 'IDR',
        lastUpdated: new Date().toISOString(),
        dayHigh,
        dayLow,
        open: toNumber(stock.regularMarketOpen, price),
        previousClose: toNumber(stock.regularMarketPreviousClose, price),
        averageDailyVolume10Day: avgVolume,
        averageDailyVolume3Month: toNumber(stock.averageDailyVolume3Month, avgVolume),
        fiftyDayAverage: toNumber(stock.fiftyDayAverage, price),
        twoHundredDayAverage: toNumber(stock.twoHundredDayAverage, price),
        fiftyTwoWeekHigh: toNumber(stock.fiftyTwoWeekHigh, dayHigh),
        fiftyTwoWeekLow: toNumber(stock.fiftyTwoWeekLow, dayLow),
        trailingPE: toNumber(stock.trailingPE, null),
        marketState: stock.marketState || null,
        exchange: stock.exchange || null,
        exchangeName: stock.exchangeName || null
    };

    if (includeFullData) {
        formatted.fullData = stock;
    }

    return formatted;
}

async function fetchQuoteWithTimeout(symbol, attempts = 2) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const quotePromise = yahooFinance.quote(
                symbol,
                { fields: QUOTE_FIELDS },
                { validateResult: false }
            );
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Yahoo Finance timeout for ${symbol}`)), YF_QUOTE_TIMEOUT_MS);
            });

            const stock = await Promise.race([quotePromise, timeoutPromise]);
            if (!stock || !stock.symbol) {
                throw new Error(`Yahoo Finance returned empty data for ${symbol}`);
            }
            return stock;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                await sleep(300 * attempt);
            }
        }
    }

    throw lastError;
}

// Fungsi untuk mengambil semua kode saham dari file lokal
function getAllIDXStockCodes() {
    try {
        const candidates = [
            path.join(__dirname, 'resource', 'stockcode.csv'),
            path.join(process.cwd(), 'resource', 'stockcode.csv'),
            path.resolve('resource', 'stockcode.csv')
        ];

        let csvPathFound = null;
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                csvPathFound = p;
                break;
            }
        }

        if (!csvPathFound) {
            throw new Error(`stockcode.csv not found in any candidate paths: ${candidates.join(', ')}`);
        }

        console.log('CSV Path found:', csvPathFound);
        const csvText = fs.readFileSync(csvPathFound, 'utf8');
        const records = parse(csvText, { columns: true, skip_empty_lines: true });
        const symbols = records
            .map(rec => normalizeSymbol(rec.Code))
            .filter(Boolean);

        const uniqueSymbols = [...new Set(symbols)];
        console.log('Records loaded:', records.length, 'Unique symbols:', uniqueSymbols.length);
        return uniqueSymbols;
    } catch (error) {
        console.error('Error reading CSV:', error && error.message ? error.message : error);
        return [];
    }
}

// Fungsi untuk mengambil data saham dengan fetching yang tahan error Yahoo Finance
async function getStockData() {
    try {
        console.log('Mengambil data saham dari Yahoo Finance...');
        const allStocks = getAllIDXStockCodes();
        console.log('All IDX_STOCKS count:', allStocks.length);

        if (allStocks.length === 0) {
            console.error('No stock codes loaded from CSV');
            return [];
        }

        const batchSize = Math.max(1, YF_BATCH_SIZE);
        const batches = [];
        for (let i = 0; i < allStocks.length; i += batchSize) {
            batches.push(allStocks.slice(i, i + batchSize));
        }

        console.log(`Fetching ${allStocks.length} symbols in ${batches.length} batches of up to ${batchSize}`);

        const allResults = [];
        const failedSymbols = [];

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            console.log(`Fetching batch ${i + 1}/${batches.length}: ${batch.join(', ')}`);

            const settled = await Promise.allSettled(batch.map(symbol => fetchQuoteWithTimeout(symbol)));

            settled.forEach((result, index) => {
                const symbol = batch[index];
                if (result.status === 'fulfilled') {
                    const formatted = formatStock(result.value);
                    if (formatted && formatted.price > 0) {
                        allResults.push(formatted);
                    } else {
                        failedSymbols.push({ symbol, error: 'Invalid or zero price returned' });
                    }
                } else {
                    failedSymbols.push({ symbol, error: result.reason?.message || String(result.reason) });
                    console.error(`[YAHOO] Failed ${symbol}:`, result.reason?.message || result.reason);
                }
            });

            if (i < batches.length - 1) {
                await sleep(YF_REQUEST_DELAY_MS);
            }
        }

        console.log('Total formatted results count:', allResults.length);
        if (failedSymbols.length > 0) {
            console.warn(`[YAHOO] ${failedSymbols.length} symbols failed:`, failedSymbols.slice(0, 10));
        }

        return allResults;
    } catch (error) {
        console.error('Error fetching data:', error.message);
        console.error('Error stack:', error.stack);
        throw error;
    }
}

// Tambahkan cache dan waktu update
let cachedStocks = [];
let lastUpdate = null;

// Detect serverless environment (Vercel/Now)
const isServerless = !!process.env.VERCEL || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// Fungsi untuk refresh cache
async function refreshStockCache() {
    try {
        const nextStocks = await getStockData();
        if (nextStocks.length > 0) {
            cachedStocks = nextStocks;
            lastUpdate = new Date();
            console.log(`[CACHE] Data saham di-refresh pada ${lastUpdate.toLocaleTimeString()}`);
        } else {
            console.warn('[CACHE] Yahoo Finance returned 0 valid stocks. Existing cache is kept.');
        }
    } catch (err) {
        console.error('[CACHE] Gagal refresh data saham:', err.message);
    }
}

// Refresh pertama saat server start
if (!isServerless) {
    refreshStockCache();
    setInterval(refreshStockCache, 60 * 1000);
} else {
    console.log('[INFO] Running in serverless mode — cache will be refreshed per-request');
}

// Routes
app.get('/', (req, res) => {
    res.json({
        message: 'IDX Stock Market API',
        endpoints: {
            allStocks: '/api/stocks',
            singleStock: '/api/stocks/:symbol',
            marketSummary: '/api/summary',
            health: '/api/health',
            debugCsv: '/api/debug/csv'
        },
        documentation: 'Gunakan endpoint di atas untuk mendapatkan data saham IDX'
    });
});

// Get all stocks
app.get('/api/stocks', async (req, res) => {
    try {
        if (isServerless) {
            console.log('[API] Serverless request — fetching stock data on-demand');
            try {
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), STOCK_FETCH_TIMEOUT_MS));
                const data = await Promise.race([getStockData(), timeoutPromise]);

                if (!data.length && cachedStocks.length > 0) {
                    return res.json({
                        success: true,
                        stale: true,
                        count: cachedStocks.length,
                        data: cachedStocks,
                        lastUpdate,
                        timestamp: new Date().toISOString(),
                        message: 'Yahoo Finance returned no fresh data; stale cache returned.'
                    });
                }

                if (data.length > 0) {
                    cachedStocks = data;
                    lastUpdate = new Date();
                }

                return res.json({ success: true, count: data.length, data, lastUpdate: new Date().toISOString(), timestamp: new Date().toISOString() });
            } catch (err) {
                console.error('[API] On-demand fetch failed:', err && err.message ? err.message : err);

                if (cachedStocks.length > 0) {
                    return res.json({
                        success: true,
                        stale: true,
                        count: cachedStocks.length,
                        data: cachedStocks,
                        lastUpdate,
                        timestamp: new Date().toISOString(),
                        warning: err.message || String(err)
                    });
                }

                return res.status(502).json({ success: false, message: 'Failed to fetch stock data from Yahoo Finance', error: err.message || String(err) });
            }
        }

        const now = new Date();
        const isCacheEmpty = cachedStocks.length === 0;
        const isCacheStale = lastUpdate && (now - lastUpdate) > 5 * 60 * 1000;

        if (isCacheEmpty || isCacheStale) {
            console.log('[API] Cache is empty or stale, refreshing...');
            const refreshPromise = refreshStockCache();
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Refresh timeout')), 15000));

            try {
                await Promise.race([refreshPromise, timeoutPromise]);
            } catch (refreshError) {
                console.error('[API] Refresh failed or timed out:', refreshError && refreshError.message ? refreshError.message : refreshError);
            }
        }

        res.json({ success: true, count: cachedStocks.length, data: cachedStocks, lastUpdate, timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('[API] Error in /api/stocks:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error fetching stock data',
            error: error.message
        });
    }
});

// Diagnostic endpoint to check CSV reading on the deployed environment
app.get('/api/debug/csv', (req, res) => {
    try {
        const candidates = [
            path.join(__dirname, 'resource', 'stockcode.csv'),
            path.join(process.cwd(), 'resource', 'stockcode.csv'),
            path.resolve('resource', 'stockcode.csv')
        ];

        const found = candidates.find(p => fs.existsSync(p));
        if (!found) return res.status(404).json({ success: false, message: 'stockcode.csv not found', candidates });

        const csvText = fs.readFileSync(found, 'utf8');
        const records = parse(csvText, { columns: true, skip_empty_lines: true });
        res.json({ success: true, path: found, count: records.length, sample: records.slice(0, 5), symbols: getAllIDXStockCodes().slice(0, 10) });
    } catch (err) {
        res.status(500).json({ success: false, error: err && err.message ? err.message : String(err) });
    }
});

// Get single stock by symbol
app.get('/api/stocks/:symbol', async (req, res) => {
    try {
        const formattedSymbol = normalizeSymbol(req.params.symbol);
        if (!formattedSymbol) {
            return res.status(400).json({ success: false, message: 'Symbol tidak valid' });
        }

        const stock = await fetchQuoteWithTimeout(formattedSymbol);
        const formattedData = formatStock(stock, true);

        if (!formattedData || formattedData.price <= 0) {
            return res.status(404).json({ success: false, message: 'Saham tidak ditemukan atau harga kosong', symbol: formattedSymbol });
        }

        res.json({
            success: true,
            data: formattedData
        });
    } catch (error) {
        console.error(`[API] Error in /api/stocks/${req.params.symbol}:`, error.message);
        res.status(404).json({
            success: false,
            message: 'Saham tidak ditemukan',
            error: error.message
        });
    }
});

// Get market summary
app.get('/api/summary', (req, res) => {
    const stocks = cachedStocks;
    const summary = {
        totalStocks: stocks.length,
        totalMarketCap: stocks.reduce((sum, stock) => sum + (stock.marketCap || 0), 0),
        gainers: stocks.filter(stock => stock.change > 0).length,
        losers: stocks.filter(stock => stock.change < 0).length,
        unchanged: stocks.filter(stock => stock.change === 0).length,
        topGainers: stocks.filter(stock => stock.change > 0)
                        .sort((a, b) => b.changePercent - a.changePercent)
                        .slice(0, 5),
        topLosers: stocks.filter(stock => stock.change < 0)
                        .sort((a, b) => a.changePercent - b.changePercent)
                        .slice(0, 5),
        mostActive: stocks.slice().sort((a, b) => b.volume - a.volume).slice(0, 5),
        lastUpdate,
        timestamp: new Date().toISOString()
    };
    res.json({
        success: true,
        data: summary
    });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        cachedStocks: cachedStocks.length,
        lastUpdate,
        isServerless
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error(error.stack);
    res.status(500).json({
        success: false,
        message: 'Terjadi kesalahan internal server',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Endpoint tidak ditemukan'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
    console.log('📊 API Stock IDX siap digunakan');
    console.log(`📍 Endpoint: http://localhost:${PORT}/api/stocks`);
});