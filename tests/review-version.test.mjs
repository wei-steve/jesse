import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { tooltipData } from '../jesse/static/review/tooltip.mjs';

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

test('tooltip data lists time, MA lines with colours and BOLL bands', () => {
  const values = pairs => new Map(pairs);
  const overlays = [
    { title: 'MA', lines: [{ name: 'SMA5', color: '#e6194b', values: values([[60, 1.5]]) }, { name: 'SMA7', color: '#f58231', values: values([]) }] },
    { title: 'BOLL(20,2)', lines: [{ name: '上轨', color: '#5488c9', values: values([[60, 3]]) }, { name: '中轨', color: '#5488c9', values: values([[60, 2]]) }, { name: '下轨', color: '#5488c9', values: values([[60, 1]]) }] },
    { title: 'SMA(9)', lines: [{ name: 'SMA9', color: '#dd9a23', values: values([[60, 7]]) }] },
  ];
  const data = tooltipData(overlays, 60);
  assert.equal(data.time, 60);
  assert.deepEqual(data.groups[0].items, [{ label: 'SMA5', color: '#e6194b', value: 1.5 }, { label: 'SMA7', color: '#f58231', value: undefined }]);
  assert.deepEqual(data.groups[1].items.map(i => i.label), ['上轨', '中轨', '下轨']);
  assert.equal(data.groups[2].items[0].label, '');
  assert.equal(tooltipData(overlays, undefined), null);
  assert.deepEqual(tooltipData([], 60).groups, []);
});
