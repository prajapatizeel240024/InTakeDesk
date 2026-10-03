import { getConfig } from './config';
import { createClaudeExtractor, type Extractor } from './extract';
import { seedDemoData } from './seed';
import type { Ctx } from './service';
import { MemoryStore, type Store } from './store';
import { PgStore } from './store-pg';
import { createClaudeViewAgent, type ViewAgent } from './views';

interface Base {
  store: Store;
  extractor: Extractor;
  viewAgent: ViewAgent;
}

const holder = globalThis as unknown as { __intakeDesk?: Promise<Base> };

async function init(): Promise<Base> {
  let store: Store;
  if (process.env.DATABASE_URL) {
    store = PgStore.fromUrl(process.env.DATABASE_URL);
  } else {
    const memory = new MemoryStore();
    const added = await seedDemoData(memory, getConfig());
    console.warn(
      `[intake-desk] DATABASE_URL is not set, so this is running on an in-memory store with ${added} seeded referrals. It resets when the server restarts.`,
    );
    store = memory;
  }
  return { store, extractor: createClaudeExtractor(), viewAgent: createClaudeViewAgent() };
}

/** One store and client per server process. The config is re-read whenever config/intake.yaml changes. */
export async function getContext(): Promise<Ctx> {
  holder.__intakeDesk ??= init().catch((err) => {
    holder.__intakeDesk = undefined;
    throw err;
  });
  const base = await holder.__intakeDesk;
  return { ...base, config: getConfig() };
}
