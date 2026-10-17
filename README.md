# Boarding Reader

A fast, phone-friendly, password-locked RSS reader for BoardingArea.

Every hour a GitHub Action:
1. reads the BoardingArea feed (3 pages, 20 posts each),
2. follows each post's link to its original blog,
3. reads each blog's own RSS feed (one request per blog) and, when that feed publishes the full post, keeps it for an in-app reader view (sanitized, images lazy-loaded from the blog),
4. gzips and encrypts everything with `READER_PASSWORD` and publishes it to GitHub Pages.

Posts whose blog feed only has a summary show the excerpt and open the original. Older posts carry forward from the previous build (300 headlines, full text for the latest 120). The page is `noindex` with a `Disallow: /` robots.txt, and the data is unreadable without the password.

## Setup
1. Settings → Secrets and variables → Actions → New secret `READER_PASSWORD`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Actions → Build reader → Run workflow (then it runs hourly).

Local test: `npm ci && READER_PASSWORD=test FEED_FIXTURE_DIR=test node build.mjs`, then serve `dist/` (e.g. `python3 -m http.server -d dist`).
