// Personal, password-locked RSS reader for BoardingArea.
// 1. Reads the BoardingArea aggregator feed for the latest posts.
// 2. Follows each post's redirect to find the original blog.
// 3. Reads each blog's own RSS feed; when it publishes the full post
//    (content:encoded), that text is shown in the reader. Otherwise the
//    card shows the excerpt and links to the original.
// 4. For posts still without full text, fetches the article page once (if the
//    blog's robots.txt allows it) and keeps a reader-mode copy, like a
//    personal read-later app. Each article is fetched only once.
// Output is gzipped and AES-GCM encrypted with READER_PASSWORD, so the
// published files are unreadable without it.
import { XMLParser } from "fast-xml-parser";
import sanitizeHtml from "sanitize-html";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { webcrypto as crypto } from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import robotsParser from "robots-parser";

const FEED = "https://boardingarea.com/feed/";
const PAGES = Number(process.env.FEED_PAGES || 1); // the feed ignores ?paged=, so later pages repeat page 1
const KEEP = 300; // headlines kept across runs
const KEEP_FULL = 120; // most recent posts that keep full text
const EXCERPT_CHARS = 240;
const MAX_PAGE_FETCHES = 30; // article pages per run
const UA = "PersonalFeedReader/1.0 (hourly RSS fetch; personal use)";
const OUT = "dist";
const PASSWORD = process.env.READER_PASSWORD || "";
const PREV_URL = process.env.PREV_DATA_URL || ""; // previous build's data.bin
const FIXTURE_DIR = process.env.FEED_FIXTURE_DIR || ""; // local testing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", cdataPropName: false });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// ---------- fetching ----------

async function fetchText(url) {
  if (FIXTURE_DIR) {
    const name = url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_");
    return readFile(`${FIXTURE_DIR}/${name}.xml`, "utf8");
  }
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// BoardingArea links are ?blog-post=slug redirects to the blog's own URL.
async function resolveOrigin(link) {
  if (FIXTURE_DIR) {
    const map = JSON.parse(await readFile(`${FIXTURE_DIR}/redirects.json`, "utf8"));
    return map[link] || "";
  }
  try {
    let res = await fetch(link, { method: "HEAD", redirect: "manual", headers: { "User-Agent": UA } });
    if (!res.headers.get("location")) res = await fetch(link, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = res.headers.get("location");
    return loc ? new URL(loc, link).href : "";
  } catch {
    return "";
  }
}

// ---------- parsing ----------

const decode = (s) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function excerpt(s) {
  const t = decode(s).replace(/\s*The post .* appeared first on .*$/i, "");
  if (t.length <= EXCERPT_CHARS) return t;
  return t.slice(0, t.lastIndexOf(" ", EXCERPT_CHARS)).replace(/[,.;:]$/, "") + "…";
}

// Same article across feeds: host without www + path without trailing slash.
function key(u) {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function toPost(it) {
  const media = arr(it["media:content"])[0] || arr(it["media:thumbnail"])[0];
  const enc = arr(it.enclosure).find((e) => /^image\//.test(e["@type"] || "image/"));
  const link = String(it.link || "").trim();
  return {
    id: decode(it.guid?.["#text"] ?? it.guid ?? link),
    title: decode(it.title),
    link,
    origin: "",
    author: decode(it["dc:creator"]),
    date: new Date(it.pubDate).toISOString(),
    excerpt: excerpt(it.description),
    img: media?.["@url"] || enc?.["@url"] || "",
    w: Number(media?.["@width"]) || null,
    h: Number(media?.["@height"]) || null,
    cats: arr(it.category).map(decode).filter(Boolean),
    html: "",
  };
}

function clean(html, base) {
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "hr", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "strong", "b", "em", "i", "u",
      "s", "sup", "sub", "a", "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td", "pre", "code",
      "span", "div",
    ],
    allowedAttributes: { a: ["href"], img: ["src", "srcset", "sizes", "alt", "width", "height"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["http", "https"],
    transformTags: {
      h1: "h2",
      a: (tag, attribs) => {
        try {
          return { tagName: "a", attribs: { href: new URL(attribs.href || "", base).href } };
        } catch {
          return { tagName: "span", attribs: {} };
        }
      },
      img: (tag, attribs) => {
        // Lazy-loading plugins keep the real image in data-* attributes.
        const src = attribs["data-lazy-src"] || attribs["data-src"] || attribs.src || "";
        const srcset = attribs["data-lazy-srcset"] || attribs["data-srcset"] || attribs.srcset;
        const out = { ...attribs, src };
        if (srcset) out.srcset = srcset;
        else delete out.srcset;
        return { tagName: "img", attribs: out };
      },
    },
    exclusiveFilter: (f) =>
      (f.tag === "img" && (!f.attribs.src || /^data:|feeds\.feedburner|pixel|1x1/i.test(f.attribs.src))) ||
      (f.tag === "p" && !f.text.trim() && !f.mediaChildren?.length),
  })
    .replace(/<p>\s*The post <a[^>]*>.*?<\/a> appeared first on .*?<\/p>\s*$/is, "")
    .replace(/<img /g, '<img loading="lazy" decoding="async" ');
}

// ---------- encryption (mirrored in the page script) ----------

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encrypt(obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(PASSWORD, salt), gzipSync(JSON.stringify(obj))));
  return Buffer.concat([salt, iv, ct]);
}

async function decrypt(buf) {
  const b = new Uint8Array(buf);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(16, 28) }, await deriveKey(PASSWORD, b.slice(0, 16)), b.slice(28));
  return JSON.parse(gunzipSync(Buffer.from(pt)).toString());
}

async function loadPrevious() {
  if (!PREV_URL || !PASSWORD) return [];
  try {
    const res = await fetch(PREV_URL, { headers: { "Cache-Control": "no-cache" } });
    return res.ok ? (await decrypt(await res.arrayBuffer())).posts || [] : [];
  } catch (e) {
    console.warn("No previous data:", e.message);
    return [];
  }
}

// ---------- build ----------

if (!PASSWORD) throw new Error("Set READER_PASSWORD (a GitHub Actions secret) before building.");

const fresh = [];
for (let p = 1; p <= PAGES; p++) {
  try {
    const xml = await fetchText(p === 1 ? FEED : `${FEED}?paged=${p}`);
    fresh.push(...arr(parser.parse(xml)?.rss?.channel?.item).map(toPost));
  } catch (e) {
    if (p === 1) throw e;
    console.warn(String(e));
    break;
  }
  if (FIXTURE_DIR) break;
  await sleep(1500);
}
if (!fresh.length) throw new Error("Feed returned no items");

const prev = new Map((await loadPrevious()).map((p) => [p.id, p]));

// Resolve original URLs, reusing what earlier builds already found.
for (const p of fresh) {
  const old = prev.get(p.id);
  if (old?.origin) {
    p.origin = old.origin;
    p.html = old.html || "";
    p.tried = old.tried || false;
    continue;
  }
  p.origin = await resolveOrigin(p.link);
  if (!FIXTURE_DIR) await sleep(300);
}

// One feed request per blog, only for blogs with posts still missing full text.
const needs = new Map();
for (const p of fresh) {
  if (p.html || !p.origin) continue;
  const host = new URL(p.origin).origin;
  if (!needs.has(host)) needs.set(host, []);
  needs.get(host).push(p);
}
let full = 0;
for (const [host, posts] of needs) {
  try {
    const items = arr(parser.parse(await fetchText(`${host}/feed/`))?.rss?.channel?.item);
    const byKey = new Map(items.map((it) => [key(String(it.link || "")), it]));
    for (const p of posts) {
      const body = byKey.get(key(p.origin))?.["content:encoded"];
      if (body && decode(body).length > 400) {
        p.html = clean(String(body), p.origin);
        full++;
      }
    }
  } catch (e) {
    console.warn(`${host}: ${e.message}`);
  }
  if (!FIXTURE_DIR) await sleep(1000);
}

// Reader-mode copies for the rest, respecting each blog's robots.txt.
const robots = new Map();
async function allowed(url) {
  const host = new URL(url).origin;
  if (!robots.has(host)) {
    let txt = "";
    try {
      txt = FIXTURE_DIR ? "" : await fetchText(`${host}/robots.txt`);
    } catch {}
    robots.set(host, robotsParser(`${host}/robots.txt`, txt));
  }
  return robots.get(host).isAllowed(url, "PersonalFeedReader") !== false;
}

async function fetchPage(url) {
  if (FIXTURE_DIR) return readFile(`${FIXTURE_DIR}/${url.replace(/^https?:\/\//, "").replace(/[^a-z0-9.]+/gi, "_")}.html`, "utf8");
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extract(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  // Lazy-load plugins: promote real image URLs before Readability drops the placeholders.
  for (const img of doc.querySelectorAll("img")) {
    const real = img.getAttribute("data-lazy-src") || img.getAttribute("data-src");
    if (real) img.setAttribute("src", real);
    const set = img.getAttribute("data-lazy-srcset") || img.getAttribute("data-srcset");
    if (set) img.setAttribute("srcset", set);
  }
  const art = new Readability(doc).parse();
  dom.window.close();
  return art?.content && art.textContent?.trim().length > 600 ? clean(art.content, url) : "";
}

let pages = 0;
for (const p of fresh) {
  if (p.html || !p.origin || p.tried || pages >= MAX_PAGE_FETCHES) continue;
  try {
    if (!(await allowed(p.origin))) continue;
    pages++;
    p.tried = true; // don't refetch a page that had nothing usable
    p.html = extract(await fetchPage(p.origin), p.origin);
    if (p.html) full++;
  } catch (e) {
    console.warn(`${p.origin}: ${e.message}`);
  }
  if (!FIXTURE_DIR) await sleep(1500);
}

const byId = new Map();
for (const p of [...fresh, ...prev.values()]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
const posts = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP);
posts.forEach((p, i) => {
  if (i >= KEEP_FULL) p.html = "";
});
const builtAt = new Date().toISOString();

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/data.bin`, await encrypt({ builtAt, posts }));
await writeFile(`${OUT}/index.html`, await readFile("page.html", "utf8"));
await writeFile(`${OUT}/robots.txt`, "User-agent: *\nDisallow: /\n");
await writeFile(
  `${OUT}/manifest.json`,
  JSON.stringify({ name: "Boarding Reader", short_name: "Boarding", start_url: ".", display: "standalone", background_color: "#141414", theme_color: "#141414" })
);
const withText = posts.filter((p) => p.html).length;
console.log(`Built ${posts.length} posts; ${withText} with full text (${full} new this run, ${needs.size} blog feeds and ${pages} article pages read).`);
