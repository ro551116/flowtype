const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// List all events
app.get('/api/events', (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  const events = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return {
        id: path.basename(f, '.json'),
        name: data.event?.name || '未命名活動',
        date: data.event?.date || '',
        venue: data.event?.venue || '',
        updatedAt: fs.statSync(path.join(DATA_DIR, f)).mtime.toISOString()
      };
    } catch { return null; }
  }).filter(Boolean);
  events.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(events);
});

// Get single event
app.get('/api/events/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

// Update event
app.put('/api/events/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2), 'utf8');
  res.json({ ok: true });
});

// Delete event
app.delete('/api/events/:id', (req, res) => {
  const filePath = path.join(DATA_DIR, `${req.params.id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
