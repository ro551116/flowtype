const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtype-test-'));
const DATA_DIR = path.join(ROOT, 'data');
process.env.DATA_DIR = DATA_DIR;
delete process.env.BACKUP_DIR;
const app = require('../server');

let base;
let server;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function call(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(base + url, opts);
}

async function createEvent(event = {}) {
  const res = await call('POST', '/api/events', { event: { name: 't', ...event }, roles: ['場控'], rows: [] });
  return (await res.json()).id;
}

const backupsOf = id => fs.readdirSync(path.join(DATA_DIR, '_backups')).filter(f => f.startsWith(id + '_'));

test('ids and backup names cannot escape the data directory', async () => {
  const outside = path.join(ROOT, 'outside.json');
  fs.writeFileSync(outside, '{"secret":true}');

  for (const [method, url] of [
    ['PUT', '/api/events/..%2Foutside'],
    ['DELETE', '/api/events/..%2Foutside'],
    ['GET', '/api/events/..%2Foutside'],
  ]) {
    const res = await call(method, url, method === 'PUT' ? { event: {} } : undefined);
    assert.strictEqual(res.status, 400, `${method} ${url}`);
  }
  assert.ok(fs.existsSync(outside));

  const id = await createEvent();
  const res = await call('POST', `/api/events/${id}/restore/..%2F..%2Foutside.json`);
  assert.strictEqual(res.status, 404);
  assert.doesNotMatch(await res.text(), /secret/);
});

test('a backup of one event cannot be restored into another', async () => {
  const a = await createEvent({ name: 'A' });
  const b = await createEvent({ name: 'B' });
  await call('PUT', `/api/events/${a}`, { event: { name: 'A2' }, roles: [], rows: [] });
  const [backup] = backupsOf(a);
  assert.ok(backup);
  assert.strictEqual((await call('POST', `/api/events/${b}/restore/${backup}`)).status, 404);

  const res = await call('POST', `/api/events/${a}/restore/${backup}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).data.event.name, 'A');
});

test('backups live under DATA_DIR; autosaves are throttled, unconditional overwrites are not', async () => {
  const id = await createEvent();
  const doc = name => ({ event: { name }, roles: [], rows: [] });
  let rev = (await call('GET', `/api/events/${id}`)).headers.get('etag');

  for (const name of ['v1', 'v2', 'v3']) {
    const res = await call('PUT', `/api/events/${id}`, doc(name), { 'If-Match': rev });
    assert.strictEqual(res.status, 200);
    rev = res.headers.get('etag');
  }
  assert.strictEqual(backupsOf(id).length, 1, 'one snapshot per interval for autosaves');

  assert.strictEqual((await call('PUT', `/api/events/${id}`, doc('cli'))).status, 200);
  assert.strictEqual(backupsOf(id).length, 2, 'overwrite without If-Match is always backed up');
});

test('stale If-Match is rejected and leaves the newer version intact', async () => {
  const id = await createEvent({ name: 'base' });
  const rev = (await call('GET', `/api/events/${id}`)).headers.get('etag');
  const doc = name => ({ event: { name }, roles: [], rows: [] });

  assert.strictEqual((await call('PUT', `/api/events/${id}`, doc('tab A'), { 'If-Match': rev })).status, 200);
  const stale = await call('PUT', `/api/events/${id}`, doc('tab B'), { 'If-Match': rev });
  assert.strictEqual(stale.status, 412);
  assert.strictEqual((await (await call('GET', `/api/events/${id}`)).json()).event.name, 'tab A');

  assert.strictEqual((await call('PUT', `/api/events/${id}`, doc('tab B'), { 'If-Match': '*' })).status, 200);
  assert.strictEqual((await (await call('GET', `/api/events/${id}`)).json()).event.name, 'tab B');
});

test('editing an archived event updates it in the archive without leaking meta fields', async () => {
  const id = await createEvent({ name: 'old' });
  await call('POST', `/api/events/${id}/archive`);
  const got = await call('GET', `/api/events/${id}`);
  const data = await got.json();
  assert.strictEqual(data._archived, true);

  data.event.name = 'edited';
  const res = await call('PUT', `/api/events/${id}`, data, { 'If-Match': got.headers.get('etag') });
  assert.strictEqual(res.status, 200);

  assert.ok(!fs.existsSync(path.join(DATA_DIR, `${id}.json`)), 'no copy in the active list');
  const stored = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '_archived', `${id}.json`), 'utf8'));
  assert.strictEqual(stored.event.name, 'edited');
  assert.ok(!('_archived' in stored));
});

test('malformed documents are rejected; an empty create gets the blank template', async () => {
  const empty = await call('POST', '/api/events');
  const { id } = await empty.json();
  const created = await (await call('GET', `/api/events/${id}`)).json();
  assert.deepStrictEqual(created.event, { name: '', date: '', venue: '', organizer: '', contact: '', phone: '' });

  assert.strictEqual((await call('PUT', `/api/events/${id}`, { rows: [] })).status, 400);
  assert.strictEqual((await call('PUT', `/api/events/${id}`, { event: {}, rows: 'x' })).status, 400);
  assert.strictEqual((await call('POST', '/api/events', '{bad json')).status, 400);
});

test('a corrupt event file yields a JSON 500 without stack traces', async () => {
  fs.writeFileSync(path.join(DATA_DIR, 'broken1.json'), '{bad');
  const original = console.error;
  console.error = () => {};
  try {
    const res = await call('GET', '/api/events/broken1');
    assert.strictEqual(res.status, 500);
    const body = await res.text();
    assert.deepStrictEqual(JSON.parse(body), { error: 'internal error' });
  } finally {
    console.error = original;
    fs.unlinkSync(path.join(DATA_DIR, 'broken1.json'));
  }
});

test('archive-expired compares against the Taiwan calendar date', async (t) => {
  // 2026-10-04 17:00 UTC is already 2026-10-05 01:00 in Taipei.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-04T17:00:00Z') });
  const yesterday = await createEvent({ date: '2026-10-04' });
  const freeText = await createEvent({ date: '2026/10/4（日）14:00' });
  const today = await createEvent({ date: '2026-10-05' });

  const res = await call('POST', '/api/events/archive-expired');
  const ids = (await res.json()).archived.map(e => e.id);
  assert.ok(ids.includes(yesterday));
  assert.ok(ids.includes(freeText));
  assert.ok(!ids.includes(today));
});
