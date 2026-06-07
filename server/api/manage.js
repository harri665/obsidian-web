/**
 * Vault management helper APIs.
 *
 * GET /api/manage/ls?path=<serverPath>  — list a server-side directory
 * GET /api/manage/vaults-dir            — return the configured vaultsDir
 */

const express = require('express');
const fsp = require('fs').promises;
const path = require('path');

function createManageRouter(config) {
  const router = express.Router();

  router.get('/vaults-dir', (req, res) => {
    res.json({ vaultsDir: config.vaultsDir });
  });

  router.get('/ls', async (req, res) => {
    const target = path.resolve(req.query.path || config.vaultsDir);
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      const result = await Promise.all(
        entries
          .filter((e) => !e.name.startsWith('.'))
          .map(async (e) => {
            try {
              const s = await fsp.stat(path.join(target, e.name));
              return {
                name: e.name,
                isDirectory: e.isDirectory(),
                isFile: e.isFile(),
                size: s.size,
                mtime: s.mtime.getTime(),
              };
            } catch (_) {
              return { name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), size: 0, mtime: 0 };
            }
          }),
      );
      res.json({ path: target, parent: path.dirname(target), entries: result });
    } catch (err) {
      res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createManageRouter;
