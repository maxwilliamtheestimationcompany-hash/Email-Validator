# Email Validator Advanced v6.4 — Validect RapidAPI

## Windows quick start
1. Install Node.js 20 or later.
2. Extract the complete ZIP into a new folder. Close the old validator server.
3. Double-click START-WINDOWS.bat. First start installs the required packages.
4. Open http://localhost:3093 and verify one address before starting a large list.
5. Keep the command window open while verification runs.

Your supplied API key is configured in the backend `.env` file. Do not share this ZIP publicly. To change the key, edit RAPIDAPI_KEY in `.env` and restart. `.env.example` contains no credentials. The browser receives no API key, and only index.html is served as a static file.

## Changes
- Validect GET /v1/verify replaces the free domain-only fallback in single and bulk verification.
- Provider Valid / Invalid / Accept All / Unknown statuses map to the existing result categories.
- API failures, missing subscription, quota limits and unexpected responses remain Unknown.
- Full-address caching (30 minutes) and in-flight deduplication avoid mixing different mailboxes on one domain.
- Requests run serially, spaced at least 1.1 seconds apart. This limits bursts but does not guarantee compliance with every subscription tier. Adjust VALIDECT_INTERVAL_MS to your plan.
- Timeouts are bounded. Authentication and rate-limit errors trigger a shared cooldown of at least 60 seconds; affected rows are Unknown and require a later rerun.
- Existing 5,000-address jobs, CSV exports and UI layout remain available. Legacy API Deliverable categories are retained for compatibility; Validect results use Valid, Invalid, Catch-All or Unknown.

## Bulk usage
Check your RapidAPI Validect subscription and remaining credits first. Each uncached address can consume a request. There are no automatic paid retries. Large jobs can take hours depending on provider latency and your limits. Results are saved when a job finishes. Running jobs are not resumed after a server restart. Download CSV results before closing the application.

## Troubleshooting
- Unknown / access denied: confirm this key is subscribed to Validect on RapidAPI.
- Unknown / rate limit: check your quota, wait and rerun those addresses; increase request spacing if needed.
- Backend disconnected: close older versions, run this folder's startup file, and refresh.
- Missing key: populate RAPIDAPI_KEY in `.env` and restart.
- npm install fails: confirm Node.js 20+ is installed and your internet connection can reach the npm registry.

## Developer checks
npm test
npm run check
npm start

12 mocked integration checks passed for mapping, HTTP errors, malformed responses, missing credentials, caching and deduplication. Live API testing was blocked by DNS/network restrictions in the build workspace; subscription and real response compatibility must be confirmed on your computer. Dependency installation and HTTP smoke checks also passed (UI, verification routes, syntax rejection and private-file protection).

Provider status reference: https://validect.com/documentation
Valid does not guarantee inbox delivery. Catch-All and Unknown do not confirm mailbox existence.
