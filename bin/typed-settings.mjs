#!/usr/bin/env node
import('../dist/cli/main.js').then((m) => m.main()).then((code) => {
  process.exitCode = code;
}).catch((e) => {
  // A failed import (missing dist/, broken install) must fail the CI gate,
  // not pass it with exit 0 via an unhandled rejection.
  console.error(e?.message ?? e);
  process.exitCode = 2;
});
