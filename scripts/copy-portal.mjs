#!/usr/bin/env node
/**
 * Copy the browser assets into the build output.
 *
 * `tsc` only emits `.ts`, so the HTML pages and the `.mjs` modules would be
 * absent from a compiled deployment and both the examiner portal and the
 * operator console would 500 — while every test passed, because tests run from
 * source.
 */
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundles = ['portal', 'operator'];

let total = 0;

for (const bundle of bundles) {
  const from = join(root, 'src', bundle);
  const to = join(root, 'dist', 'src', bundle);
  await mkdir(to, { recursive: true });

  // `.ts` is compiled by tsc; everything else here is served verbatim.
  const assets = (await readdir(from)).filter((name) => !name.endsWith('.ts'));
  for (const name of assets) {
    await copyFile(join(from, name), join(to, name));
    console.log(`copied ${bundle}/${name}`);
    total += 1;
  }
}

if (total === 0) {
  console.error('no browser assets found');
  process.exit(1);
}
