# Boarding Reader

A fast, phone-friendly feed reader for BoardingArea. Every hour a GitHub Action reads the public RSS feed (first 3 pages, 2s apart), and publishes a single static page of headlines, authors, short excerpts and thumbnails to GitHub Pages. Each card links to the original post. Older headlines are carried forward from the previous build (up to 300).

The page sets `noindex` and ships a `Disallow: /` robots.txt so it stays out of search engines.

## Setup
1. Push this repo to GitHub.
2. Settings → Pages → Source: **GitHub Actions**.
3. Actions → Build reader → Run workflow (it then runs hourly on its own).

Local test: `npm ci && FEED_FIXTURE=test/feed.xml node build.mjs` and open `dist/index.html`.
