const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class VaultRegistry {
  constructor(registryPath) {
    this.registryPath = registryPath;
    this.vaults = this.load();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) || {};
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      // Corrupt or unreadable file — start empty and log, don't crash the server.
      console.error('[vault-registry] corrupt registry, starting empty:', err.message);
      return {};
    }
  }

  save() {
    const dir = path.dirname(this.registryPath);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to a temp file then rename over the final path so a
    // crash mid-write doesn't leave a partial/invalid JSON file.
    const tmp = this.registryPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.vaults, null, 2));
    fs.renameSync(tmp, this.registryPath);
  }

  list() {
    return { ...this.vaults };
  }

  get(id) {
    return this.vaults[id] || null;
  }

  findIdByPath(vaultPath) {
    // WebDAV vaults use the URL as their path key (no path.resolve needed).
    if (vaultPath && vaultPath.startsWith('http')) {
      for (const [id, vault] of Object.entries(this.vaults)) {
        if (vault.path === vaultPath) return id;
      }
      return null;
    }
    const resolved = path.resolve(vaultPath);
    for (const [id, vault] of Object.entries(this.vaults)) {
      if (vault.type !== 'webdav' && path.resolve(vault.path) === resolved) return id;
    }
    return null;
  }

  open(vaultPath, create) {
    if (!vaultPath || typeof vaultPath !== 'string') {
      return { ok: false, error: 'folder not found' };
    }

    const resolved = path.resolve(vaultPath);
    if (create) {
      fs.mkdirSync(resolved, { recursive: true });
    }

    let stats;
    try {
      stats = fs.statSync(resolved);
    } catch (err) {
      return { ok: false, error: 'folder not found' };
    }

    if (!stats.isDirectory()) {
      return { ok: false, error: 'path is not a folder' };
    }

    try {
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    } catch (err) {
      return { ok: false, error: 'no permission to access folder' };
    }

    const existingId = this.findIdByPath(resolved);
    const id = existingId || crypto.randomBytes(8).toString('hex');
    this.vaults[id] = {
      path: resolved,
      ts: Date.now(),
      open: true,
    };
    this.save();
    return { ok: true, id };
  }

  addWebDav(url, username, password, name) {
    try { new URL(url); } catch (_) { return { ok: false, error: 'invalid URL' }; }
    const existingId = this.findIdByPath(url);
    const id = existingId || crypto.randomBytes(8).toString('hex');
    this.vaults[id] = {
      type: 'webdav',
      path: url,
      webdavUrl: url,
      webdavUsername: username || '',
      webdavPassword: password || '',
      name: name || url.split('/').filter(Boolean).pop() || 'webdav-vault',
      ts: Date.now(),
      open: true,
    };
    this.save();
    return { ok: true, id };
  }

  remove(vaultPath) {
    const id = this.findIdByPath(vaultPath);
    if (!id) return false;
    delete this.vaults[id];
    this.save();
    return true;
  }

  removeById(id) {
    if (!this.vaults[id]) return false;
    delete this.vaults[id];
    this.save();
    return true;
  }

  move(oldPath, newPath) {
    if (!oldPath || typeof oldPath !== 'string') return { ok: false, notFound: true };
    const id = this.findIdByPath(oldPath);
    if (!id) return { ok: false, notFound: true };

    const resolvedNewPath = path.resolve(newPath);
    try {
      fs.renameSync(this.vaults[id].path, resolvedNewPath);
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }

    this.vaults[id] = {
      ...this.vaults[id],
      path: resolvedNewPath,
      ts: Date.now(),
    };
    this.save();
    return { ok: true };
  }
}

module.exports = VaultRegistry;
