// Preloaded via `node --test --import ./tests/setup.ts`.
// Populates every required env var with a safe test default so modules that load config
// at import time (logger, db client, redis factories, shutdown) can be tested without a .env file.

import { applyDefaultTestEnv } from './_helpers/env.ts';

applyDefaultTestEnv();
