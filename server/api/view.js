/**
 * Static read-only note viewer.
 *
 * GET /:vaultSlug/:notePath(*)
 *
 * Renders an Obsidian markdown note to HTML, resolving:
 *   [[wikilinks]]          → links to other notes in the same vault
 *   [[note|alias]]         → wikilink with display text
 *   ![[image.png]]         → inline image via /vault/* route
 *   ![[note.md]]           → transcluded note content (recursive, depth-limited)
 *   ![[note#Heading]]      → only the matching section of the embed
 *
 * Works with both local filesystem vaults and WebDAV vaults.
 */

'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { marked } = require('marked');
const { getClient } = require('../webdav-client');
const bootstrap = require('./bootstrap');

// ── Vault reader abstraction ──────────────────────────────────────────────────
//
// Both local and WebDAV vaults expose the same two operations used by the
// renderer: readText(relPath) and readdir(relPath).

function makeLocalReader(vaultRoot) {
  return {
    async readText(relPath) {
      return fsp.readFile(path.resolve(vaultRoot, ...relPath.split('/')), 'utf8');
    },
    async readdir(relPath) {
      const abs = relPath
        ? path.resolve(vaultRoot, ...relPath.split('/'))
        : vaultRoot;
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({ name: e.name, isFile: e.isFile(), isDirectory: e.isDirectory() }));
    },
  };
}

// ── WebDAV read cache ──────────────────────────────────────────────────────────
//
// The static viewer is read-only and re-resolves the same notes, embeds and
// directory listings on every page view (and again for each embedded note).
// Without a cache, each of those is a live PROPFIND/GET round-trip to the
// remote WebDAV server, which is what makes "static" pages feel slow.
// A short TTL cache keeps repeat views (and link/embed resolution within a
// single page) effectively instant while still picking up edits within a
// reasonable window.
const WEBDAV_CACHE_TTL_MS = 60_000;
const webdavCaches = new Map(); // vaultId → { dirs: Map, texts: Map }

function getWebDavCache(vaultId) {
  let cache = webdavCaches.get(vaultId);
  if (!cache) {
    cache = { dirs: new Map(), texts: new Map() };
    webdavCaches.set(vaultId, cache);
  }
  return cache;
}

function cached(map, key, fetch) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.time < WEBDAV_CACHE_TTL_MS) return hit.promise;
  const promise = fetch().catch(err => { map.delete(key); throw err; });
  map.set(key, { time: Date.now(), promise });
  return promise;
}

// If the bootstrap cache already has a full snapshot of this vault (built at
// startup, or by the Obsidian app's own /api/bootstrap?full=1 call), serve
// directory listings and note content straight from it — zero network calls.
// It's kept fresh by api/fs.js, which deletes the entry on any write, so this
// can only be stale for as long as an out-of-band WebDAV edit takes to notice.
function ensureBootstrapWarm(vaultId, vaultRegistry) {
  if (bootstrap.serverCache.has(vaultId)) return;
  if (bootstrap.pendingBuilds.has(vaultId + ':full')) return;
  bootstrap.buildCacheEntry(vaultId, null, vaultRegistry, true).catch(() => {});
}

function makeWebDavReader(client, vaultId, vaultRegistry) {
  const cache = getWebDavCache(vaultId);
  return {
    async readText(relPath) {
      const entry = bootstrap.serverCache.get(vaultId);
      const fsEntry = entry && entry.response.fs[relPath];
      if (fsEntry && fsEntry.content !== undefined) return fsEntry.content;
      ensureBootstrapWarm(vaultId, vaultRegistry);
      return cached(cache.texts, relPath, () => client.readText(relPath));
    },
    async readdir(relPath) {
      const key = relPath || '';
      const entry = bootstrap.serverCache.get(vaultId);
      const dirEntry = entry && entry.response.dirs[key];
      if (dirEntry) {
        return dirEntry.map(e => ({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory }));
      }
      ensureBootstrapWarm(vaultId, vaultRegistry);
      return cached(cache.dirs, key, async () => {
        const entries = await client.readdir(key);
        return entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => ({ name: e.name, isFile: e.isFile, isDirectory: e.isDirectory }));
      });
    },
  };
}

// ── File resolution ───────────────────────────────────────────────────────────

// Walk the vault recursively, returning all non-hidden relative file paths.
async function walkVault(reader, relDir, out = []) {
  let entries;
  try { entries = await reader.readdir(relDir); }
  catch (_) { return out; }
  await Promise.all(entries.map(async (e) => {
    const childRel = relDir ? relDir + '/' + e.name : e.name;
    if (e.isDirectory) await walkVault(reader, childRel, out);
    else out.push(childRel);
  }));
  return out;
}

// Resolve an Obsidian link target to a vault-relative path, or null if not found.
// Implements Obsidian's shortest-unique-path rule.
async function resolveTarget(target, reader, fromRel) {
  const filePart = target.split('#')[0].trim();
  if (!filePart) return null;

  // Normalise: add .md if there's no extension
  const withMd = /\.[a-z0-9]+$/i.test(filePart) ? filePart : filePart + '.md';

  // 1. Try as a direct vault-root-relative path (handles folder/note links)
  //    We check by walking up one level: ask the parent dir for its children
  //    and look for the filename.
  const slashIdx = withMd.lastIndexOf('/');
  const parentRel = slashIdx >= 0 ? withMd.slice(0, slashIdx) : '';
  const basename  = slashIdx >= 0 ? withMd.slice(slashIdx + 1) : withMd;
  try {
    const siblings = await reader.readdir(parentRel);
    const found = siblings.find(e => e.isFile && e.name.toLowerCase() === basename.toLowerCase());
    if (found) return (parentRel ? parentRel + '/' : '') + found.name;
  } catch (_) {}

  // 2. Basename search across the whole vault (Obsidian's shortest-path rule)
  const allFiles = await walkVault(reader, '');
  const needle = basename.toLowerCase();
  const matches = allFiles.filter(f => path.basename(f).toLowerCase() === needle);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  // Multiple matches: prefer the closest to the current note
  const fromDir = fromRel ? fromRel.split('/').slice(0, -1).join('/') : '';
  return matches.find(f => f.split('/').slice(0, -1).join('/') === fromDir) || matches[0];
}

// ── Markdown rendering ────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.bmp', '.tiff', '.avif', '.ico',
]);

function isImage(relPath) {
  return IMAGE_EXTS.has(path.posix.extname(relPath).toLowerCase());
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Extract the section of already-rendered HTML under a specific heading.
function extractSection(html, heading) {
  if (!heading) return html;
  const needle = heading.toLowerCase();
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let startIdx = -1;
  let level = 0;
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, '').trim().toLowerCase();
    if (startIdx === -1 && text === needle) {
      startIdx = m.index;
      level = parseInt(m[1], 10);
    } else if (startIdx !== -1 && parseInt(m[1], 10) <= level) {
      return html.slice(startIdx, m.index);
    }
  }
  return startIdx !== -1 ? html.slice(startIdx) : html;
}

// Build the href for a note link.
function noteHref(vaultSlug, filePart) {
  const withoutExt = filePart.replace(/\.md$/i, '');
  return '/' + vaultSlug + '/' + withoutExt.split('/').map(encodeURIComponent).join('/');
}

// Render a vault note file to an HTML fragment.
async function renderNote(relPath, reader, vaultSlug, depth) {
  let raw;
  try { raw = await reader.readText(relPath); }
  catch (_) { return `<p class="ow-missing">⚠ Could not read: ${esc(relPath)}</p>`; }
  return renderContent(raw, relPath, reader, vaultSlug, depth);
}

async function renderContent(raw, fromRel, reader, vaultSlug, depth = 0) {
  // Strip YAML frontmatter
  raw = raw.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');

  // ── ![[embeds]] ────────────────────────────────────────────────────────────
  const EMBED_RE = /!\[\[([^\]]+)\]\]/g;
  const embedMap = new Map(); // full_match → replacement_html
  let m;
  while ((m = EMBED_RE.exec(raw)) !== null) {
    if (!embedMap.has(m[0])) embedMap.set(m[0], m[1]);
  }

  await Promise.all([...embedMap.entries()].map(async ([match, target]) => {
    const [filePart, headingPart] = target.split('#');
    const resolved = await resolveTarget(filePart.trim(), reader, fromRel);
    let html;

    if (!resolved) {
      html = `<span class="ow-missing">⚠ ${esc(target)}</span>`;
    } else if (isImage(resolved)) {
      // Served via /vault/* which resolves vault from the Referer header
      const src = '/vault/' + resolved.split('/').map(encodeURIComponent).join('/');
      html = `<img src="${src}" alt="${esc(path.posix.basename(resolved))}" loading="lazy" class="ow-embed-img">`;
    } else if (depth < 4) {
      let noteHtml = await renderNote(resolved, reader, vaultSlug, depth + 1);
      if (headingPart) noteHtml = extractSection(noteHtml, headingPart.trim());
      const title = path.posix.basename(resolved).replace(/\.md$/i, '');
      const href = noteHref(vaultSlug, resolved);
      html = [
        `<blockquote class="ow-embed">`,
        `<p class="ow-embed-title"><a href="${href}">${esc(title)}</a></p>`,
        `<div class="ow-embed-body">${noteHtml}</div>`,
        `</blockquote>`,
      ].join('');
    } else {
      html = `<span class="ow-missing">[embed depth limit]</span>`;
    }
    embedMap.set(match, html);
  }));

  raw = raw.replace(/!\[\[([^\]]+)\]\]/g, match => embedMap.get(match) || match);

  // ── [[wikilinks]] ──────────────────────────────────────────────────────────
  // With alias: [[target|alias]] or [[target#heading|alias]]
  raw = raw.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, target, alias) => {
    const [filePart] = target.split('#');
    return `<a href="${noteHref(vaultSlug, filePart.trim())}" class="ow-link">${esc(alias.trim())}</a>`;
  });
  // Without alias: [[target]] or [[target#heading]]
  raw = raw.replace(/\[\[([^\]]+)\]\]/g, (_, target) => {
    const [filePart, heading] = target.split('#');
    const display = filePart.trim();
    const href = noteHref(vaultSlug, display) + (heading ? '#' + encodeURIComponent(heading.trim()) : '');
    return `<a href="${href}" class="ow-link">${esc(display)}</a>`;
  });

  // ── Standard markdown ──────────────────────────────────────────────────────
  return marked.parse(raw, { gfm: true, breaks: false });
}

// ── HTML page shell ───────────────────────────────────────────────────────────

function buildPage({ title, vaultName, vaultSlug, contentHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}${vaultName ? ' — ' + esc(vaultName) : ''}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#1e1e1e;--bg2:#252525;--surface:#2d2d2d;--txt:#dcddde;--txt2:#999;
  --link:#7f6df2;--link-h:#a695f5;--code-bg:#282828;--code-txt:#d4d4d4;
  --border:#3a3a3a;--q-bar:#7f6df2;--embed-bg:#252525;--miss:#e06c75;--max:750px;
}
@media(prefers-color-scheme:light){:root{
  --bg:#fafafa;--bg2:#f2f2f2;--surface:#e8e8e8;--txt:#2e2e2e;--txt2:#777;
  --link:#705dcf;--link-h:#4f3db0;--code-bg:#f0f0f0;--code-txt:#333;
  --border:#d8d8d8;--q-bar:#705dcf;--embed-bg:#f5f5f5;--miss:#c0392b;
}}
html,body{margin:0;padding:0;background:var(--bg);color:var(--txt);font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
#ow-view{max-width:var(--max);margin:0 auto;padding:1.5rem 1.25rem 4rem}
nav{margin-bottom:1.5rem;font-size:.85rem}
nav a{color:var(--link);text-decoration:none;opacity:.8}
nav a:hover{opacity:1;text-decoration:underline}
.ow-title{margin:0 0 2rem;font-size:2rem;font-weight:700;line-height:1.2;color:var(--txt)}
h1,h2,h3,h4,h5,h6{margin:1.6em 0 .5em;line-height:1.25;color:var(--txt);font-weight:600}
h1{font-size:1.75rem}h2{font-size:1.4rem;border-bottom:1px solid var(--border);padding-bottom:.3em}h3{font-size:1.15rem}
p{margin:.7em 0}
a{color:var(--link)}a:hover{color:var(--link-h)}
a.ow-link{text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--link) 40%,transparent)}
a.ow-link:hover{border-bottom-color:var(--link)}
code{font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:.88em;background:var(--code-bg);color:var(--code-txt);padding:.15em .35em;border-radius:3px}
pre{background:var(--code-bg);border-radius:6px;padding:1rem;overflow-x:auto;margin:1em 0}
pre code{background:none;padding:0;font-size:.85em;line-height:1.5}
ul,ol{margin:.5em 0;padding-left:1.6em}li{margin:.25em 0}li>ul,li>ol{margin:.25em 0}
blockquote{margin:.75em 0;padding:.4em .9em;border-left:3px solid var(--q-bar);background:var(--bg2);color:var(--txt2);border-radius:0 4px 4px 0}
blockquote p:first-child{margin-top:0}blockquote p:last-child{margin-bottom:0}
table{border-collapse:collapse;width:100%;margin:1em 0;font-size:.9em}
th,td{padding:.45em .75em;border:1px solid var(--border);text-align:left}
th{background:var(--surface);font-weight:600}tr:nth-child(even){background:var(--bg2)}
hr{border:none;border-top:1px solid var(--border);margin:1.5em 0}
img{max-width:100%;height:auto;border-radius:4px;display:block;margin:.5em 0}
.ow-embed-img{margin:1em auto}
blockquote.ow-embed{border-left:3px solid var(--q-bar);background:var(--embed-bg);border-radius:0 6px 6px 0;margin:1em 0;padding:.6em 1em}
.ow-embed-title{margin:0 0 .4em;font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;opacity:.6}
.ow-embed-title a{color:var(--link);text-decoration:none}
.ow-embed-body{font-size:.94em}
.ow-embed-body h1,.ow-embed-body h2{font-size:1.05rem;border-bottom:none;margin:.6em 0 .3em}
.ow-embed-body h3,.ow-embed-body h4{font-size:.95rem;margin:.5em 0 .25em}
.ow-missing{color:var(--miss);font-style:italic;font-size:.88em}
</style>
</head>
<body>
<div id="ow-view">
  <nav><a href="/${esc(vaultSlug)}">← ${esc(vaultName || vaultSlug)}</a></nav>
  <h1 class="ow-title">${esc(title)}</h1>
  <div class="markdown-body">
${contentHtml}
  </div>
</div>
</body>
</html>`;
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function handleView(req, res, vaultRegistry, appConfig) {
  const slug = req.params.slug;
  const rawNotePath = req.params[0] || '';

  // Resolve vault by slug
  const vaultId = vaultRegistry.findBySlug(slug);
  if (!vaultId) return false; // unknown slug — let next handler try

  const vault = vaultRegistry.get(vaultId);
  if (!rawNotePath) return false; // no note path — open Obsidian app instead

  const vaultName = vault ? (vault.name || slug) : slug;

  // Decode URL-encoded path segments
  const notePath = rawNotePath.split('/').map(s => {
    try { return decodeURIComponent(s); } catch (_) { return s; }
  }).join('/');

  // Build the appropriate vault reader
  let reader;
  if (vault && vault.type === 'webdav') {
    reader = makeWebDavReader(getClient(vaultId, vault), vaultId, vaultRegistry);
  } else {
    const vaultRoot = vault ? vault.path : appConfig.vaultPath;
    reader = makeLocalReader(vaultRoot);
  }

  const resolved = await resolveTarget(notePath, reader, null);

  if (!resolved) {
    res.status(404).type('html').send(buildPage({
      title: 'Not Found',
      vaultName,
      vaultSlug: slug,
      contentHtml: `<p class="ow-missing">Note not found: <code>${esc(notePath)}</code></p>`,
    }));
    return true;
  }

  const title = path.posix.basename(resolved).replace(/\.md$/i, '');
  const contentHtml = await renderNote(resolved, reader, slug, 0);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(buildPage({ title, vaultName, vaultSlug: slug, contentHtml }));
  return true;
}

module.exports = { handleView };
