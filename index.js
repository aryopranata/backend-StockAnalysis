const express = require('express');
const cors = require('cors');
const axios = require('axios');
const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const app = express();
const PORT = process.env.PORT || 3000;
const isServerless = !!process.env.VERCEL || !!process.env.NOW_REGION || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

const DEFAULT_SERVERLESS_SYMBOLS = (process.env.DEFAULT_STOCK_SYMBOLS || 'BBCA,BBRI,BMRI,TLKM,ASII,BBNI,AMMN,ADRO,ANTM,GOTO,UNTR,MDKA')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const YF_BATCH_SIZE = Number(process.env.YF_BATCH_SIZE || 4);
const YF_REQUEST_DELAY_MS = Number(process.env.YF_REQUEST_DELAY_MS || 150);
const YF_SINGLE_QUOTE_TIMEOUT_MS = Number(process.env.YF_SINGLE_QUOTE_TIMEOUT_MS || 5000);
const STOCK_FETCH_TIMEOUT_MS = Number(process.env.STOCK_FETCH_TIMEOUT_MS || 12000);

let cachedStocks = [];
let lastUpdate = null;

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

function pickLastNumber(values, fallback = 0) {
    if (!Array.isArray(values)) return fallback;
    for (let i = values.length - 1; i >= 0; i--) {
        const value = Number(values[i]);
        if (Number.isFinite(value)) return value;
    }
    return fallback;
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
        exchangeName: stock.exchangeName || null,
        source: stock.source || 'yahoo'
    };
    if (includeFullData) formatted.fullData = stock;
    return formatted;
}

function chartToQuote(symbol, payload) {
    const result = payload?.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo chart returned empty data for ${symbol}`);
    const meta = result.meta || {};
    const q = result.indicators?.quote?.[0] || {};
    const close = pickLastNumber(q.close, toNumber(meta.regularMarketPrice));
    const open = pickLastNumber(q.open, close);
    const high = pickLastNumber(q.high, close);
    const low = pickLastNumber(q.low, close);
    const volume = pickLastNumber(q.volume, 0);
    const previousClose = toNumber(meta.previousClose, toNumber(meta.chartPreviousClose, close));
    const change = close - previousClose;
    const changePercent = previousClose ? (change / previousClose) * 100 : 0;
    return {
        symbol: meta.symbol || symbol,
        shortName: meta.symbol || symbol,
        longName: meta.symbol || symbol,
        regularMarketPrice: close,
        regularMarketChange: change,
        regularMarketChangePercent: changePercent,
        regularMarketVolume: volume,
        marketCap: 0,
        currency: meta.currency || 'IDR',
        regularMarketDayHigh: high,
        regularMarketDayLow: low,
        regularMarketOpen: open,
        regularMarketPreviousClose: previousClose,
        averageDailyVolume10Day: volume,
        averageDailyVolume3Month: volume,
        fiftyDayAverage: close,
        twoHundredDayAverage: close,
        fiftyTwoWeekHigh: high,
        fiftyTwoWeekLow: low,
        trailingPE: null,
        marketState: meta.marketState || null,
        exchange: meta.exchangeName || null,
        exchangeName: meta.exchangeName || null,
        source: 'yahoo-chart'
    };
}

async function fetchYahooChartQuote(symbol) {
    const normalized = normalizeSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}?range=5d&interval=1d`;
    const response = await axios.get(url, {
        timeout: YF_SINGLE_QUOTE_TIMEOUT_MS,
        responseType: 'json',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
            'Accept': 'application/json,text/plain,*/*',
            'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
            'Cache-Control': 'no-cache'
        },
        validateStatus: status => status >= 200 && status < 500
    });
    if (response.status === 429) throw new Error(`Yahoo chart rate limited ${normalized}`);
    if (response.status >= 400) throw new Error(`Yahoo chart HTTP ${response.status} for ${normalized}`);
    return chartToQuote(normalized, response.data);
}

async function fetchSingleQuote(symbol, attempts = 2) {
    const normalized = normalizeSymbol(symbol);
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fetchYahooChartQuote(normalized);
        } catch (chartError) {
            lastError = chartError;
            try {
                const stock = await withTimeout(yahooFinance.quote(normalized), YF_SINGLE_QUOTE_TIMEOUT_MS, `Yahoo Finance timeout for ${normalized}`);
                if (stock && stock.symbol) return { ...stock, source: 'yahoo-finance2' };
            } catch (quoteError) {
                lastError = quoteError;
            }
            if (attempt < attempts) await sleep(300 * attempt);
        }
    }
    throw lastError;
}

async function fetchQuoteBatch(symbols) {
    const cleanedSymbols = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
    const settled = await Promise.allSettled(cleanedSymbols.map(symbol => fetchSingleQuote(symbol, 1)));
    return settled.filter(r => r.status === 'fulfilled').map(r => r.value).filter(q => q && q.symbol);
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
        return [...new Set(records.map(rec => normalizeSymbol(rec.Code)).filter(Boolean))];
    } catch (error) {
        console.error('Error reading CSV:', error.message || error);
        return [];
    }
}

async function getStockData(symbolsOverride = null) {
    const allStocks = symbolsOverride && symbolsOverride.length ? symbolsOverride.map(normalizeSymbol).filter(Boolean) : getAllIDXStockCodes();
    if (allStocks.length === 0) return [];
    const allResults = [];
    for (let i = 0; i < allStocks.length; i += YF_BATCH_SIZE) {
        const quotes = await fetchQuoteBatch(allStocks.slice(i, i + YF_BATCH_SIZE));
        for (const quote of quotes) {
            const formatted = formatStock(quote);
            if (formatted && formatted.price > 0) allResults.push(formatted);
        }
        if (i + YF_BATCH_SIZE < allStocks.length) await sleep(YF_REQUEST_DELAY_MS);
    }
    return [...new Map(allResults.map(stock => [stock.symbol, stock])).values()];
}

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
        if (requestedSymbols) sourceSymbols = requestedSymbols;
        else if (isServerless && !wantsFullCsv) sourceSymbols = DEFAULT_SERVERLESS_SYMBOLS;
        else sourceSymbols = getAllIDXStockCodes();
        const symbolsToFetch = requestedLimit > 0 ? sourceSymbols.slice(0, requestedLimit) : sourceSymbols;
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
        console.error('[API] fetch failed:', err.message || err);
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
});

app.get('/api/debug/csv', (req, res) => {
    try {
        const allSymbols = getAllIDXStockCodes();
        res.json({ success: true, count: allSymbols.length, defaultServerlessSymbols: DEFAULT_SERVERLESS_SYMBOLS, allSymbolsSample: allSymbols.slice(0, 10) });
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
    res.json({
        success: true,
        data: {
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
        }
    });
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
        config: { YF_BATCH_SIZE, YF_REQUEST_DELAY_MS, STOCK_FETCH_TIMEOUT_MS }
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
