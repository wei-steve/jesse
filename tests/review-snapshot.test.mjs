import test from 'node:test';
import assert from 'node:assert/strict';
import { gridLayout, snapshotFileName, utcStamp } from '../jesse/static/review/snapshot.mjs';

const size = (width, height) => ({ width, height });

test('gridLayout puts two columns under the header band, rows gap apart', () => {
  const layout = gridLayout([size(400, 200), size(400, 200), size(400, 200)], 2, 8, 28);
  assert.equal(layout.width, 808);
  assert.equal(layout.height, 28 + 200 + 8 + 200);
  assert.deepEqual(layout.cells, [
    { x: 0, y: 28, width: 400, height: 200 },
    { x: 408, y: 28, width: 400, height: 200 },
    { x: 0, y: 236, width: 400, height: 200 },
  ]);
});

test('columns widen to their widest image and images are centred in their cell', () => {
  const layout = gridLayout([size(300, 100), size(500, 120)], 2, 10, 0);
  assert.equal(layout.width, 810);
  assert.equal(layout.height, 120);
  assert.deepEqual(layout.cells, [
    { x: 0, y: 10, width: 300, height: 100 },
    { x: 310, y: 0, width: 500, height: 120 },
  ]);
});

test('a single image does not leave an empty second column', () => {
  const layout = gridLayout([size(320, 180)], 2, 8, 28);
  assert.equal(layout.width, 320);
  assert.equal(layout.height, 208);
  assert.deepEqual(layout.cells, [{ x: 0, y: 28, width: 320, height: 180 }]);
});

test('no images keeps only the header height', () => {
  assert.deepEqual(gridLayout([], 2, 8, 28), { width: 0, height: 28, headerHeight: 28, gap: 8, columns: 2, cells: [] });
  assert.deepEqual(gridLayout(undefined).cells, []);
});

test('snapshot file names are UTC, compact and keep the label readable', () => {
  const when = new Date('2026-11-12T15:30:45Z');
  assert.equal(snapshotFileName(when, '3m'), '20261112-153045-3m.png');
  assert.equal(snapshotFileName(when, 'finder-3m'), '20261112-153045-finder-3m.png');
  // Runs of other characters collapse into one dash; the label never carries a path or a space.
  assert.equal(snapshotFileName(when, 'review all/multi'), '20261112-153045-review-all-multi.png');
  assert.equal(snapshotFileName(when, '  ../3m  '), '20261112-153045-3m.png');
  assert.equal(snapshotFileName(when, ''), '20261112-153045-snapshot.png');
  assert.equal(snapshotFileName(when, 'a'.repeat(80)), `20261112-153045-${'a'.repeat(40)}.png`);
});

test('the header stamp is UTC minutes without a timezone suffix', () => {
  assert.equal(utcStamp(new Date('2026-10-27T20:21:33Z')), '2026-10-27 20:21');
});
