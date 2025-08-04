const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const app = express();
const PORT = process.env.PORT || 10000;

// CORS pour Netlify
app.use(cors({
  origin: [
    'https://quiet-semolina-0bedc6.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000'
  ],
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'BlackQuiet Sender',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Vos autres endpoints ici...

app.listen(PORT, () => {
  console.log(`🚀 BlackQuiet Sender démarré sur le port ${PORT}`);
});
