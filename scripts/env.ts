import fs from 'node:fs';

/** Loads .env.local, then .env, the way Next does, so scripts see the same settings as the app. */
export function loadEnv(): void {
  for (const file of ['.env.local', '.env']) {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  }
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL first. See .env.example, or run docker compose up -d for a local Postgres.');
    process.exit(1);
  }
  return url;
}

/** Hides the password when printing a connection string. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}
