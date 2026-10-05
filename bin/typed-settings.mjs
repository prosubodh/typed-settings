#!/usr/bin/env node
import('../dist/cli/main.js').then((m) => m.main()).then((code) => {
  process.exitCode = code;
});
