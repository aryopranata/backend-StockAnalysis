# TODO: Fix IDX Stock API Deployment Issue

## Steps to Complete
- [x] Limit IDX_STOCKS to first 10 codes for testing to avoid timeouts on Vercel
- [x] Add more error logging in getStockData function
- [x] Modify /api/stocks endpoint to check if cache is empty and attempt a refresh with timeout
- [x] Revert to fetch all 956 stocks but implement batch fetching to avoid timeouts
- [ ] Redeploy to Vercel and test the API endpoint
