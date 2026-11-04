import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where contexts, classes and activities live between restarts.
 *
 * Two backends behind one tiny key-value interface:
 *
 *   - Postgres, when DATABASE_URL is set. This is the one that survives a free
 *     Render instance going to sleep: the web service's own disk is wiped every
 *     time it spins down, a database is not.
 *   - Files under DATA_DIR otherwise. Fine on your own machine or on a Render
 *     plan with a persistent disk; on a free instance it lasts only until the
 *     next sleep, which is why the console offers a workspace backup too.
 *
 * Everything is stored as one JSON document per record, under a collection
 * name ("contexts", "classes", "activities"). Nothing here knows what the
 * records mean.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const COLLECTION = /^[a-z]+$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function check(collection, id) {
  if (!COLLECTION.test(collection)) throw new Error(`bad collection ${collection}`);
  if (id !== undefined && !ID.test(id)) throw new Error(`bad id ${id}`);
}

/** JSON files: DATA_DIR/<collection>/<id>.json, written atomically. */
export function fileStore(dir = process.env.DATA_DIR || path.join(here, '..', 'data')) {
  const fileFor = (collection, id) => path.join(dir, collection, `${id}.json`);
  return {
    kind: 'files',
    durable: Boolean(process.env.DATA_DIR) || !process.env.RENDER,
    describe: () => `files in ${dir}`,
    async init() { await fs.mkdir(dir, { recursive: true }); },
    async get(collection, id) {
      check(collection, id);
      try { return JSON.parse(await fs.readFile(fileFor(collection, id), 'utf8')); }
      catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    },
    async put(collection, id, value) {
      check(collection, id);
      const file = fileFor(collection, id);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, JSON.stringify(value));
      await fs.rename(temp, file);
    },
    async list(collection) {
      check(collection);
      let names = [];
      try { names = await fs.readdir(path.join(dir, collection)); }
      catch (err) { if (err.code === 'ENOENT') return []; throw err; }
      const out = [];
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        const value = await this.get(collection, name.slice(0, -5));
        if (value) out.push(value);
      }
      return out;
    },
    async remove(collection, id) {
      check(collection, id);
      await fs.rm(fileFor(collection, id), { force: true });
    },
  };
}

/** Postgres: one table, one row per record, the record as jsonb. */
export function pgStore(pool) {
  return {
    kind: 'postgres',
    durable: true,
    describe: () => 'Postgres (DATABASE_URL)',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS hon_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      )`);
    },
    async get(collection, id) {
      check(collection, id);
      const { rows } = await pool.query(
        'SELECT value FROM hon_records WHERE collection = $1 AND id = $2', [collection, id]
      );
      return rows[0]?.value ?? null;
    },
    async put(collection, id, value) {
      check(collection, id);
      await pool.query(
        `INSERT INTO hon_records (collection, id, value, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (collection, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [collection, id, JSON.stringify(value)]
      );
    },
    async list(collection) {
      check(collection);
      const { rows } = await pool.query(
        'SELECT value FROM hon_records WHERE collection = $1 ORDER BY updated_at', [collection]
      );
      return rows.map((row) => row.value);
    },
    async remove(collection, id) {
      check(collection, id);
      await pool.query('DELETE FROM hon_records WHERE collection = $1 AND id = $2', [collection, id]);
    },
  };
}

/** The store this server uses, chosen from the environment. */
export async function openStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // Render's external database URLs need TLS; its internal ones refuse it.
      ssl: /render\.com/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      max: 4,
    });
    const store = pgStore(pool);
    await store.init();
    return store;
  }
  const store = fileStore();
  await store.init();
  return store;
}

/** Short random ids — readable in a URL, unguessable enough for a classroom. */
export function newId(prefix) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 10; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}_${out}`;
}
