#!/usr/bin/env node
import { run } from "../src/cli.mjs";

const argv = process.argv.slice(2);

run(argv).catch((error) => {
  process.stderr.write(`jevrail: ${error.message}\n`);
  // A hook must never block the agent by crashing; exit 0 so it carries on.
  process.exit(argv[0] === "hook" ? 0 : 1);
});
