#!/usr/bin/env node

import { runJsEntry } from "./_run-entry.mjs";

runJsEntry("dist/bridge/werelay-bridge.js", ["--adapter", "pi"]);
