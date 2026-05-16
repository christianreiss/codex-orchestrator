import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_DATABASE ?? 'codex_auth',
    user: process.env.DB_USERNAME ?? 'codex',
    password: process.env.DB_PASSWORD ?? '',
  },
  verbose: true,
  strict: true,
});
