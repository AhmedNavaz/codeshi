#!/usr/bin/env node
// The codeshi command (#90). See src/cli.mjs and docs/cli.md.
import fs from 'node:fs';
import { main } from '../src/cli.mjs';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
process.exitCode = await main(process.argv.slice(2), { version });
