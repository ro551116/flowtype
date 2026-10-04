const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Backups must live on the same persistent volume as the events, or every redeploy wipes the version history.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, '_backups');
const ARCHIVE_DIR = path.join(DATA_DIR, '_archived');
const MAX_BACKUPS = 30;
// The editor autosaves after every pause in typing; keep at most one snapshot per interval for those saves.
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;
// Event dates are local (Taiwan) calendar dates.
const EVENT_TIME_ZONE = 'Asia/Taipei';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_STAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
// Response-only fields added by GET; never persisted.
const META_KEYS = ['_archived'];

for (const dir of [DATA_DIR, BACKUP_DIR, ARCHIVE_DIR]) fs.mkdirSync(dir, { recursive: true });

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Ids become file names; anything outside this alphabet (e.g. a decoded "../") is rejected.
app.param('id', (req, res, next, id) => {
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
  next();
});

// ============ Storage helpers ============
const activePath = id => path.join(DATA_DIR, `${id}.json`);
const archivedPath = id => path.join(ARCHIVE_DIR, `${id}.json`);

function locate(id) {
  if (fs.existsSync(activePath(id))) return { file: activePath(id), archived: false };
  if (fs.existsSync(archivedPath(id))) return { file: archivedPath(id), archived: true };
  return null;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function revisionOf(text) {
  return '"' + crypto.createHash('sha1').update(text).digest('hex') + '"';
}

// Write to a temp file and rename so a crash mid-write never leaves a truncated event file.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function serialize(data) {
  const clean = { ...data };
  for (const key of META_KEYS) delete clean[key];
  return JSON.stringify(clean, null, 2);
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateEvent(data) {
  if (!isPlainObject(data)) return 'body must be a JSON object';
  if (!isPlainObject(data.event)) return 'event must be an object';
  for (const key of ['roles', 'rows', 'customFields']) {
    if (data[key] != null && !Array.isArray(data[key])) return `${key} must be an array`;
  }
  return null;
}

function emptyEvent() {
  return {
    event: { name: '', date: '', venue: '', organizer: '', contact: '', phone: '' },
    roles: ['場控', '音控', '燈控', '視訊'],
    rows: []
  };
}

// ============ Backups ============
// Newest first. Only names produced by snapshot() for exactly this id are returned.
function backupFiles(id) {
  const prefix = id + '_';
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json') && BACKUP_STAMP_RE.test(f.slice(prefix.length, -5)))
    .sort()
    .reverse();
}

function backupTime(id, filename) {
  const [, day, hh, mm, ss, ms] = filename.slice(id.length + 1, -5).match(BACKUP_STAMP_RE);
  return Date.parse(`${day}T${hh}:${mm}:${ss}.${ms}Z`);
}

// Save `text` (the version about to be replaced). Unless forced, skip it when the newest backup is recent.
function snapshot(id, text, { force }) {
  const existing = backupFiles(id);
  if (!force && existing.length && Date.now() - backupTime(id, existing[0]) < BACKUP_INTERVAL_MS) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(BACKUP_DIR, `${id}_${stamp}.json`), text, 'utf8');
  for (const f of backupFiles(id).slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
  }
}

// ============ Dates ============
function todayInEventZone() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

// Accepts "2026-04-09", "2026/4/9（四）14:00", "2026.4.9" … and returns "2026-04-09".
function isoDate(text) {
  const m = String(text || '').match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

// ============ Routes ============
// List all events (add ?archived=true to list archived ones)
app.get('/api/events', (req, res) => {
  const showArchived = req.query.archived === 'true';
  const dir = showArchived ? ARCHIVE_DIR : DATA_DIR;
  const events = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || !ID_RE.test(path.basename(f, '.json'))) continue;
    const file = path.join(dir, f);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      events.push({
        id: path.basename(f, '.json'),
        name: data.event?.name || '未命名活動',
        date: data.event?.date || '',
        venue: data.event?.venue || '',
        archived: showArchived,
        updatedAt: fs.statSync(file).mtime.toISOString()
      });
    } catch (err) {
      console.error(`Skipping unreadable event file ${file}: ${err.message}`);
    }
  }
  events.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(events);
});

// Get single event (checks both active and archived). ETag is the revision for If-Match on PUT.
app.get('/api/events/:id', (req, res) => {
  const loc = locate(req.params.id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const text = fs.readFileSync(loc.file, 'utf8');
  const data = JSON.parse(text);
  data._archived = loc.archived;
  res.set('ETag', revisionOf(text));
  res.json(data);
});

// Create new event (empty body → blank template)
app.post('/api/events', (req, res) => {
  const body = isPlainObject(req.body) && Object.keys(req.body).length === 0 ? emptyEvent() : req.body;
  const problem = validateEvent(body);
  if (problem) return res.status(400).json({ error: problem });
  const id = newId();
  writeAtomic(activePath(id), serialize(body));
  res.json({ id });
});

// Update event in place (active or archived).
// With If-Match: rejected with 412 when someone else saved first; backups are throttled (autosave path).
// Without If-Match (or "*"): unconditional overwrite; the replaced version is always backed up.
app.put('/api/events/:id', (req, res) => {
  const { id } = req.params;
  const problem = validateEvent(req.body);
  if (problem) return res.status(400).json({ error: problem });
  const file = locate(id)?.file || activePath(id);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  // Compressing proxies may weaken the ETag (W/"…"); the revision hash itself is what matters.
  const ifMatch = (req.get('If-Match') || '').trim().replace(/^W\//, '');
  const conditional = ifMatch !== '' && ifMatch !== '*';
  if (conditional && (current === null || revisionOf(current) !== ifMatch)) {
    return res.status(412).json({ error: 'conflict', exists: current !== null });
  }
  if (current !== null) snapshot(id, current, { force: !conditional });
  const text = serialize(req.body);
  writeAtomic(file, text);
  res.set('ETag', revisionOf(text));
  res.json({ ok: true });
});

// List backups for an event
app.get('/api/events/:id/backups', (req, res) => {
  const backups = backupFiles(req.params.id).map(f => {
    const stat = fs.statSync(path.join(BACKUP_DIR, f));
    return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
  });
  res.json(backups);
});

// Restore a backup of this event (the current version is backed up first)
app.post('/api/events/:id/restore/:filename', (req, res) => {
  const { id, filename } = req.params;
  if (!backupFiles(id).includes(filename)) return res.status(404).json({ error: 'backup not found' });
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, filename), 'utf8'));
  } catch {
    return res.status(422).json({ error: 'backup is not valid JSON' });
  }
  const loc = locate(id) || { file: activePath(id), archived: false };
  if (fs.existsSync(loc.file)) snapshot(id, fs.readFileSync(loc.file, 'utf8'), { force: true });
  const text = serialize(data);
  writeAtomic(loc.file, text);
  res.set('ETag', revisionOf(text));
  res.json({ ok: true, data: { ...JSON.parse(text), _archived: loc.archived } });
});

function moveEvent(id, src, dst) {
  if (!fs.existsSync(src)) return false;
  // A copy can already exist at the destination (older builds saved edits of archived events as new active files).
  if (fs.existsSync(dst)) snapshot(id, fs.readFileSync(dst, 'utf8'), { force: true });
  fs.renameSync(src, dst);
  return true;
}

// Archive event
app.post('/api/events/:id/archive', (req, res) => {
  const { id } = req.params;
  if (!moveEvent(id, activePath(id), archivedPath(id))) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Unarchive event
app.post('/api/events/:id/unarchive', (req, res) => {
  const { id } = req.params;
  if (!moveEvent(id, archivedPath(id), activePath(id))) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Archive all expired events (date before today in Taiwan)
app.post('/api/events/archive-expired', (req, res) => {
  const today = todayInEventZone();
  const archived = [];
  for (const f of fs.readdirSync(DATA_DIR)) {
    const id = path.basename(f, '.json');
    if (!f.endsWith('.json') || !ID_RE.test(id)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(activePath(id), 'utf8'));
      const eventDate = data.event?.date || '';
      const day = isoDate(eventDate);
      if (day && day < today && moveEvent(id, activePath(id), archivedPath(id))) {
        archived.push({ id, name: data.event?.name, date: eventDate });
      }
    } catch (err) {
      console.error(`archive-expired skipped ${f}: ${err.message}`);
    }
  }
  res.json({ ok: true, archived });
});

// Delete event (checks both active and archived)
app.delete('/api/events/:id', (req, res) => {
  const loc = locate(req.params.id);
  if (loc) fs.unlinkSync(loc.file);
  res.json({ ok: true });
});

// Duplicate event (active or archived); the copy is active
app.post('/api/events/:id/duplicate', (req, res) => {
  const loc = locate(req.params.id);
  if (!loc) return res.status(404).json({ error: 'not found' });
  const data = JSON.parse(fs.readFileSync(loc.file, 'utf8'));
  const problem = validateEvent(data);
  if (problem) return res.status(422).json({ error: problem });
  data.event.name = (data.event.name || '未命名') + ' (副本)';
  const id = newId();
  writeAtomic(activePath(id), serialize(data));
  res.json({ id });
});

// View page (serve view.html for /v/:id)
app.get('/v/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

// JSON errors without stack traces or server paths
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
