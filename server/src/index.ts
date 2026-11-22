import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv, Env } from './types';
import { ApiError } from './lib/http';
import { runMaintenance } from './maintenance';
import { registerAdmin } from './routes/admin';
import { registerAuth } from './routes/auth';
import { registerFiles } from './routes/files';
import { registerFull } from './routes/full';
import { registerTally } from './routes/tally';
import { registerUsers } from './routes/users';

const app = new Hono<AppEnv>();

// The desktop app authenticates with bearer tokens (no cookies), so any origin is safe.
app.use(
  '/api/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'X-Raw-Size', 'X-Device', 'Range'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'X-Raw-Size'],
    maxAge: 86400,
  }),
);

app.get('/', (c) => c.text('AM Backup API is running.'));

registerAuth(app);
registerUsers(app);
registerFiles(app);
registerFull(app);
registerAdmin(app);
registerTally(app);

app.notFound((c) => c.json({ error: 'Not found.', code: 'not_found' }, 404));

app.onError((err, c) => {
  if (err instanceof ApiError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error('Unhandled error', err);
  return c.json({ error: 'Something went wrong on the server. Please try again.', code: 'internal' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runMaintenance(env).then(
        (report) => console.log('maintenance', JSON.stringify(report)),
        (err) => console.error('maintenance failed', err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
