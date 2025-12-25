const express = require('express');
const cors = require('cors');
const yahooFinance = require('yahoo-finance2').default;
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync'); // install: npm i csv-parse

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Fungsi untuk mengambil semua kode saham dari file lokal
function getAllIDXStockCodes() {
    try {
        // Try several possible locations so this works in local and serverless deployments
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
        console.log('Records loaded:', records.length);
        return records.map(rec => (rec.Code || '').toString().trim()).filter(Boolean).map(code => `${code}.JK`);
    } catch (error) {
        console.error('Error reading CSV:', error && error.message ? error.message : error);
        // Re-throw for serverless environments so the error is visible in logs
        return [];
    }
}

// Fungsi untuk mengambil data saham dengan batch fetching
async function getStockData() {
    try {
        console.log('Mengambil data saham dari Yahoo Finance...');
        const allStocks = getAllIDXStockCodes(); // <-- dinamis
        console.log('All IDX_STOCKS count:', allStocks.length); // Debug log
        if (allStocks.length === 0) {
            console.error('No stock codes loaded from CSV');
            return [];
        }

        // Fetch in batches to avoid timeouts
        const batchSize = 50; // Fetch 50 stocks at a time
        const batches = [];
        for (let i = 0; i < allStocks.length; i += batchSize) {
            batches.push(allStocks.slice(i, i + batchSize));
        }

        console.log(`Fetching in ${batches.length} batches of up to ${batchSize} stocks each`);

        const allResults = [];
        for (let i = 0; i < batches.length; i++) {
            console.log(`Fetching batch ${i + 1}/${batches.length}...`);
            try {
                const batchResults = await yahooFinance.quote(batches[i]);
                allResults.push(...batchResults);
                console.log(`Batch ${i + 1} fetched: ${batchResults.length} stocks`);
                // Small delay between batches to be respectful to the API
                if (i < batches.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (batchError) {
                console.error(`Error fetching batch ${i + 1}:`, batchError.message);
                // Continue with other batches even if one fails
            }
        }

        console.log('Total fetched results count:', allResults.length); // Debug log
        const formattedData = allResults.map(stock => ({
            symbol: stock.symbol,
            name: stock.shortName || stock.longName || 'N/A',
            price: stock.regularMarketPrice || 0,
            change: stock.regularMarketChange || 0,
            changePercent: stock.regularMarketChangePercent || 0,
            volume: stock.regularMarketVolume || 0,
            marketCap: stock.marketCap || 0,
            currency: stock.currency || 'IDR',
            lastUpdated: new Date().toISOString(),
            dayHigh: stock.regularMarketDayHigh || 0,
            dayLow: stock.regularMarketDayLow || 0,
            open: stock.regularMarketOpen || 0,
            previousClose: stock.regularMarketPreviousClose || 0
        }));
        console.log('Formatted data count:', formattedData.length); // Debug log
        return formattedData;
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
        cachedStocks = await getStockData();
        lastUpdate = new Date();
        console.log(`[CACHE] Data saham di-refresh pada ${lastUpdate.toLocaleTimeString()}`);
    } catch (err) {
        console.error('[CACHE] Gagal refresh data saham:', err.message);
    }
}

// Refresh pertama saat server start
if (!isServerless) {
    // For normal server (local), keep background cache refresh
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
            marketSummary: '/api/summary'
        },
        documentation: 'Gunakan endpoint di atas untuk mendapatkan data saham IDX'
    });
});

// Get all stocks
app.get('/api/stocks', async (req, res) => {
    try {
        // In serverless environments we fetch on-demand to avoid relying on background timers
        if (isServerless) {
            console.log('[API] Serverless request — fetching stock data on-demand');
            try {
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Fetch timeout')), 20000));
                const data = await Promise.race([getStockData(), timeoutPromise]);
                return res.json({ success: true, count: data.length, data, lastUpdate: new Date().toISOString(), timestamp: new Date().toISOString() });
            } catch (err) {
                console.error('[API] On-demand fetch failed:', err && err.message ? err.message : err);
                return res.status(500).json({ success: false, message: 'Failed to fetch stock data', error: err.message || String(err) });
            }
        }

        // Non-serverless: use cached data
        const now = new Date();
        const isCacheEmpty = cachedStocks.length === 0;
        const isCacheStale = lastUpdate && (now - lastUpdate) > 5 * 60 * 1000; // 5 minutes

        if (isCacheEmpty || isCacheStale) {
            console.log('[API] Cache is empty or stale, refreshing...');
            // Attempt to refresh with a timeout to prevent hanging
            const refreshPromise = refreshStockCache();
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Refresh timeout')), 10000));

            try {
                await Promise.race([refreshPromise, timeoutPromise]);
            } catch (refreshError) {
                console.error('[API] Refresh failed or timed out:', refreshError && refreshError.message ? refreshError.message : refreshError);
                // Continue with empty cache if refresh fails
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
        res.json({ success: true, path: found, count: records.length, sample: records.slice(0, 5) });
    } catch (err) {
        res.status(500).json({ success: false, error: err && err.message ? err.message : String(err) });
    }
});

// Get single stock by symbol
app.get('/api/stocks/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        
        // Pastikan symbol memiliki .JK
        const formattedSymbol = symbol.includes('.') ? symbol : `${symbol}.JK`;
        
        const stock = await yahooFinance.quote(formattedSymbol);
        
        const formattedData = {
            symbol: stock.symbol,
            name: stock.shortName || stock.longName || 'N/A',
            price: stock.regularMarketPrice || 0,
            change: stock.regularMarketChange || 0,
            changePercent: stock.regularMarketChangePercent || 0,
            volume: stock.regularMarketVolume || 0,
            marketCap: stock.marketCap || 0,
            currency: stock.currency || 'IDR',
            lastUpdated: new Date().toISOString(),
            dayHigh: stock.regularMarketDayHigh || 0,
            dayLow: stock.regularMarketDayLow || 0,
            open: stock.regularMarketOpen || 0,
            previousClose: stock.regularMarketPreviousClose || 0,
            fullData: stock
        };
        
        res.json({
            success: true,
            data: formattedData
        });
    } catch (error) {
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
        uptime: process.uptime()
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
    console.log(`📊 API Stock IDX siap digunakan`);
    console.log(`📍 Endpoint: http://localhost:${PORT}/api/stocks`);
});