// Project store. Two backends: a JSON file (default, local) or PostgreSQL
// (when DATABASE_URL is set, e.g. your DigitalOcean managed DB).
// Projects: { id, name, role, mode, pressure, context, createdAt, updatedAt }.
const fs = require('fs');
const path = require('path');

function defaultCacheFile() { return path.join(__dirname, '..', '.pushback-projects.json'); }

function createStore({ env = {}, file = null, pool = null }) {
  const url = env.DATABASE_URL || (env.DATABASE_HOST && env.DATABASE_USER && env.DATABASE_PASSWORD
    ? `postgresql://${env.DATABASE_USER}:${encodeURIComponent(env.DATABASE_PASSWORD)}@${env.DATABASE_HOST}:${env.DATABASE_PORT || 25060}/projects`
    : null);
  const Pool = pool ? null : require('pg').Pool;
  const pg = pool || (url ? new Pool({ connectionString: url, ssl: env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } }) : null);
  const table = env.DATABASE_TABLE || 'pushback_projects';
  const cacheFile = file || defaultCacheFile();

  const jsonStore = {
    kind: 'json',
    async init() { /* nothing */ },
    async list() {
      try {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    },
    async _write(list) { fs.writeFileSync(cacheFile, JSON.stringify(list, null, 2), { mode: 0o600 }); },
    async get(id) { return (await this.list()).find((p) => p.id === id) || null; },
    async upsert(p) {
      const list = await this.list();
      const i = list.findIndex((x) => x.id === p.id);
      if (i >= 0) list[i] = p; else list.push(p);
      await this._write(list);
      return p;
    },
    async remove(id) {
      const list = await this.list();
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return false;
      await this._write(next);
      return true;
    },
  };

  if (!pg) return jsonStore;

  return {
    kind: 'postgres',
    async init() {
      await pg.query(`CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        mode TEXT NOT NULL,
        pressure TEXT NOT NULL,
        context TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    },
    async list() {
      const r = await pg.query(`SELECT id, name, role, mode, pressure, context, created_at AS createdAt, updated_at AS updatedAt FROM ${table} ORDER BY updated_at DESC`);
      return r.rows;
    },
    async get(id) {
      const r = await pg.query(`SELECT id, name, role, mode, pressure, context, created_at AS createdAt, updated_at AS updatedAt FROM ${table} WHERE id = $1`, [id]);
      return r.rows[0] || null;
    },
    async upsert(p) {
      await pg.query(`INSERT INTO ${table} (id, name, role, mode, pressure, context, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (id) DO UPDATE SET name=$2, role=$3, mode=$4, pressure=$5, context=$6, updated_at=now()`,
        [p.id, p.name, p.role, p.mode, p.pressure, p.context]);
      return p;
    },
    async remove(id) {
      const r = await pg.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      return r.rowCount > 0;
    },
  };
}

// Shallow-validate a project payload from the client; the role must exist in
// the roles registry at validate-time (server.js does the authoritative check).
function sanitizeProject(raw = {}, allowedRoles = null) {
  const p = {};
  p.name = String(raw.name || '').trim().slice(0, 80);
  if (!p.name) return { error: 'Name is required.' };
  p.role = String(raw.role || '').trim();
  if (allowedRoles && !allowedRoles.includes(p.role)) return { error: `Unknown role "${p.role}".` };
  p.mode = ['practice', 'formal'].includes(raw.mode) ? raw.mode : 'practice';
  p.pressure = ['low', 'medium', 'high'].includes(raw.pressure) ? raw.pressure : 'medium';
  p.context = String(raw.context || '').slice(0, 6000).replace(/\u0000/g, '');
  return { project: p };
}

module.exports = { createStore, sanitizeProject };
