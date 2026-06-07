/**
 * File system HTTP API.
 *
 * Maps Node.js fs operations to HTTP endpoints. The client-side shim
 * (client/shims/original-fs.js) translates fs calls into requests here.
 *
 * All paths are relative to the configured vault root for safety.
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getClient } = require('../webdav-client');

// Imported lazily to avoid circular require — bootstrap.js exports serverCache.
function invalidateBootstrapCache(vaultId) {
  try {
    const { serverCache } = require('./bootstrap');
    if (serverCache) serverCache.delete(vaultId);
  } catch (_) {}
}

// ── Write coalescing for rapid writes ──────────────────────────────────────
// On slow filesystems (rclone FUSE) rapid writes to the same file pile up
// and choke the mount.  This mechanism detects per-file write frequency:
//
//   First write to a file   → immediate (no delay)
//   Second write within N ms → buffered; timer reset
//   After N ms of quiet     → flush to disk
//
// Normal note saves go straight to disk.  Rapid-fire config writes
// (workspace.json written 20x/min) coalesce into a single disk write.

const COALESCE_WINDOW_MS = 5000; // writes within this window are coalesced

// key = absolute path → { data, encoding, timer, mtime }
const pendingWrites = new Map();
// key = absolute path → timestamp of last completed write
const lastWriteTime = new Map();

function shouldCoalesce(absPath) {
  const last = lastWriteTime.get(absPath);
  return last && (Date.now() - last) < COALESCE_WINDOW_MS;
}

function scheduleFlush(absPath) {
  const entry = pendingWrites.get(absPath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    const pending = pendingWrites.get(absPath);
    if (!pending) return;
    pendingWrites.delete(absPath);
    try {
      await fsp.writeFile(absPath, pending.data, pending.encoding ? { encoding: pending.encoding } : undefined);
      lastWriteTime.set(absPath, Date.now());
    } catch (err) {
      console.error('[write-coalesce] flush failed:', absPath, err.message);
    }
  }, COALESCE_WINDOW_MS);
}

function getPendingContent(absPath) {
  return pendingWrites.get(absPath) || null;
}

// Flush all pending writes on shutdown (async with timeout so slow
// filesystems like rclone don't hang the process indefinitely).
async function flushAllPending() {
  const entries = [...pendingWrites.entries()];
  pendingWrites.clear();
  if (entries.length === 0) return;
  console.log('[write-coalesce] flushing', entries.length, 'pending writes...');
  const FLUSH_TIMEOUT = 10000;
  const writes = entries.map(([absPath, entry]) => {
    if (entry.timer) clearTimeout(entry.timer);
    return fsp.writeFile(absPath, entry.data, entry.encoding ? { encoding: entry.encoding } : undefined)
      .catch(err => console.error('[write-coalesce] flush failed:', absPath, err.message));
  });
  await Promise.race([
    Promise.all(writes),
    new Promise(resolve => setTimeout(() => {
      console.warn('[write-coalesce] flush timeout — some writes may be lost');
      resolve();
    }, FLUSH_TIMEOUT)),
  ]);
}

process.on('SIGTERM', () => flushAllPending().finally(() => process.exit(0)));
process.on('SIGINT', () => flushAllPending().finally(() => process.exit(0)));

function createFsRouter(vaultRegistry, fallbackVaultRoot) {
  const router = express.Router();

  function getVaultInfo(req) {
    const vaultId = req.query.vault || (req.body && req.body.vault);
    if (vaultId) {
      const vault = vaultRegistry.get(vaultId);
      if (!vault) {
        const err = new Error('unknown vault: ' + vaultId);
        err.code = 'ENOVAULT';
        throw err;
      }
      return { vaultId, vault };
    }
    return { vaultId: null, vault: null };
  }

  function getVaultRoot(req) {
    const { vault } = getVaultInfo(req);
    if (vault) {
      if (vault.type === 'webdav') throw Object.assign(new Error('webdav vault'), { code: 'EWEBDAV' });
      return vault.path;
    }
    return fallbackVaultRoot;
  }

  // Validate and normalize a relative path for WebDAV (no .. traversal).
  function normalizeWebDavPath(rawPath) {
    if (typeof rawPath !== 'string') throw new Error('path must be a string');
    const normalized = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
    if (normalized.split('/').some((p) => p === '..')) throw new Error('path traversal not allowed');
    return normalized;
  }

  // WebDAV stat → serializeStats shape
  function webdavStatsToSerial(stats) {
    return {
      isFile: stats.isFile,
      isDirectory: stats.isDirectory,
      isSymbolicLink: false,
      size: stats.size,
      mtime: stats.mtime,
      ctime: stats.mtime,
      atime: stats.mtime,
      birthtime: stats.mtime,
      mode: stats.isDirectory ? 0o040755 : 0o100644,
    };
  }

  // Resolve a path relative to the vault root, ensuring it stays inside.
  function resolveSafe(req, relPath) {
    if (typeof relPath !== 'string') {
      throw new Error('path must be a string');
    }
    const vaultRoot = getVaultRoot(req);
    const absolute = path.resolve(vaultRoot, '.' + path.sep + relPath);
    const normalizedRoot = path.resolve(vaultRoot);
    if (absolute !== normalizedRoot && !absolute.startsWith(normalizedRoot + path.sep)) {
      throw new Error('path escapes vault root: ' + relPath);
    }
    return absolute;
  }

  // Convert an fs.Stats object into a JSON-friendly form.
  function serializeStats(stats) {
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      size: stats.size,
      mtime: stats.mtime.getTime(),
      ctime: stats.ctime.getTime(),
      atime: stats.atime.getTime(),
      birthtime: stats.birthtime.getTime(),
      mode: stats.mode,
    };
  }

  function handleError(res, err) {
    // ENOTDIR (readdir on a file) and EISDIR (read on a directory) are
    // routine "wrong shape" errors that Obsidian handles via try/catch.
    // We return 404 so the client-side fetch wrapper treats them like
    // any other "not found" without alarming console errors.
    const status = err.code === 'ENOENT' ? 404
      : err.code === 'EACCES' ? 403
      : err.code === 'EISDIR' ? 404
      : err.code === 'ENOTDIR' ? 404
      : err.code === 'ENOVAULT' ? 404
      : 500;
    res.status(status).json({
      error: err.message,
      code: err.code || null,
    });
  }

  // Stat a single entry.
  router.get('/stat', async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.query.path || '');
        const client = getClient(vaultId, vault);
        const stats = await client.stat(relPath || '');
        return res.json(webdavStatsToSerial(stats));
      }
      const target = resolveSafe(req, req.query.path || '');
      const pending = getPendingContent(target);
      const stats = await fsp.stat(target);
      if (pending) {
        stats.mtime = new Date(pending.mtime);
        stats.mtimeMs = pending.mtime;
      }
      res.json(serializeStats(stats));
    } catch (err) {
      handleError(res, err);
    }
  });

  // List directory contents (with stats so the client can avoid extra round-trips).
  router.get('/readdir', async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.query.path || '');
        const client = getClient(vaultId, vault);
        const entries = await client.readdir(relPath || '');
        return res.json(entries.map((e) => ({
          name: e.name,
          isFile: e.isFile,
          isDirectory: e.isDirectory,
          isSymbolicLink: false,
          stats: webdavStatsToSerial(e.stats),
        })));
      }
      const target = resolveSafe(req, req.query.path || '');
      if (process.env.OW_DEBUG) {
        console.log('[readdir]', req.query.path, '->', target);
      }
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const result = await Promise.all(entries.map(async (entry) => {
        const child = path.join(target, entry.name);
        let stats = null;
        try {
          const s = await fsp.stat(child);
          stats = serializeStats(s);
        } catch (_) {}
        return {
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
          isSymbolicLink: entry.isSymbolicLink(),
          stats,
        };
      }));
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // Read a file (text or binary depending on ?encoding).
  router.get('/read', async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.query.path || '');
        const encoding = req.query.encoding || null;
        const client = getClient(vaultId, vault);
        if (encoding) {
          const data = await client.readText(relPath);
          return res.type('text/plain; charset=utf-8').send(data);
        } else {
          const data = await client.readBinary(relPath);
          return res.type('application/octet-stream').send(data);
        }
      }
      const target = resolveSafe(req, req.query.path || '');
      const encoding = req.query.encoding || null;
      const pending = getPendingContent(target);
      if (pending) {
        if (encoding) {
          res.type('text/plain; charset=utf-8').send(typeof pending.data === 'string' ? pending.data : pending.data.toString(encoding));
        } else {
          res.type('application/octet-stream').send(pending.data);
        }
        return;
      }
      if (encoding) {
        const data = await fsp.readFile(target, encoding);
        res.type('text/plain; charset=utf-8').send(data);
      } else {
        const data = await fsp.readFile(target);
        res.type('application/octet-stream').send(data);
      }
    } catch (err) {
      handleError(res, err);
    }
  });

  // Write a file. Body is the raw content (text or binary).
  // ?encoding=utf8 means the server treats body as utf-8 text.
  router.put('/write', express.raw({ type: '*/*', limit: '256mb' }), async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.query.path || '');
        const encoding = req.query.encoding || null;
        const data = encoding ? req.body.toString(encoding) : req.body;
        const client = getClient(vaultId, vault);
        await client.write(relPath, data);
        invalidateBootstrapCache(vaultId);
        return res.json({ ok: true });
      }
      const relPath = req.query.path || '';
      const target = resolveSafe(req, relPath);
      const encoding = req.query.encoding || null;
      const data = encoding ? req.body.toString(encoding) : req.body;
      await fsp.mkdir(path.dirname(target), { recursive: true });

      if (shouldCoalesce(target)) {
        pendingWrites.set(target, { data, encoding, timer: null, mtime: Date.now() });
        scheduleFlush(target);
        invalidateBootstrapCache(req.query.vault);
        res.json({ ok: true });
        return;
      }

      await fsp.writeFile(target, data, encoding ? { encoding } : undefined);
      lastWriteTime.set(target, Date.now());
      invalidateBootstrapCache(req.query.vault);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/mkdir', express.json(), async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.body.path || '');
        await getClient(vaultId, vault).mkdir(relPath);
        invalidateBootstrapCache(vaultId);
        return res.json({ ok: true });
      }
      const target = resolveSafe(req, req.body.path || '');
      const recursive = req.body.recursive !== false;
      await fsp.mkdir(target, { recursive });
      invalidateBootstrapCache(req.body.vault);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/unlink', async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.query.path || '');
        await getClient(vaultId, vault).unlink(relPath);
        invalidateBootstrapCache(vaultId);
        return res.json({ ok: true });
      }
      const target = resolveSafe(req, req.query.path || '');
      await fsp.unlink(target);
      invalidateBootstrapCache(req.query.vault);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.delete('/rmdir', async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const relPath = normalizeWebDavPath(req.query.path || '');
        // WebDAV DELETE works for both files and directories
        await getClient(vaultId, vault).unlink(relPath);
        invalidateBootstrapCache(vaultId);
        return res.json({ ok: true });
      }
      const target = resolveSafe(req, req.query.path || '');
      const recursive = req.query.recursive === '1';
      if (recursive) {
        await fsp.rm(target, { recursive: true, force: false });
      } else {
        await fsp.rmdir(target);
      }
      invalidateBootstrapCache(req.query.vault);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/rename', express.json(), async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const oldPath = normalizeWebDavPath(req.body.oldPath || '');
        const newPath = normalizeWebDavPath(req.body.newPath || '');
        await getClient(vaultId, vault).move(oldPath, newPath);
        invalidateBootstrapCache(vaultId);
        return res.json({ ok: true });
      }
      const oldPath = resolveSafe(req, req.body.oldPath || '');
      const newPath = resolveSafe(req, req.body.newPath || '');
      await fsp.rename(oldPath, newPath);
      invalidateBootstrapCache(req.body.vault);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  router.post('/copy', express.json(), async (req, res) => {
    try {
      const { vaultId, vault } = getVaultInfo(req);
      if (vault && vault.type === 'webdav') {
        const src = normalizeWebDavPath(req.body.src || '');
        const dest = normalizeWebDavPath(req.body.dest || '');
        await getClient(vaultId, vault).copy(src, dest);
        invalidateBootstrapCache(vaultId);
        return res.json({ ok: true });
      }
      const src = resolveSafe(req, req.body.src || '');
      const dest = resolveSafe(req, req.body.dest || '');
      await fsp.copyFile(src, dest);
      invalidateBootstrapCache(req.body.vault);
      res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

module.exports = createFsRouter;
