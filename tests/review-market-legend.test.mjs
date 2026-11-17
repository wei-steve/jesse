import test from 'node:test';
import assert from 'node:assert/strict';
import { INDICATORS, MARKET_STORAGE_KEY, STORAGE_KEY, defaultMaLines, validateIndicator } from '../jesse/static/review/settings.mjs';
import { legendItems } from '../jesse/static/review/market-legend.mjs';
import { mountIndicatorEditor } from '../jesse/static/review/controls.mjs';

test('legendItems formats MAGROUP MA/EMA, BOLL three lines, lookup by time, missing time, and latest when unhovered', () => {
  const maConfig = {
    type: 'MAGROUP',
    mode: 'SMA',
    lines: defaultMaLines().map((l, i) => ({ ...l, enabled: i < 2 })), // MA5, MA7
  };
  const emaConfig = {
    type: 'MAGROUP',
    mode: 'EMA',
    lines: defaultMaLines().map((l, i) => ({ ...l, enabled: i === 0 })), // EMA5
  };
  const bollConfig = validateIndicator({ type: 'BOLL', period: 20, deviation: 2, color: '#5488c9' });

  const groups = [
    {
      config: maConfig,
      lines: [
        { color: '#e6194b', values: new Map([[60, 100], [120, 105]]), latest: 105 },
        { color: '#f58231', values: new Map([[120, 102]]), latest: 102 },
      ],
    },
    {
      config: emaConfig,
      lines: [
        { color: '#e6194b', values: new Map([[60, 99], [120, 104]]), latest: 104 },
      ],
    },
    {
      config: bollConfig,
      lines: [
        { color: '#5488c9', values: new Map([[60, 110], [120, 115]]), latest: 115 },
        { color: '#5488c9', values: new Map([[60, 100], [120, 105]]), latest: 105 },
        { color: '#5488c9', values: new Map([[60, 90], [120, 95]]), latest: 95 },
      ],
    },
  ];

  // Unhovered (time = null): uses latest values
  const latest = legendItems(groups, null);
  assert.deepEqual(latest.map(g => g.type), ['MAGROUP', 'MAGROUP', 'BOLL']);
  assert.deepEqual(latest[0].items.map(i => [i.label, i.value]), [['MA5', 105], ['MA7', 102]]);
  assert.deepEqual(latest[1].items.map(i => [i.label, i.value]), [['EMA5', 104]]);
  assert.equal(latest[2].title, 'BOLL(20,2)');
  assert.deepEqual(latest[2].items.map(i => [i.label, i.value]), [['上', 115], ['中', 105], ['下', 95]]);

  // Hovered at t=60: MA7 has no value at 60 -> null
  const at60 = legendItems(groups, 60);
  assert.deepEqual(at60[0].items.map(i => [i.label, i.value]), [['MA5', 100], ['MA7', null]]);
  assert.deepEqual(at60[2].items.map(i => [i.label, i.value]), [['上', 110], ['中', 100], ['下', 90]]);

  // Hovered at missing time t=999 -> all null
  const at999 = legendItems(groups, 999);
  assert.deepEqual(at999[0].items.map(i => i.value), [null, null]);
  assert.deepEqual(at999[2].items.map(i => i.value), [null, null, null]);
});

function createFakeDom() {
  const byId = new Map();
  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.style = {};
      this.className = '';
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.textContent = '';
      this.parentElement = null;
      this._id = '';
      this.classList = {
        set: new Set(),
        toggle: (name, force) => {
          if (force === undefined) {
            if (this.classList.set.has(name)) this.classList.set.delete(name);
            else this.classList.set.add(name);
          } else if (force) this.classList.set.add(name);
          else this.classList.set.delete(name);
        },
      };
    }
    set id(val) {
      this._id = val;
      if (val) byId.set(val, this);
    }
    get id() { return this._id; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === 'object' && node !== null) {
          node.parentElement = this;
          this.children.push(node);
        }
      }
    }
    replaceChildren(...nodes) {
      this.children = [];
      this.append(...nodes);
    }
  }
  const doc = {
    createElement: tag => new FakeElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    getElementById: id => byId.get(id) ?? null,
  };
  for (const id of ['indicator-form', 'indicator-type', 'indicator-params', 'indicator-color',
    'save-indicator', 'cancel-indicator', 'indicator-list', 'settings-message']) {
    const el = doc.createElement(id === 'indicator-form' ? 'form' : id === 'indicator-type' ? 'select' : 'div');
    el.id = id;
    if (id === 'indicator-color') {
      const parent = doc.createElement('label');
      parent.append(el);
    }
  }
  return doc;
}

test('mountIndicatorEditor filters types to main-pane indicators and saves to the given storageKey', () => {
  const prevDocument = globalThis.document;
  const prevStorage = globalThis.localStorage;
  const store = new Map();
  globalThis.document = createFakeDom();
  globalThis.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };

  try {
    const mainTypes = Object.keys(INDICATORS).filter(t => INDICATORS[t].pane === 'main');
    assert.deepEqual(mainTypes, ['MAGROUP', 'SMA', 'EMA', 'BOLL']);

    const prefs = { version: 1, intervals: null, showPanes: true, showValues: false, showConditions: true, indicators: [] };
    let changedCalls = 0;
    mountIndicatorEditor(prefs, {
      storageKey: MARKET_STORAGE_KEY,
      types: mainTypes,
      changed: () => { changedCalls++; },
    });

    const typeSelect = globalThis.document.getElementById('indicator-type');
    assert.deepEqual(typeSelect.children.map(o => o.value), ['MAGROUP', 'SMA', 'EMA', 'BOLL']);

    // Switch to BOLL and submit form
    typeSelect.value = 'BOLL';
    typeSelect.onchange();
    globalThis.document.getElementById('indicator-period').value = '20';
    globalThis.document.getElementById('indicator-deviation').value = '2';
    globalThis.document.getElementById('indicator-color').value = '#5488c9';
    globalThis.document.getElementById('indicator-form').onsubmit({ preventDefault() {} });

    assert.equal(changedCalls, 1);
    assert.equal(prefs.indicators.length, 1);
    assert.equal(prefs.indicators[0].type, 'BOLL');
    assert.ok(store.has(MARKET_STORAGE_KEY));
    assert.equal(store.has(STORAGE_KEY), false);
    const saved = JSON.parse(store.get(MARKET_STORAGE_KEY));
    assert.deepEqual(saved.indicators.map(i => i.type), ['BOLL']);
  } finally {
    globalThis.document = prevDocument;
    globalThis.localStorage = prevStorage;
  }
});
