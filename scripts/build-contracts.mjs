#!/usr/bin/env node
/**
 * Compile the Solidity sources and emit ABI + bytecode to build/contracts/.
 *
 * Kaleido's Smart Contract Manager compiles from a GitHub URL in production, so
 * this exists for local testing and to produce the ABI the application imports.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const solc = require('solc');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const contractsDir = join(root, 'contracts');
const outDir = join(root, 'build', 'contracts');

const sources = {};
for (const file of readdirSync(contractsDir).filter((f) => f.endsWith('.sol'))) {
  sources[file] = { content: readFileSync(join(contractsDir, file), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));

const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length > 0) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

for (const warning of (output.errors ?? []).filter((e) => e.severity === 'warning')) {
  console.warn(warning.formattedMessage);
}

mkdirSync(outDir, { recursive: true });

let written = 0;
for (const [file, contracts] of Object.entries(output.contracts ?? {})) {
  for (const [name, artifact] of Object.entries(contracts)) {
    writeFileSync(
      join(outDir, `${name}.json`),
      `${JSON.stringify(
        {
          contractName: name,
          sourceName: file,
          abi: artifact.abi,
          bytecode: `0x${artifact.evm.bytecode.object}`,
        },
        null,
        2,
      )}\n`,
    );
    written += 1;
    console.log(`compiled ${name} (${artifact.evm.bytecode.object.length / 2} bytes)`);
  }
}

if (written === 0) {
  console.error('no contracts compiled');
  process.exit(1);
}
