import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../jesse/static/review/', import.meta.url);
const read = name => readFileSync(new URL(name, dir), 'utf8');
const modules = readdirSync(dir).filter(name => name.endsWith('.mjs'));

test('index.html loads app.mjs and the stylesheet with its REVIEW_VERSION', () => {
  const html = read('index.html');
  const version = /const REVIEW_VERSION = '([^']+)'/.exec(html)?.[1];
  assert.match(version ?? '', /^[\w.-]+$/);
  assert.ok(html.includes('import(`./app.mjs?v=${REVIEW_VERSION}`)'));
  assert.ok(html.includes(`href="./review.css?v=${version}"`));
  assert.ok(!/src="\.\/app\.mjs/.test(html), 'app.mjs must only be loaded through the versioned loader');
});

test('every relative import in every module carries the same version as index.html', () => {
  const version = /const REVIEW_VERSION = '([^']+)'/.exec(read('index.html'))[1];
  let checked = 0;
  for (const name of modules) {
    for (const match of read(name).matchAll(/(?:from|import)\s*\(?\s*'(\.[^']*)'/g)) {
      const specifier = match[1];
      // The bundled chart library has a content-hashed file name instead.
      if (specifier.includes('/_nuxt/')) continue;
      assert.ok(specifier.endsWith(`.mjs?v=${version}`), `${name}: ${specifier} must end with ?v=${version}`);
      assert.ok(modules.includes(specifier.slice(2, specifier.indexOf('?'))), `${name}: ${specifier} does not exist`);
      checked++;
    }
  }
  assert.ok(checked >= 7);
});
