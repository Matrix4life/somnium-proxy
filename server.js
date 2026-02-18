const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Your OpenAI key lives here on the server, never exposed to users
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL          = process.env.MODEL || 'gpt-4.1-mini';

// ── Rate limiting: max requests per IP per window
const WINDOW_MS    = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = 20;              // readings per user per hour
const ipMap        = new Map();

function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const now = Date.now();
  const rec = ipMap.get(ip) || { count: 0, reset: now + WINDOW_MS };

  if (now > rec.reset) {
    rec.count = 0;
    rec.reset = now + WINDOW_MS;
  }

  rec.count++;
  ipMap.set(ip, rec);

  if (rec.count > MAX_REQUESTS) {
    const mins = Math.ceil((rec.reset - now) / 60000);
    return res.status(429).json({
      error: { message: `Too many requests. Try again in ${mins} minute${mins > 1 ? 's' : ''}.` }
    });
  }
  next();
}

// ── Middleware
app.use(cors());
app.use(express.json({ limit: '50kb' }));

// ── Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Somnium proxy' });
});

// ── Proxy endpoint — app posts here instead of directly to OpenAI
app.post('/api/dream', rateLimit, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: { message: 'Server not configured. Set OPENAI_API_KEY in Render environment variables.' } });
  }

  const { input } = req.body;

  if (!input || !Array.isArray(input)) {
    return res.status(400).json({ error: { message: 'Invalid request body. Expected { input: [...] }' } });
  }

  // Basic content length guard
  const totalChars = input.map(m => String(m.content || '')).join('').length;
  if (totalChars > 12000) {
    return res.status(400).json({ error: { message: 'Request too large.' } });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: MODEL,
        input,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: { message: 'Failed to reach OpenAI. Try again.' } });
  }
});

app.listen(PORT, () => {
  console.log(`Somnium proxy running on port ${PORT}`);
});
