// Project store. Two backends: a JSON file (default, local) or PostgreSQL
// (when DATABASE_URL is set, e.g. your DigitalOcean managed DB).
// Projects: { id, name, role, mode, pressure, durationMin, context, createdAt, updatedAt }.
// Reports:  { id, projectId, projectName, name, overall, report, config, durationSec, createdAt }.
const fs = require('fs');
const path = require('path');

function defaultCacheFile() { return path.join(__dirname, '..', '.pushback-projects.json'); }
function defaultReportsFile() { return path.join(__dirname, '..', '.pushback-reports.json'); }

function createStore({ env = {}, file = null, reportsFile = null, pool = null }) {
  const url = env.DATABASE_URL || (env.DATABASE_HOST && env.DATABASE_USER && env.DATABASE_PASSWORD
    ? `postgresql://${env.DATABASE_USER}:${encodeURIComponent(env.DATABASE_PASSWORD)}@${env.DATABASE_HOST}:${env.DATABASE_PORT || 25060}/projects`
    : null);
  const Pool = pool ? null : require('pg').Pool;
  // Strip sslmode from the connection string: node-postgres would otherwise let the
  // URL's sslmode=require override our explicit ssl option, and DigitalOcean's managed
  // certs trip strict verification. We control TLS via the ssl option instead.
  const cleanUrl = url ? url.replace(/([?&])sslmode=[^&]*&?/, (m, p1) => (p1 === '?' ? '?' : '')).replace(/[?&]$/, '') : null;
  const pg = pool || (cleanUrl ? new Pool({ connectionString: cleanUrl, ssl: env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false } }) : null);
  const table = env.DATABASE_TABLE || 'pushback_projects';
  const reportsTable = env.DATABASE_REPORTS_TABLE || 'pushback_reports';
  const cacheFile = file || defaultCacheFile();
  const cacheRFile = reportsFile || defaultReportsFile();

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
      // Cascade: a project's trials go with it.
      const reps = await this._listReports();
      await this._writeReports(reps.filter((r) => String(r.projectId) !== String(id)));
      return true;
    },
    // Reports are graded per project: every saved report references its project id.
    async _listReports() {
      try {
        const parsed = JSON.parse(fs.readFileSync(cacheRFile, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    },
    async _writeReports(list) { fs.writeFileSync(cacheRFile, JSON.stringify(list, null, 2), { mode: 0o600 }); },
    async listReports(projectId) {
      const all = await this._listReports();
      return all.filter((r) => String(r.projectId) === String(projectId))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map(({ report, config, ...summary }) => summary);
    },
    async addReport(r) {
      const list = await this._listReports();
      list.push(r);
      await this._writeReports(list);
      return r;
    },
    async getReport(id) { return (await this._listReports()).find((r) => r.id === id) || null; },
    async removeReport(id) {
      const list = await this._listReports();
      const next = list.filter((r) => r.id !== id);
      if (next.length === list.length) return false;
      await this._writeReports(next);
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
        duration_min INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pg.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS duration_min INTEGER NOT NULL DEFAULT 0`);
      await pg.query(`CREATE TABLE IF NOT EXISTS ${reportsTable} (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        project_name TEXT,
        name TEXT,
        overall INTEGER,
        report JSONB NOT NULL,
        config JSONB,
        duration_sec INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      await pg.query(`CREATE INDEX IF NOT EXISTS ${reportsTable}_project_idx ON ${reportsTable} (project_id)`);
    },
    async list() {
      const r = await pg.query(`SELECT id, name, role, mode, pressure, context, duration_min AS "durationMin", created_at AS "createdAt", updated_at AS "updatedAt" FROM ${table} ORDER BY updated_at DESC`);
      return r.rows;
    },
    async get(id) {
      const r = await pg.query(`SELECT id, name, role, mode, pressure, context, duration_min AS "durationMin", created_at AS "createdAt", updated_at AS "updatedAt" FROM ${table} WHERE id = $1`, [id]);
      return r.rows[0] || null;
    },
    async upsert(p) {
      await pg.query(`INSERT INTO ${table} (id, name, role, mode, pressure, context, duration_min, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, now())
        ON CONFLICT (id) DO UPDATE SET name=$2, role=$3, mode=$4, pressure=$5, context=$6, duration_min=$7, updated_at=now()`,
        [p.id, p.name, p.role, p.mode, p.pressure, p.context, p.durationMin || 0]);
      return p;
    },
    async remove(id) {
      const r = await pg.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      await pg.query(`DELETE FROM ${reportsTable} WHERE project_id = $1`, [id]); // cascade trials
      return r.rowCount > 0;
    },
    async listReports(projectId) {
      const r = await pg.query(`SELECT id, project_id AS "projectId", project_name AS "projectName", name, overall, duration_sec AS "durationSec", created_at AS "createdAt" FROM ${reportsTable} WHERE project_id = $1 ORDER BY created_at DESC`, [projectId]);
      return r.rows;
    },
    async addReport(rep) {
      await pg.query(`INSERT INTO ${reportsTable} (id, project_id, project_name, name, overall, report, config, duration_sec)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [rep.id, rep.projectId, rep.projectName, rep.name, rep.overall, JSON.stringify(rep.report), JSON.stringify(rep.config), rep.durationSec]);
      return rep;
    },
    async getReport(id) {
      const r = await pg.query(`SELECT id, project_id AS "projectId", project_name AS "projectName", name, overall, report, config, duration_sec AS "durationSec", created_at AS "createdAt" FROM ${reportsTable} WHERE id = $1`, [id]);
      return r.rows[0] || null;
    },
    async removeReport(id) {
      const r = await pg.query(`DELETE FROM ${reportsTable} WHERE id = $1`, [id]);
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
  const d = parseInt(raw.durationMin, 10);
  p.durationMin = Number.isFinite(d) ? Math.min(60, Math.max(0, d)) : 0;
  return { project: p };
}

// Validate a report payload being saved against a project. Keeps the full
// report/config JSON (needed to re-open the Report screen later) but bounds size.
function sanitizeReport(raw = {}, allowedProjectIds = null) {
  const projectId = String(raw.projectId || '').slice(0, 40);
  if (!projectId) return { error: 'projectId is required.' };
  if (allowedProjectIds && !allowedProjectIds.includes(projectId)) return { error: `Unknown project "${projectId}".` };
  const report = raw.report && typeof raw.report === 'object' ? raw.report : null;
  if (!report) return { error: 'report payload is required.' };
  if (JSON.stringify(report).length > 400 * 1024) return { error: 'Report too large.' };
  const config = raw.config && typeof raw.config === 'object' ? raw.config : {};
  const overall = parseInt(raw.overall, 10);
  const durationSec = parseInt(raw.durationSec, 10);
  return {
    reportRow: {
      projectId,
      projectName: String(raw.projectName || '').slice(0, 80) || null,
      name: String(raw.name || '').slice(0, 80) || null,
      overall: Number.isFinite(overall) ? Math.min(100, Math.max(0, overall)) : null,
      report,
      config,
      durationSec: Number.isFinite(durationSec) ? Math.min(6 * 3600, Math.max(0, durationSec)) : null,
    },
  };
}

module.exports = { createStore, sanitizeProject, sanitizeReport };
