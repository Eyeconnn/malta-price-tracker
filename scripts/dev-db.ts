// Local throwaway Postgres (PGlite) on port 55439 for testing DB writes without Neon.
// pnpm dev-db   then   DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres?sslmode=disable
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const db = await PGlite.create({ dataDir: process.argv[2] ?? 'memory://', extensions: { pg_trgm } });
const server = new PGLiteSocketServer({ db, port: 55439, host: '127.0.0.1', maxConnections: 10 } as never);
await server.start();
console.log('dev db listening on 127.0.0.1:55439');
process.on('SIGINT', async () => {
  await server.stop();
  await db.close();
  process.exit(0);
});
