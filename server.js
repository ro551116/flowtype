const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'data', '_backups');
const ARCHIVE_DIR = path.join(DATA_DIR, '_archived');
const MAX_BACKUPS = 30;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// List all events (add ?archived=true to list archived ones)
app.get('/api/events', (req, res) => {
  const showArchived = req.query.archived === 'true';
  const dir = showArchived ? ARCHIVE_DIR : DATA_DIR;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const events = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: path.basename(f, '.json'),
        name: data.event?.name || '未命名活動',
        date: data.event?.date || '',
        venue: data.event?.venue || '',
        archived: showArchived,
        updatedAt: fs.statSync(path.join(dir, f)).mtime.toISOString()
      };
    } catch { return null; }
  }).filter(Boolean);
  events.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(events);
});

// Get single event (checks both active and archived)
app.get('/api/events/:id', (req, res) => {
  let filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  let archived = false;
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ARCHIVE_DIR, `${req.params.id}.json`);
    archived = true;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  }
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  data._archived = archived;
  res.json(data);
});

// Create new event
app.post('/api/events', (req, res) => {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const filePath = path.join(DATA_DIR, `${id}.json`);
  const data = req.body || {
    event: { name: '', date: '', venue: '', organizer: '', contact: '', phone: '' },
    roles: ['場控', '音控', '燈控', '視訊'],
    rows: []
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  res.json({ id });
});

// Update event (with auto-backup)
app.put('/api/events/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  // Backup previous version before overwriting
  if (fs.existsSync(filePath)) {
    try {
      const prev = fs.readFileSync(filePath, 'utf8');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(BACKUP_DIR, `${req.params.id}_${ts}.json`);
      fs.writeFileSync(backupPath, prev, 'utf8');
      // Prune old backups for this event
      const prefix = req.params.id + '_';
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .sort().reverse();
      backups.slice(MAX_BACKUPS).forEach(f => {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      });
    } catch {}
  }
  fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ ok: true });
});

// List backups for an event
app.get('/api/events/:id/backups', (req, res) => {
  const prefix = req.params.id + '_';
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        const ts = f.slice(prefix.length, -5).replace(/-/g, (m, i) => {
          // Restore ISO format: first 2 dashes are date separators, T separator, then colons, dot
          return m;
        });
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { filename: f, size: stat.size, createdAt: stat.mtime.toISOString() };
      });
    res.json(backups);
  } catch {
    res.json([]);
  }
});

// Restore a backup
app.post('/api/events/:id/restore/:filename', (req, res) => {
  const backupPath = path.join(BACKUP_DIR, req.params.filename);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'backup not found' });
  // Backup current version first
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const prev = fs.readFileSync(filePath, 'utf8');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(BACKUP_DIR, `${req.params.id}_${ts}.json`), prev, 'utf8');
    } catch {}
  }
  const data = fs.readFileSync(backupPath, 'utf8');
  fs.writeFileSync(filePath, data, 'utf8');
  res.json({ ok: true, data: JSON.parse(data) });
});

// Archive event
app.post('/api/events/:id/archive', (req, res) => {
  const src = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'not found' });
  const dst = path.join(ARCHIVE_DIR, `${req.params.id}.json`);
  fs.renameSync(src, dst);
  res.json({ ok: true });
});

// Unarchive event
app.post('/api/events/:id/unarchive', (req, res) => {
  const src = path.join(ARCHIVE_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'not found' });
  const dst = path.join(DATA_DIR, `${req.params.id}.json`);
  fs.renameSync(src, dst);
  res.json({ ok: true });
});

// Archive all expired events (date < today)
app.post('/api/events/archive-expired', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const archived = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const eventDate = data.event?.date || '';
      // Normalize date: extract YYYY-MM-DD from various formats
      const match = eventDate.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
      if (match && match[0].replace(/\//g, '-') < today) {
        const id = path.basename(f, '.json');
        fs.renameSync(path.join(DATA_DIR, f), path.join(ARCHIVE_DIR, f));
        archived.push({ id, name: data.event?.name, date: eventDate });
      }
    } catch {}
  }
  res.json({ ok: true, archived });
});

// Delete event (checks both active and archived)
app.delete('/api/events/:id', (req, res) => {
  const activePath = path.join(DATA_DIR, `${req.params.id}.json`);
  const archivedPath = path.join(ARCHIVE_DIR, `${req.params.id}.json`);
  if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
  else if (fs.existsSync(archivedPath)) fs.unlinkSync(archivedPath);
  res.json({ ok: true });
});

// Duplicate event
app.post('/api/events/:id/duplicate', (req, res) => {
  const srcPath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(srcPath)) return res.status(404).json({ error: 'not found' });
  const data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  data.event.name = (data.event.name || '未命名') + ' (副本)';
  const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(path.join(DATA_DIR, `${newId}.json`), JSON.stringify(data, null, 2), 'utf8');
  res.json({ id: newId });
});

// View page (serve view.html for /v/:id)
app.get('/v/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'view.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
