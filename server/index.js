/**
 * Obsidian Web - HTTP/WebSocket server.
 *
 * Serves three things:
 *   1. The custom client/ files (boot.js, shims, custom index.html).
 *   2. Obsidian's untouched renderer files from obsidian/.
 *   3. A file system API at /api/fs/* and a watcher at /api/watch.
 */

const express = require('express');
const compression = require('compression');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');
const { getClient } = require('./webdav-client');

const config = require('./config');
const createFsRouter = require('./api/fs');
const createElectronRouter = require('./api/electron');
const createVaultsRouter = require('./api/vaults');
const createManageRouter = require('./api/manage');
const createBootstrapRouter = require('./api/bootstrap');
const { warmUpBootstrapCache } = require('./api/bootstrap');
const createProxyRouter = require('./api/proxy');
const { handleView } = require('./api/view');
const attachWatchServer = require('./api/watch');
const VaultRegistry = require('./vault-registry');

function createApp(appConfig = config) {
  const app = express();
  const vaultRegistry = new VaultRegistry(appConfig.registryPath);

  // Compression — critical for /api/bootstrap (38MB uncompressed → ~6MB).
  // Brotli gives ~84% reduction, gzip ~79%. The middleware auto-selects based
  // on Accept-Encoding: browsers get brotli, curl/other tools get gzip.
  app.use(compression({ level: 6 }));

  // Request logging - very chatty, but invaluable while we are still
  // figuring out what Obsidian asks for during boot.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const url = req.originalUrl;
      // Skip noisy static assets to keep the log readable.
      if (!url.startsWith('/api') && !url.startsWith('/i18n') && !url.startsWith('/lib') && url !== '/') {
        return;
      }
      console.log(`${req.method} ${res.statusCode} ${url} (${ms}ms)`);
    });
    next();
  });

  // Inject ?v=<cacheBust> into all client script/link tags so browsers pick up
  // changes automatically. The bust value is recomputed at server startup from
  // client/ file mtimes — no manual ?v=N bump needed.
  const cacheBust = appConfig.clientCacheBust || 'dev';
  async function sendHtmlWithCacheBust(res, filePath, vaultId = null) {
    try {
      let html = await fsp.readFile(filePath, 'utf8');
      // Inject (or replace) ?v=<bust> on all /client/ script and link tags.
      // Handles both: existing ?v=3 and paths without any query string.
      html = html.replace(/((?:src|href)="\/client\/[^"]*?)(\?v=[^"&]*)?"(?=[^>]*>)/g,
        (_, prefix) => `${prefix}?v=${cacheBust}"`);
      if (vaultId) {
        html = html.replace('</head>', `<script>window.__owVaultId=${JSON.stringify(vaultId)};</script>\n</head>`);
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.send(html);
    } catch (err) {
      res.status(500).send('Error loading page: ' + err.message);
    }
  }

  // Root: if a vault ID was passed (e.g. from vault-open navigation), serve
  // the app for that vault; otherwise redirect to /default in vaultsDir mode.
  app.get('/', (req, res) => {
    if (req.query.vault) {
      return sendHtmlWithCacheBust(res, path.join(appConfig.clientPath, 'index.html'), req.query.vault);
    }
    if (appConfig.vaultsDir) return res.redirect('/default');
    sendHtmlWithCacheBust(res, path.join(appConfig.clientPath, 'index.html'));
  });

  app.get(['/starter', '/starter.html'], (req, res) => {
    sendHtmlWithCacheBust(res, path.join(appConfig.clientPath, 'starter.html'));
  });

  app.get('/manage', (req, res) => {
    sendHtmlWithCacheBust(res, path.join(appConfig.clientPath, 'manage.html'));
  });

  // Static files - order matters: client/ first, then obsidian/.
  app.use('/client', express.static(appConfig.clientPath, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  // Obsidian's static files don't change between page loads (only on Obsidian
  // package upgrades), so a 1-hour TTL avoids per-request revalidation
  // round-trips without risking stale scripts for more than an hour.
  const OBSIDIAN_CACHE = 'public, max-age=3600, must-revalidate';
  app.use('/obsidian', express.static(appConfig.obsidianPath, {
    setHeaders: (res) => res.setHeader('Cache-Control', OBSIDIAN_CACHE),
  }));

  // Obsidian's renderer fetches resources via absolute paths like /i18n/he.txt
  // and /lib/... because under Electron those resolve via the app:// protocol
  // to the bundle root. Mirror them onto the obsidian/ tree.
  const RESOURCE_DIRS = ['i18n', 'lib', 'public', 'sandbox'];
  for (const dir of RESOURCE_DIRS) {
    app.use('/' + dir, express.static(path.join(appConfig.obsidianPath, dir), {
      setHeaders: (res) => res.setHeader('Cache-Control', OBSIDIAN_CACHE),
    }));
  }

  // Worker scripts. Obsidian creates `new Worker("worker.js")` which under
  // Electron resolves to /Resources/obsidian/worker.js, but in a browser
  // it resolves relative to the document URL. Serve them at the root.
  //
  // THIS IS CRITICAL for the metadata indexer: without worker.js the
  // metadataCache `this.work(t)` call (which postMessage's to the worker
  // and waits for a reply) hangs forever, leaving inProgressTaskCount > 0
  // and blocking everything that waits for onCleanCache (rename, etc.).
  const ROOT_FILES = ['worker.js', 'sim.js'];
  for (const f of ROOT_FILES) {
    app.get('/' + f, (req, res) => {
      res.sendFile(path.join(appConfig.obsidianPath, f), {
        headers: { 'Cache-Control': OBSIDIAN_CACHE },
      });
    });
  }

  // API routes.
  app.use('/api/bootstrap', createBootstrapRouter(vaultRegistry, appConfig.vaultPath));
  app.use('/api/proxy-request', createProxyRouter());
  app.use('/api/vaults', createVaultsRouter(vaultRegistry, appConfig.vaultsDir));
  app.use('/api/manage', createManageRouter(appConfig));
  app.use('/api/fs', createFsRouter(vaultRegistry, appConfig.vaultPath));
  app.use('/api/electron', createElectronRouter(vaultRegistry, appConfig.vaultPath));

  // Vault resource route — serves vault files at /vault/<relpath>?<mtime>.
  // Obsidian uses vault.adapter.basePath ('/vault') as a URL prefix for images
  // and other attachments, bypassing the file-url IPC entirely.
  // We identify the vault from the Referer header (the page URL has ?vault=<id>
  // or /<slug>), falling back to the most-recently-opened vault.
  app.get('/vault/*', async (req, res) => {
    const relPath = req.params[0] || '';
    if (!relPath || relPath.includes('..')) return res.status(400).send('Bad path');

    // Resolve vault ID from Referer or most-recently-opened.
    let vaultId = null;
    const referer = req.headers.referer || req.headers.referrer || '';
    if (referer) {
      try {
        const refUrl = new URL(referer);
        vaultId = refUrl.searchParams.get('vault');
        if (!vaultId) {
          // Match the first path segment — handles both /:slug and /:slug/:notepath
          const slugMatch = refUrl.pathname.match(/^\/([a-zA-Z0-9_-]{1,64})(?:\/|$)/);
          if (slugMatch) vaultId = vaultRegistry.findBySlug(slugMatch[1]);
        }
      } catch (_) {}
    }
    if (!vaultId) {
      const vaults = vaultRegistry.list();
      const latest = Object.entries(vaults)
        .filter(([, v]) => v.open)
        .sort((a, b) => b[1].ts - a[1].ts)[0];
      if (latest) vaultId = latest[0];
    }

    const vault = vaultId ? vaultRegistry.get(vaultId) : null;

    if (vault && vault.type === 'webdav') {
      try {
        const client = getClient(vaultId, vault);
        const data = await client.readBinary(relPath);
        const ext = path.extname(relPath).toLowerCase();
        const mime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.webm': 'video/webm',
          '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.tiff': 'image/tiff',
        }[ext] || 'application/octet-stream';
        res.setHeader('Content-Type', mime);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return res.send(data);
      } catch (err) {
        return res.status(err.code === 'ENOENT' ? 404 : 500).send(err.message);
      }
    }

    // Local vault.
    const vaultRoot = vault ? vault.path : appConfig.vaultPath;
    const absolute = path.resolve(vaultRoot, relPath.split('/').join(path.sep));
    const normalizedRoot = path.resolve(vaultRoot);
    if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + path.sep)) {
      return res.status(403).send('Forbidden');
    }
    res.sendFile(absolute, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }, (err) => {
      if (err) res.status(err.status || 404).send('Not found: ' + relPath);
    });
  });

  // Static note viewer — GET /:slug/:notePath(*) renders a note as read-only HTML.
  // Must come before /:slug so multi-segment paths don't fall through to the app.
  app.get('/:slug/*', async (req, res, next) => {
    try {
      const handled = await handleView(req, res, vaultRegistry, appConfig);
      if (!handled) next();
    } catch (err) {
      console.error('[view] error:', err.message);
      res.status(500).type('html').send('<pre>' + err.message + '</pre>');
    }
  });

  // Named vault route — must be last so it doesn't shadow static/API paths.
  // GET /:slug — looks up by vault name first (covers WebDAV + renamed vaults),
  // then falls back to a local dir at vaultsDir/slug.
  const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  app.get('/:slug', async (req, res) => {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).send('Invalid vault name');

    // 1. Check registry for any vault whose name slugifies to this slug.
    const matchId = vaultRegistry.findBySlug(slug);
    if (matchId) {
      return sendHtmlWithCacheBust(res, path.join(appConfig.clientPath, 'index.html'), matchId);
    }

    // 2. Fall back to local vault at vaultsDir/slug.
    const vaultPath = path.join(appConfig.vaultsDir, slug);
    const result = vaultRegistry.open(vaultPath, false);
    if (!result.ok) return res.status(404).send('Vault not found: ' + slug);

    await sendHtmlWithCacheBust(res, path.join(appConfig.clientPath, 'index.html'), result.id);
  });

  app.locals.vaultRegistry = vaultRegistry;
  return app;
}

function startServer(appConfig = config) {
  const app = createApp(appConfig);
  const server = http.createServer(app);
  attachWatchServer(server, app.locals.vaultRegistry, appConfig.vaultPath);

  server.listen(appConfig.port, appConfig.host, () => {
    console.log('==========================================');
    console.log('  Obsidian Web');
    console.log('==========================================');
    console.log('  Vault:    ' + appConfig.vaultPath);
    console.log('  Obsidian: ' + appConfig.obsidianPath);
    console.log('  Listening on http://' + appConfig.host + ':' + appConfig.port);
    console.log('==========================================');

    // Pre-build the bootstrap cache in the background so the first browser
    // request is a cache HIT instead of a cold build.
    setImmediate(() => {
      warmUpBootstrapCache(app.locals.vaultRegistry, appConfig.vaultPath)
        .catch((err) => console.warn('[bootstrap] warm-up error:', err.message));
    });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };
