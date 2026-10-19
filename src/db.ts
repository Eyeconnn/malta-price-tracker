import postgres from 'postgres';
import { env } from './env.js';

let client: postgres.Sql | undefined;

export function db(): postgres.Sql {
  if (!client) {
    client = postgres(env('DATABASE_URL'), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 30,
      onnotice: () => {},
    });
  }
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) await client.end({ timeout: 5 });
  client = undefined;
}
