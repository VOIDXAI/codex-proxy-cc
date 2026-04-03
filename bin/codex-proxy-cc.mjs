#!/usr/bin/env node

import { main } from "../src/cli.mjs";

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
