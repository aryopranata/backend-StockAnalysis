const express = require('express');
const cors = require('cors');
const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;

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

const DEFAULT_SERVERLESS_SYMBOLS = (process.env.DEFAULT_STOCK_SYMBOLS || [
    'BBCA', 'BBRI', 'BMRI', 'TLKM', 'ASII', 'BBNI', 'UNVR', 'ICBP', 'INDF', 'AMMN',
    'ADRO', 'ANTM', 'BRIS', 'CPIN', 'GOTO', 'MDKA', 'MEDC', 'PGAS', 'PTBA', 'SMGR',
    'TPIA', 'UNTR', 'AKRA', 'ARTO', 'BRPT', 'EMTK', 'EXCL', 'INCO', 'INKP', 'ISAT',
    'KLBF', 'MAPI', 'MBMA', 'PGEO', 'SIDO', 'SRTG', 'ACES', 'BTPS', 'ERAA', 'ESSA'
].join(',')).split(',').map(s => s.trim()).filter(Boolean);

// Vercel/serverless must finish quickly. Use Yahoo bulk quote first, then split only failed batches.
const YF_BATCH_SIZE = Number(process.env.YF_BATCH_SIZE || 20);
const YF_REQUEST_DELAY_MS = Number(process.env.YF_REQUEST_DELAY_MS || 25);
const YF_SINGLE_QUOTE_TIMEOUT_MS = Number(process.env.YF_SINGLE_QUOTE_TIMEOUT_MS || 5000);
const YF_BATCH_QUOTE_TIMEOUT_MS = Number(process.env.YF_BATCH_QUOTE_TIMEOUT_MS || 7000);
const STOCK_FETCH_TIMEOUT_MS = Number(process.env.STOCK_FETCH_TIMEOUT_MS || 9000);

app.use(cors());
app.use(express.json());

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
    ]);
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

    if (includeFullData) formatted.fullData = stock;
    return formatted;
}

async function fetchSingleQuote(symbol, attempts = 2) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const quotePromise = yahooFinance.quote(symbol);
            const stock = await withTimeout(quotePromise, YF_SINGLE_QUOTE_TIMEOUT_MS, `Yahoo Finance timeout for ${symbol}`);

            if (!stock || !stock.symbol) throw new Error(`Yahoo Finance returned empty data for ${symbol}`);
            return stock;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await sleep(200 * attempt);
        }
    }

    throw lastError;
}

async function fetchQuoteBatch(symbols, depth = 0) {
    const cleanedSymbols = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
    if (cleanedSymbols.length === 0) return [];

    if (cleanedSymbols.length === 1) {
        try {
            return [await fetchSingleQuote(cleanedSymbols[0])];
        } catch (error) {
            console.error(`[YAHOO] Failed single ${cleanedSymbols[0]}:`, error.message);
            return [];
        }
    }

    try {
        const quotePromise = yahooFinance.quote(cleanedSymbols);
        const result = await withTimeout(quotePromise, YF_BATCH_QUOTE_TIMEOUT_MS, `Yahoo Finance batch timeout for ${cleanedSymbols.length} symbols`);
        const quotes = Array.isArray(result) ? result : [result];
        return quotes.filter(quote => quote && quote.symbol);
    } catch (error) {
        console.warn(`[YAHOO] Batch failed at depth ${depth} (${cleanedSymbols.length} symbols):`, error.message);

        if (depth >= 2) {
            // Stop deep recursion on Vercel; return whatever can be fetched quickly as singles.
            const settled = await Promise.allSettled(cleanedSymbols.map(symbol => fetchSingleQuote(symbol, 1)));
            return settled
                .filter(result => result.status === 'fulfilled')
                .map(result => result.value)
                .filter(quote => quote && quote.symbol);
        }

        const mid = Math.ceil(cleanedSymbols.length / 2);
        const left = cleanedSymbols.slice(0, mid);
        const right = cleanedSymbols.slice(mid);
        const [leftQuotes, rightQuotes] = await Promise.all([fetchQuoteBatch(left, depth + 1), fetchQuoteBatch(right, depth + 1)]);
        return [...leftQuotes, ...rightQuotes];
    }
}

function getAllIDXStockCodes() {
    try {
        const candidates = [
            path.join(__dirname, 'resource', 'stockcode.csv'),
            path.join(process.cwd(), 'resource', 'stockcode.csv'),
            path.resolve('resource', 'stockcode.csv')
        ];

        const csvPathFound = candidates.find(p => fs.existsSync(p));
        if (!csvPathFound) throw new Error(`stockcode.csv not found in any candidate paths: ${candidates.join(', ')}`);

        const csvText = fs.readFileSync(csvPathFound, 'utf8');
        const records = parse(csvText, { columns: true, skip_empty_lines: true });
        const symbols = records.map(rec => normalizeSymbol(rec.Code)).filter(Boolean);
        return [...new Set(symbols)];
    } catch (error) {
        console.error('Error reading CSV:', error.message || error);
        return [];
    }
}

async function getStockData(symbolsOverride = null) {
    try {
        const allStocks = symbolsOverride && symbolsOverride.length ? symbolsOverride.map(normalizeSymbol).filter(Boolean) : getAllIDXStockCodes();
        if (allStocks.length === 0) return [];

        const batches = [];
        for (let i = 0; i < allStocks.length; i += YF_BATCH_SIZE) batches.push(allStocks.slice(i, i + YF_BATCH_SIZE));

        const allResults = [];
        for (let i = 0; i < batches.length; i++) {
            const quotes = await fetchQuoteBatch(batches[i]);
            for (const quote of quotes) {
                const formatted = formatStock(quote);
                if (formatted && formatted.price > 0) allResults.push(formatted);
            }
            if (i < batches.length - 1) await sleep(YF_REQUEST_DELAY_MS);
        }

        return [...new Map(allResults.map(stock => [stock.symbol, stock])).values()];
    } catch (error) {
        console.error('Error fetching data:', error.message);
        throw error;
    }
}

let cachedStocks = [];
let lastUpdate = null;
const isServerless = !!process.env.VERCEL || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

async function refreshStockCache() {
    try {
        const source = isServerless ? DEFAULT_SERVERLESS_SYMBOLS : getAllIDXStockCodes();
        const nextStocks = await getStockData(source);
        if (nextStocks.length > 0) {
            cachedStocks = nextStocks;
            lastUpdate = new Date();
            console.log(`[CACHE] Data saham di-refresh pada ${lastUpdate.toLocaleTimeString()}`);
        }
    } catch (err) {
        console.error('[CACHE] Gagal refresh data saham:', err.message);
    }
}

if (!isServerless) {
    refreshStockCache();
    setInterval(refreshStockCache, 60 * 1000);
} else {
    console.log('[INFO] Running in serverless mode — default /api/stocks uses liquid symbols only. Use ?all=true for full CSV.');
}

app.get('/', (req, res) => {
    res.json({
        message: 'IDX Stock Market API',
        endpoints: {
            allStocks: '/api/stocks',
            fullCsv: '/api/stocks?all=true',
            customSymbols: '/api/stocks?symbols=BBCA,BBRI,TLKM',
            singleStock: '/api/stocks/:symbol',
            marketSummary: '/api/summary',
            health: '/api/health',
            debugCsv: '/api/debug/csv',
            debugYahoo: '/api/debug/yahoo/:symbol'
        }
    });
});

app.get('/api/stocks', async (req, res) => {
    try {
        const requestedSymbols = req.query.symbols ? String(req.query.symbols).split(',').map(s => s.trim()).filter(Boolean) : null;
        const requestedLimit = Number(req.query.limit || 0);
        const wantsFullCsv = String(req.query.all || '').toLowerCase() === 'true';

        let sourceSymbols;
        if (requestedSymbols) {
            sourceSymbols = requestedSymbols;
        } else if (isServerless && !wantsFullCsv) {
            sourceSymbols = DEFAULT_SERVERLESS_SYMBOLS;
        } else {
            sourceSymbols = getAllIDXStockCodes();
        }

        const symbolsToFetch = requestedLimit > 0 ? sourceSymbols.slice(0, requestedLimit) : sourceSymbols;

        if (isServerless) {
            try {
                const data = await withTimeout(getStockData(symbolsToFetch), STOCK_FETCH_TIMEOUT_MS, 'Fetch timeout');

                if (data.length > 0 && !requestedSymbols && !wantsFullCsv) {
                    cachedStocks = data;
                    lastUpdate = new Date();
                }

                return res.json({
                    success: true,
                    count: data.length,
                    mode: wantsFullCsv ? 'full-csv' : requestedSymbols ? 'custom-symbols' : 'default-liquid-symbols',
                    symbolsRequested: symbolsToFetch.length,
                    data,
                    lastUpdate: new Date().toISOString(),
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                console.error('[API] On-demand fetch failed:', err.message || err);

                if (cachedStocks.length > 0) {
                    return res.json({
                        success: true,
                        stale: true,
                        count: cachedStocks.length,
                        mode: 'stale-cache',
                        data: cachedStocks,
                        lastUpdate,
                        timestamp: new Date().toISOString(),
                        warning: err.message || String(err)
                    });
                }

                return res.status(502).json({ success: false, message: 'Failed to fetch stock data from Yahoo Finance', error: err.message || String(err) });
            }
        }

        if (requestedSymbols || requestedLimit || wantsFullCsv) {
            const data = await getStockData(symbolsToFetch);
            return res.json({ success: true, count: data.length, symbolsRequested: symbolsToFetch.length, data, lastUpdate: new Date().toISOString(), timestamp: new Date().toISOString() });
        }

        const now = new Date();
        const isCacheEmpty = cachedStocks.length === 0;
        const isCacheStale = lastUpdate && (now - lastUpdate) > 5 * 60 * 1000;
        if (isCacheEmpty || isCacheStale) {
            try {
                await withTimeout(refreshStockCache(), 9000, 'Refresh timeout');
            } catch (refreshError) {
                console.error('[API] Refresh failed or timed out:', refreshError.message || refreshError);
            }
        }

        res.json({ success: true, count: cachedStocks.length, mode: 'cache', data: cachedStocks, lastUpdate, timestamp: new Date().toISOString() });
    } catch (error) {
        console.error('[API] Error in /api/stocks:', error.message);
        res.status(500).json({ success: false, message: 'Error fetching stock data', error: error.message });
    }
});

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
        res.json({ success: true, path: found, count: records.length, sample: records.slice(0, 5), defaultServerlessSymbols: DEFAULT_SERVERLESS_SYMBOLS, allSymbolsSample: getAllIDXStockCodes().slice(0, 10) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

app.get('/api/debug/yahoo/:symbol', async (req, res) => {
    try {
        const formattedSymbol = normalizeSymbol(req.params.symbol);
        const quote = await fetchSingleQuote(formattedSymbol);
        res.json({ success: true, symbol: formattedSymbol, data: formatStock(quote, true) });
    } catch (error) {
        res.status(502).json({ success: false, symbol: normalizeSymbol(req.params.symbol), error: error.message || String(error) });
    }
});

app.get('/api/stocks/:symbol', async (req, res) => {
    try {
        const formattedSymbol = normalizeSymbol(req.params.symbol);
        if (!formattedSymbol) return res.status(400).json({ success: false, message: 'Symbol tidak valid' });

        const stock = await fetchSingleQuote(formattedSymbol);
        const formattedData = formatStock(stock, true);
        if (!formattedData || formattedData.price <= 0) return res.status(404).json({ success: false, message: 'Saham tidak ditemukan atau harga kosong', symbol: formattedSymbol });

        res.json({ success: true, data: formattedData });
    } catch (error) {
        console.error(`[API] Error in /api/stocks/${req.params.symbol}:`, error.message);
        res.status(404).json({ success: false, message: 'Saham tidak ditemukan', error: error.message });
    }
});

app.get('/api/summary', (req, res) => {
    const stocks = cachedStocks;
    const summary = {
        totalStocks: stocks.length,
        totalMarketCap: stocks.reduce((sum, stock) => sum + (stock.marketCap || 0), 0),
        gainers: stocks.filter(stock => stock.change > 0).length,
        losers: stocks.filter(stock => stock.change < 0).length,
        unchanged: stocks.filter(stock => stock.change === 0).length,
        topGainers: stocks.filter(stock => stock.change > 0).sort((a, b) => b.changePercent - a.changePercent).slice(0, 5),
        topLosers: stocks.filter(stock => stock.change < 0).sort((a, b) => a.changePercent - b.changePercent).slice(0, 5),
        mostActive: stocks.slice().sort((a, b) => b.volume - a.volume).slice(0, 5),
        lastUpdate,
        timestamp: new Date().toISOString()
    };
    res.json({ success: true, data: summary });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        cachedStocks: cachedStocks.length,
        lastUpdate,
        isServerless,
        defaultServerlessSymbols: DEFAULT_SERVERLESS_SYMBOLS.length,
        config: { YF_BATCH_SIZE, YF_BATCH_QUOTE_TIMEOUT_MS, STOCK_FETCH_TIMEOUT_MS }
    });
});

app.use((error, req, res, next) => {
    console.error(error.stack);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan internal server', error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error' });
});

app.use('*', (req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
});

app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
    console.log('📊 API Stock IDX siap digunakan');
    console.log(`📍 Endpoint: http://localhost:${PORT}/api/stocks`);
});
