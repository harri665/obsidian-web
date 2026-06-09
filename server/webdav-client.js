/**
 * Minimal WebDAV client using Node's built-in http/https.
 * No external dependencies.
 *
 * Supported operations: stat, readdir, readText, readBinary, write,
 * mkdir, delete, move, copy.
 *
 * XML parsing uses targeted regex — handles the specific PROPFIND fields
 * we need (href, displayname, getlastmodified, getcontentlength, resourcetype)
 * across different namespace prefixes (D:, d:, ns0:, etc.).
 */

const https = require('https');
const http = require('http');

// Keep-alive agents shared across all WebDAV requests. Without these, Node's
// default agents open a fresh TCP connection (and, for https, a fresh TLS
// handshake) for every single PROPFIND/GET/PUT — on a remote WebDAV server
// (e.g. Nextcloud over the internet) that can add hundreds of ms per request,
// which adds up fast for a note view that issues several requests.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

// ── XML helpers ─────────────────────────────────────────────────────────────

function xmlTag(xml, tag) {
  // Match <anyPrefix:tag> ... </anyPrefix:tag> or <tag> ... </tag>
  const re = new RegExp('<(?:[\\w]+:)?' + tag + '[^>]*>([\\s\\S]*?)</(?:[\\w]+:)?' + tag + '>', 'i');
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function xmlTagAll(xml, tag) {
  const re = new RegExp('<(?:[\\w]+:)?' + tag + '[^>]*>[\\s\\S]*?</(?:[\\w]+:)?' + tag + '>', 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[0]);
  return results;
}

function parsePropFind(xml) {
  const responses = xmlTagAll(xml, 'response');
  return responses.map((block) => {
    const href = decodeURIComponent((xmlTag(block, 'href') || '').replace(/\/$/, ''));
    const isDir = /<(?:[\w]+:)?collection\s*\/?>/i.test(block);
    const lastmod = xmlTag(block, 'getlastmodified') || '';
    const sizeStr = xmlTag(block, 'getcontentlength') || '0';
    const displayname = xmlTag(block, 'displayname') || '';
    const mtime = lastmod ? new Date(lastmod).getTime() : 0;
    const size = parseInt(sizeStr, 10) || 0;
    const name = displayname || decodeURIComponent(href.split('/').filter(Boolean).pop() || '');
    return {
      href,
      name,
      isFile: !isDir,
      isDirectory: isDir,
      isSymbolicLink: false,
      mtime: isNaN(mtime) ? 0 : mtime,
      size: isNaN(size) ? 0 : size,
    };
  });
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function rawRequest(method, fullUrl, headers, body, _redirects) {
  const redirects = _redirects || 0;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(fullUrl); } catch (e) { return reject(e); }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      headers: headers || {},
      agent: isHttps ? httpsAgent : httpAgent,
    };
    const req = lib.request(options, (res) => {
      // Follow 301/302/307/308 redirects (e.g. Nextcloud adding trailing slash).
      if (redirects < 5 && (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, fullUrl).toString();
        resolve(rawRequest(method, next, headers, body, redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : Buffer.from(body));
    req.end();
  });
}

// ── Client factory ────────────────────────────────────────────────────────────

// Detect Nextcloud public-share URLs and extract the share token so it can
// be used as the Basic-auth username (Nextcloud requires this even for
// password-less public shares).
// Matches: /public.php/dav/files/<TOKEN>  or  /public.php/webdav
function detectNextcloudToken(url) {
  const m = url.match(/\/public\.php\/(?:dav\/files|webdav)\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function createWebDavClient(vaultUrl, username, password) {
  const base = vaultUrl.replace(/\/$/, '');
  const parsedBase = new URL(base);
  // Base path used to strip the vault prefix from PROPFIND hrefs
  const basePath = parsedBase.pathname.replace(/\/$/, '');

  // If no username was provided, check whether this looks like a Nextcloud
  // public share. If so, use the share token as the Basic-auth username
  // (Nextcloud returns 401 otherwise, even for password-less public shares).
  const effectiveUsername = username || detectNextcloudToken(vaultUrl) || '';
  const authHeaders = effectiveUsername
    ? { Authorization: 'Basic ' + Buffer.from(effectiveUsername + ':' + (password || '')).toString('base64') }
    : {};

  function resolveUrl(relPath) {
    const clean = (relPath || '').replace(/^\/+/, '');
    return clean ? base + '/' + clean.split('/').map(encodeURIComponent).join('/') : base;
  }

  function request(method, relPath, extraHeaders, body) {
    const url = resolveUrl(relPath);
    return rawRequest(method, url, { ...authHeaders, ...extraHeaders }, body);
  }

  function toStats(entry) {
    const now = Date.now();
    const mtime = entry.mtime || now;
    return {
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: false,
      size: entry.size,
      mtime: mtime,
      ctime: mtime,
      atime: mtime,
      birthtime: mtime,
      mode: entry.isDirectory ? 0o040755 : 0o100644,
    };
  }

  // Relative path of an href against the vault base path
  function hrefToRel(href) {
    let rel = href;
    // href is a URL path like /remote.php/dav/files/user/vault/.obsidian
    // basePath is like /remote.php/dav/files/user/vault
    if (basePath && rel.startsWith(basePath)) {
      rel = rel.slice(basePath.length).replace(/^\/+/, '');
    } else {
      // Strip any matching suffix (servers that encode differently)
      rel = rel.split('/').filter(Boolean).slice(parsedBase.pathname.split('/').filter(Boolean).length).join('/');
    }
    return rel;
  }

  const client = {
    async testConnection() {
      try {
        const res = await request('PROPFIND', '', { Depth: '0' });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        const snippet = res.body.toString('utf8').replace(/<[^>]+>/g, '').trim().slice(0, 120);
        const hint = res.status === 401 ? ' (authentication required)'
          : res.status === 403 ? ' (access denied)'
          : res.status === 404 ? ' (URL not found)'
          : res.status === 405 ? ' (PROPFIND not allowed — may not be a WebDAV endpoint)'
          : '';
        return { ok: false, status: res.status, error: `HTTP ${res.status}${hint}${snippet ? ': ' + snippet : ''}` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },

    async stat(relPath) {
      const res = await request('PROPFIND', relPath, { Depth: '0' });
      if (res.status === 404 || res.status === 405) {
        const err = new Error('not found: ' + relPath);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        const err = new Error('stat failed ' + res.status + ': ' + relPath);
        err.code = 'EIO';
        throw err;
      }
      const entries = parsePropFind(res.body.toString('utf8'));
      if (!entries.length) {
        const err = new Error('not found: ' + relPath);
        err.code = 'ENOENT';
        throw err;
      }
      return toStats(entries[0]);
    },

    async readdir(relPath) {
      const res = await request('PROPFIND', relPath, { Depth: '1' });
      if (res.status === 404) {
        const err = new Error('not found: ' + relPath);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        const err = new Error('readdir failed ' + res.status + ': ' + relPath);
        err.code = 'EIO';
        throw err;
      }
      const entries = parsePropFind(res.body.toString('utf8'));
      // entries[0] is the directory itself; the rest are children
      const children = entries.slice(1);
      return children.map((e) => ({
        name: e.name,
        isFile: e.isFile,
        isDirectory: e.isDirectory,
        isSymbolicLink: false,
        stats: toStats(e),
      }));
    },

    async readText(relPath) {
      const res = await request('GET', relPath);
      if (res.status === 404) {
        const err = new Error('not found: ' + relPath);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        const err = new Error('read failed ' + res.status + ': ' + relPath);
        err.code = 'EIO';
        throw err;
      }
      return res.body.toString('utf8');
    },

    async readBinary(relPath) {
      const res = await request('GET', relPath);
      if (res.status === 404) {
        const err = new Error('not found: ' + relPath);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        const err = new Error('read failed ' + res.status + ': ' + relPath);
        err.code = 'EIO';
        throw err;
      }
      return res.body;
    },

    async write(relPath, data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const res = await request('PUT', relPath, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(buf.length),
      }, buf);
      if (res.status < 200 || res.status >= 300) {
        throw new Error('write failed ' + res.status + ': ' + relPath);
      }
    },

    async mkdir(relPath) {
      // Create parent directories recursively first
      const parts = relPath.replace(/^\/+/, '').split('/');
      for (let i = 1; i <= parts.length; i++) {
        const partial = parts.slice(0, i).join('/');
        const res = await request('MKCOL', partial);
        // 405 = Method Not Allowed = already exists; 409 = Conflict = parent missing (handled by loop)
        if (res.status >= 300 && res.status !== 405 && res.status !== 409) {
          throw new Error('mkdir failed ' + res.status + ': ' + partial);
        }
      }
    },

    async unlink(relPath) {
      const res = await request('DELETE', relPath);
      if (res.status === 404) {
        const err = new Error('not found: ' + relPath);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('delete failed ' + res.status + ': ' + relPath);
      }
    },

    async move(oldRelPath, newRelPath) {
      const destUrl = resolveUrl(newRelPath);
      const res = await request('MOVE', oldRelPath, {
        Destination: destUrl,
        Overwrite: 'T',
      });
      if (res.status === 404) {
        const err = new Error('not found: ' + oldRelPath);
        err.code = 'ENOENT';
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error('move failed ' + res.status + ': ' + oldRelPath + ' → ' + newRelPath);
      }
    },

    async copy(srcRelPath, dstRelPath) {
      const destUrl = resolveUrl(dstRelPath);
      const res = await request('COPY', srcRelPath, {
        Destination: destUrl,
        Overwrite: 'T',
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error('copy failed ' + res.status + ': ' + srcRelPath + ' → ' + dstRelPath);
      }
    },

    // Walk the vault recursively for bootstrap (similar to walkDir in bootstrap.js)
    // Returns { fsCache, dirsCache } in the same shape the bootstrap endpoint expects.
    async walkForBootstrap(isTextFile, MAX_CONTENT_BYTES, READ_BATCH, walkHidden = false, full = false, progress = null) {
      const fsCache = {};
      const dirsCache = {};

      async function walkPath(relDir) {
        let children;
        try {
          children = await client.readdir(relDir || '');
        } catch (_) { return; }

        const filtered = children.filter(e => walkHidden || !e.name.startsWith('.'));
        dirsCache[relDir] = filtered.map((e) => ({
          name: e.name,
          isFile: e.isFile,
          isDirectory: e.isDirectory,
          isSymbolicLink: false,
          mtime: e.stats.mtime,
          size: e.stats.size,
        }));

        if (progress) { progress.dirs = (progress.dirs || 0) + 1; progress.cb(); }

        const textFiles = [];
        for (const e of filtered) {
          const childRel = relDir ? relDir + '/' + e.name : e.name;
          if (e.isDirectory) {
            fsCache[childRel] = { mtime: e.stats.mtime, size: e.stats.size, isFile: false, isDirectory: true };
            await walkPath(childRel);
          } else if (isTextFile(e.name, e.stats.size)) {
            fsCache[childRel] = { mtime: e.stats.mtime, size: e.stats.size, isFile: true };
            textFiles.push(childRel);
          }
        }

        for (let i = 0; i < textFiles.length; i += READ_BATCH) {
          const batch = textFiles.slice(i, i + READ_BATCH);
          await Promise.all(batch.map(async (fp) => {
            try {
              const content = await client.readText(fp);
              fsCache[fp] = { ...fsCache[fp], content };
            } catch (_) {}
          }));
          if (progress) { progress.filesRead = (progress.filesRead || 0) + batch.length; progress.cb(); }
        }
      }

      // Always walk .obsidian/ (hidden, so force walkHidden=true for it)
      try {
        const obsChildren = await client.readdir('.obsidian');
        dirsCache['.obsidian'] = obsChildren.map((e) => ({
          name: e.name,
          isFile: e.isFile,
          isDirectory: e.isDirectory,
          isSymbolicLink: false,
          mtime: e.stats.mtime,
          size: e.stats.size,
        }));
        // Walk .obsidian fully
        async function walkObsidian(relDir) {
          const entries = dirsCache[relDir] || [];
          const textFiles = [];
          for (const e of entries) {
            const childRel = relDir + '/' + e.name;
            if (e.isDirectory) {
              fsCache[childRel] = { mtime: e.mtime, size: e.size, isFile: false, isDirectory: true };
              try {
                const sub = await client.readdir(childRel);
                dirsCache[childRel] = sub.map((s) => ({
                  name: s.name,
                  isFile: s.isFile,
                  isDirectory: s.isDirectory,
                  isSymbolicLink: false,
                  mtime: s.stats.mtime,
                  size: s.stats.size,
                }));
                await walkObsidian(childRel);
              } catch (_) {}
            } else if (isTextFile(e.name, e.size)) {
              fsCache[childRel] = { mtime: e.mtime, size: e.size, isFile: true };
              textFiles.push(childRel);
            }
          }
          await Promise.all(textFiles.map(async (fp) => {
            try {
              const content = await client.readText(fp);
              fsCache[fp] = { ...fsCache[fp], content };
            } catch (_) {}
          }));
        }
        await walkObsidian('.obsidian');
      } catch (_) {}

      // Root listing (non-hidden entries)
      try {
        const rootChildren = await client.readdir('');
        dirsCache[''] = rootChildren
          .filter(e => !e.name.startsWith('.'))
          .map((e) => ({
            name: e.name,
            isFile: e.isFile,
            isDirectory: e.isDirectory,
            isSymbolicLink: false,
            mtime: e.stats.mtime,
            size: e.stats.size,
          }));
      } catch (_) {}

      if (full) {
        await walkPath('');
      }

      return { fsCache, dirsCache };
    },
  };

  return client;
}

// Cache clients by vault ID to avoid recreating them on every request.
const clientCache = new Map();

function getClient(vaultId, vault) {
  if (!clientCache.has(vaultId)) {
    clientCache.set(vaultId, createWebDavClient(
      vault.webdavUrl,
      vault.webdavUsername || '',
      vault.webdavPassword || '',
    ));
  }
  return clientCache.get(vaultId);
}

function invalidateClient(vaultId) {
  clientCache.delete(vaultId);
}

module.exports = { createWebDavClient, getClient, invalidateClient };
