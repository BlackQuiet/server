const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// === CORS EN LIGNE UNIQUEMENT ===
const whitelist = [
  'https://quiet-semolina-0bedc6.netlify.app'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || whitelist.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// === CONFIGURATION SMTP ===
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// === ENDPOINT DE VÉRIFICATION DU SERVEUR ===
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'BlackQuiet Sender',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// === ENDPOINT D’ENVOI D’EMAIL ===
app.post('/api/send-email', async (req, res) => {
  const { to, subject, text, html } = req.body;

  if (!to || !subject || (!text && !html)) {
    return res.status(400).json({ error: 'Champs requis manquants' });
  }

  try {
    const info = await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
      html
    });

    console.log(`[EMAIL OK] ➤ ${to} "${subject}"`);
    res.status(200).json({ success: true, messageId: info.messageId });
  } catch (error) {
    console.error(`[EMAIL ERROR]`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// === DÉMARRAGE DU SERVEUR ===
app.listen(PORT, () => {
  console.log(`🚀 Serveur BlackQuiet Sender actif sur le port ${PORT}`);
});
