// Builds a tiny static reader from BoardingArea's public RSS feed.
// Shows headline, author, time, a short excerpt and the feed's thumbnail;
// every card links to the original article.
import { XMLParser } from "fast-xml-parser";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const FEED = "https://boardingarea.com/feed/";
const PAGES = Number(process.env.FEED_PAGES || 3); // 20 posts per feed page
const KEEP = 300; // posts kept across runs
const EXCERPT_CHARS = 240;
const UA = "PersonalFeedReader/1.0 (hourly RSS fetch; personal use)";
const OUT = "dist";
// Previous build's data, so headlines older than the feed window stay listed.
const PREV_URL = process.env.PREV_DATA_URL || "";
const FIXTURE = process.env.FEED_FIXTURE || ""; // local testing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

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

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function toPost(it) {
  const media = arr(it["media:content"])[0] || arr(it["media:thumbnail"])[0];
  const enc = arr(it.enclosure).find((e) => /^image\//.test(e["@type"] || "image/"));
  const img = media?.["@url"] || enc?.["@url"] || "";
  const link = String(it.link || "").trim();
  return {
    id: decode(it.guid?.["#text"] ?? it.guid ?? link),
    title: decode(it.title),
    link,
    author: decode(it["dc:creator"]),
    date: new Date(it.pubDate).toISOString(),
    excerpt: excerpt(it.description),
    img,
    w: Number(media?.["@width"]) || null,
    h: Number(media?.["@height"]) || null,
    cats: arr(it.category).map(decode).filter(Boolean),
  };
}

async function loadFeedPages() {
  if (FIXTURE) return [await readFile(FIXTURE, "utf8")];
  const out = [];
  for (let p = 1; p <= PAGES; p++) {
    try {
      out.push(await fetchText(p === 1 ? FEED : `${FEED}?paged=${p}`));
    } catch (e) {
      console.warn(String(e));
      if (p === 1) throw e;
      break;
    }
    await sleep(2000); // be polite between requests
  }
  return out;
}

async function loadPrevious() {
  if (!PREV_URL) return [];
  try {
    const res = await fetch(PREV_URL, { headers: { "Cache-Control": "no-cache" } });
    return res.ok ? (await res.json()).posts || [] : [];
  } catch {
    return [];
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function card(p, i) {
  const ratio = p.w && p.h ? `style="aspect-ratio:${p.w}/${p.h}"` : "";
  const img = p.img
    ? `<img src="${esc(p.img)}" alt="" ${i < 4 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" referrerpolicy="no-referrer" ${ratio} onerror="this.remove()">`
    : "";
  return `<article data-a="${esc(p.author.toLowerCase())}" data-t="${esc((p.title + " " + p.excerpt + " " + p.cats.join(" ")).toLowerCase())}">
<a href="${esc(p.link)}" rel="noopener noreferrer">${img}<div class="b"><h2>${esc(p.title)}</h2>
<p class="m">${esc(p.author)}${p.author ? " · " : ""}<time datetime="${p.date}">${p.date.slice(0, 10)}</time></p>
${p.excerpt ? `<p class="x">${esc(p.excerpt)}</p>` : ""}</div></a></article>`;
}

function page(posts, builtAt) {
  const authors = [...new Set(posts.map((p) => p.author).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f6f6f4" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes"><link rel="manifest" href="manifest.json">
<title>Boarding Reader</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#151515;--mut:#666;--line:#e3e3df;--acc:#0b5cad}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--fg:#ececec;--mut:#9a9a9a;--line:#2c2c2c;--acc:#6aa8ff}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px calc(10px) ;padding-top:max(10px,env(safe-area-inset-top))}
.row{display:flex;gap:8px;max-width:760px;margin:0 auto}
h1{font-size:18px;margin:0 auto 8px;max-width:760px;display:flex;justify-content:space-between;align-items:baseline}
h1 small{font-weight:400;font-size:12px;color:var(--mut)}
input,select{flex:1;min-width:0;font:inherit;font-size:16px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg)}
select{flex:0 1 40%}
main{max-width:760px;margin:0 auto;padding:12px 16px 40px;display:grid;gap:12px}
article{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;content-visibility:auto;contain-intrinsic-size:auto 360px}
article a{color:inherit;text-decoration:none;display:block}
article img{display:block;width:100%;height:auto;max-height:260px;object-fit:cover;background:var(--line)}
.b{padding:12px 14px 14px}h2{font-size:17px;line-height:1.3;margin:0 0 4px}
.m{margin:0 0 6px;font-size:13px;color:var(--mut)}.x{margin:0;font-size:15px;color:var(--fg);opacity:.85}
article a:visited h2{color:var(--mut)}
@media (min-width:700px){main{grid-template-columns:1fr 1fr}}
.empty{color:var(--mut);text-align:center;padding:40px 0;display:none}
footer{text-align:center;color:var(--mut);font-size:12px;padding:0 16px 30px}
</style></head><body>
<header><h1>Boarding Reader <small>updated <time id="u" datetime="${builtAt}">${builtAt.slice(0, 16).replace("T", " ")} UTC</time></small></h1>
<div class="row"><input id="q" type="search" placeholder="Filter headlines" autocomplete="off">
<select id="a"><option value="">All authors</option>${authors.map((a) => `<option value="${esc(a.toLowerCase())}">${esc(a)}</option>`).join("")}</select></div></header>
<main id="list">
${posts.map(card).join("\n")}
<p class="empty" id="e">No matching posts.</p></main>
<footer>Headlines and excerpts from the public BoardingArea RSS feed. Tap a card to read the full post on boardingarea.com.</footer>
<script>
(()=>{const q=document.getElementById("q"),a=document.getElementById("a"),cards=[...document.querySelectorAll("article")],e=document.getElementById("e");
const rel=(d)=>{const s=(Date.now()-new Date(d))/1e3;if(s<3600)return Math.max(1,Math.round(s/60))+"m ago";if(s<86400)return Math.round(s/3600)+"h ago";if(s<604800)return Math.round(s/86400)+"d ago";return d.slice(0,10)};
document.querySelectorAll("article time").forEach(t=>t.textContent=rel(t.dateTime));
const u=document.getElementById("u");u.textContent=rel(u.dateTime);
try{a.value=localStorage.getItem("ba-author")||""}catch{}
function f(){const s=q.value.trim().toLowerCase(),au=a.value;let n=0;for(const c of cards){const ok=(!au||c.dataset.a===au)&&(!s||c.dataset.t.includes(s));c.hidden=!ok;if(ok)n++}e.style.display=n?"none":"block";try{localStorage.setItem("ba-author",au)}catch{}}
q.addEventListener("input",f);a.addEventListener("change",f);f();
// Pick up the hourly rebuild when returning to the tab.
let last=Date.now();document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-last>20*60e3)location.reload();last=Date.now()});
})();
</script></body></html>`;
}

const xmls = await loadFeedPages();
const fresh = xmls.flatMap((x) => arr(parser.parse(x)?.rss?.channel?.item)).map(toPost);
if (!fresh.length) throw new Error("Feed returned no items");
const byId = new Map();
for (const p of [...fresh, ...(await loadPrevious())]) if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
const posts = [...byId.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP);
const builtAt = new Date().toISOString();

await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/index.html`, page(posts, builtAt));
await writeFile(`${OUT}/data.json`, JSON.stringify({ builtAt, posts }));
await writeFile(`${OUT}/robots.txt`, "User-agent: *\nDisallow: /\n");
await writeFile(
  `${OUT}/manifest.json`,
  JSON.stringify({ name: "Boarding Reader", short_name: "Boarding", start_url: ".", display: "standalone", background_color: "#141414", theme_color: "#141414" })
);
console.log(`Built ${posts.length} posts (${fresh.length} from feed).`);
