#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { preparePiDesktopPlugin } = await import(pathToFileURL(resolve(import.meta.dirname, "../dist/bridge/pi-desktop-plugin.js")).href);
process.stdout.write(preparePiDesktopPlugin().message + "\n");
