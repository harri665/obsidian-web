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

const config = require('./config');
const createFsRouter = require('./api/fs');
const createElectronRouter = require('./api/electron');
const createVaultsRouter = require('./api/vaults');
const createBootstrapRouter = require('./api/bootstrap');
const { warmUpBootstrapCache } = require('./api/bootstrap');
const createProxyRouter = require('./api/proxy');
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

  // Static files - order matters: client/ first, then obsidian/.
  app.use('/client', express.static(appConfig.clientPath, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.use('/obsidian', express.static(appConfig.obsidianPath, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // Obsidian's renderer fetches resources via absolute paths like /i18n/he.txt
  // and /lib/... because under Electron those resolve via the app:// protocol
  // to the bundle root. Mirror them onto the obsidian/ tree.
  const RESOURCE_DIRS = ['i18n', 'lib', 'public', 'sandbox'];
  for (const dir of RESOURCE_DIRS) {
    app.use('/' + dir, express.static(path.join(appConfig.obsidianPath, dir), {
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
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
        headers: { 'Cache-Control': 'no-cache' },
      });
    });
  }

  // API routes.
  app.use('/api/bootstrap', createBootstrapRouter(vaultRegistry, appConfig.vaultPath));
  app.use('/api/proxy-request', createProxyRouter());
  app.use('/api/vaults', createVaultsRouter(vaultRegistry, appConfig.vaultsDir));
  app.use('/api/fs', createFsRouter(vaultRegistry, appConfig.vaultPath));
  app.use('/api/electron', createElectronRouter(vaultRegistry, appConfig.vaultPath));

  // Named vault route — must be last so it doesn't shadow static/API paths.
  // GET /:slug auto-creates the vault dir at vaultsDir/slug on first visit,
  // registers it in the vault registry, then serves index.html with the
  // vault ID pre-injected so boot.js doesn't need a ?vault= query param.
  const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;
  app.get('/:slug', async (req, res) => {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return res.status(400).send('Invalid vault name');

    const vaultPath = path.join(appConfig.vaultsDir, slug);
    const result = vaultRegistry.open(vaultPath, true);
    if (!result.ok) return res.status(500).send('Could not open vault: ' + result.error);

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
