const express = require('express');
const path = require('path');
const { createWebDavClient } = require('../webdav-client');
const { slugify } = require('../vault-registry');

// Returns the single-level slug if vaultPath is a direct child of vaultsDir.
function deriveSlug(vaultPath, vaultsDir) {
  if (!vaultPath || !vaultsDir) return null;
  const resolved = path.resolve(vaultPath);
  const dir = path.resolve(vaultsDir);
  if (!resolved.startsWith(dir + path.sep)) return null;
  const rel = resolved.slice(dir.length + path.sep.length);
  return rel.includes(path.sep) ? null : rel;
}

const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function createVaultsRouter(vaultRegistry, vaultsDir) {
  const router = express.Router();

  router.get('/list', (req, res) => {
    res.json(vaultRegistry.list());
  });

  router.post('/open', express.json(), (req, res) => {
    const vaultPath = req.body && req.body.path;
    if (!vaultPath) return res.status(400).json({ ok: false, error: 'path required' });

    // WebDAV vault: path is a URL — find the existing registry entry by URL.
    if (typeof vaultPath === 'string' && /^https?:\/\//i.test(vaultPath)) {
      const id = vaultRegistry.findIdByPath(vaultPath);
      if (!id) return res.status(404).json({ ok: false, error: 'WebDAV vault not found in registry' });
      const vault = vaultRegistry.get(id);
      const name = vault.name || vaultPath.split('/').filter(Boolean).pop() || id;
      const slug = slugify(name);
      return res.json({ ok: true, id, slug: SLUG_RE.test(slug) ? slug : null });
    }

    const result = vaultRegistry.open(vaultPath, req.body.create === true);
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    const slug = deriveSlug(vaultPath, vaultsDir);
    res.json({ ...result, slug });
  });

  router.post('/rename', express.json(), (req, res) => {
    const { id, name } = req.body || {};
    if (!id || !name) return res.status(400).json({ ok: false, error: 'id and name are required' });
    const result = vaultRegistry.rename(id, name);
    if (!result.ok) return res.status(404).json(result);
    res.json({ ok: true });
  });

  router.post('/move', express.json(), (req, res) => {
    if (!req.body || typeof req.body.oldPath !== 'string' || typeof req.body.newPath !== 'string') {
      return res.status(400).json({ ok: false, error: 'oldPath and newPath are required' });
    }
    try {
      const result = vaultRegistry.move(req.body.oldPath, req.body.newPath);
      if (result.notFound) return res.status(404).json({ ok: false, error: 'vault not found' });
      if (!result.ok) return res.status(500).json({ ok: false, error: result.error, code: result.code });
      // Return { ok: true, value: '' } for backward compat with the Obsidian starter IPC shape.
      res.json({ ok: true, value: '' });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/remove', express.json(), (req, res) => {
    if (!req.body) return res.status(400).json({ ok: false, error: 'body required' });
    try {
      // Accept either { id } or { path }
      let removed = false;
      if (req.body.id) {
        removed = vaultRegistry.removeById(req.body.id);
      } else if (typeof req.body.path === 'string') {
        removed = vaultRegistry.remove(req.body.path);
      } else {
        return res.status(400).json({ ok: false, error: 'id or path required' });
      }
      if (!removed) return res.status(404).json({ ok: false, error: 'vault not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/add-webdav', express.json(), (req, res) => {
    const { url, username, password, name } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    const result = vaultRegistry.addWebDav(url, username || '', password || '', name || '');
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  });

  router.post('/test-webdav', express.json(), async (req, res) => {
    const { url, username, password } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    try {
      const client = createWebDavClient(url, username || '', password || '');
      const result = await client.testConnection();
      res.json(result);
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createVaultsRouter;
