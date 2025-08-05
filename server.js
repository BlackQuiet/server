const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();

// Configuration du port
const PORT = process.env.PORT || 3001;

// Middleware CORS - Autorise les requêtes depuis le frontend
app.use(cors({
  origin: [
    'https://quiet-semolina-0bedc6.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'https://blackquiet-sender.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Middleware pour parser le JSON
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Store pour les campagnes en cours
const activeCampaigns = new Map();

// ==================== ROUTES ====================

// Health check endpoint - OBLIGATOIRE pour Render
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'BlackQuiet EmailSender',
    version: '1.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeCampaigns: activeCampaigns.size
  });
});

// Route racine pour vérification
app.get('/', (req, res) => {
  res.json({
    message: 'BlackQuiet EmailSender API',
    status: 'Running',
    endpoints: {
      health: '/api/health',
      smtpTest: '/api/smtp/test',
      campaignStart: '/api/campaign/start',
      campaignStatus: '/api/campaign/:id/status',
      campaignStop: '/api/campaign/:id/stop'
    }
  });
});

// ==================== SMTP TEST ====================

app.post('/api/smtp/test', async (req, res) => {
  try {
    const { server, testEmail } = req.body;
    
    console.log(`🧪 Test SMTP: ${server.name} (${server.host}:${server.port})`);
    
    // Validation des données
    if (!server || !server.host || !server.port || !server.username || !server.password) {
      return res.status(400).json({
        success: false,
        message: 'Configuration SMTP incomplète',
        responseTime: 0,
        error: 'INVALID_CONFIG'
      });
    }
    
    // Configuration améliorée pour éviter les erreurs SOCKET
    const transporter = nodemailer.createTransporter({
      host: server.host,
      port: parseInt(server.port),
      secure: server.port == 465, // true pour 465, false pour autres ports
      auth: {
        user: server.username,
        pass: server.password
      },
      // Timeouts plus longs pour éviter les erreurs SOCKET
      connectionTimeout: 30000, // 30 secondes
      greetingTimeout: 15000,   // 15 secondes
      socketTimeout: 30000,     // 30 secondes
      // Options de sécurité
      requireTLS: server.port == 587, // Force STARTTLS pour port 587
      tls: {
        rejectUnauthorized: false, // Accepter les certificats auto-signés
        ciphers: 'SSLv3'
      },
      // Pool de connexions désactivé pour les tests
      pool: false,
      // Debug pour diagnostiquer
      debug: true,
      logger: console
    });

    const startTime = Date.now();
    
    // Vérifier la connexion
    await transporter.verify();
    
    const responseTime = Date.now() - startTime;
    
    let result = {
      success: true,
      message: `Connexion SMTP réussie en ${responseTime}ms`,
      responseTime,
      details: {
        host: server.host,
        port: server.port,
        secure: server.secure,
        auth: true
      }
    };

    // Si un email de test est fourni, l'envoyer
    if (testEmail && testEmail.trim()) {
      console.log(`📧 Envoi d'email de test vers: ${testEmail}`);
      
      const mailOptions = {
        from: `"Test EmailSender" <${server.username}>`,
        to: testEmail.trim(),
        replyTo: server.replyTo || server.username,
        subject: `✅ Test SMTP - ${server.name} - ${new Date().toLocaleString('fr-FR')}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px;">
              <h1 style="margin: 0; font-size: 24px;">✅ Test SMTP Réussi !</h1>
              <p style="margin: 10px 0 0 0;">Votre serveur SMTP fonctionne parfaitement</p>
            </div>
            
            <div style="background: white; padding: 30px; border: 1px solid #e0e0e0; border-radius: 10px; margin-top: 20px;">
              <h2 style="color: #333; margin-top: 0;">📊 Détails de la configuration</h2>
              
              <table style="width: 100%; border-collapse: collapse;">
                <tr style="border-bottom: 1px solid #eee;">
                  <td style="padding: 10px 0; font-weight: bold; color: #666;">Serveur:</td>
                  <td style="padding: 10px 0;">${server.name}</td>
                </tr>
                <tr style="border-bottom: 1px solid #eee;">
                  <td style="padding: 10px 0; font-weight: bold; color: #666;">Host:</td>
                  <td style="padding: 10px 0;">${server.host}:${server.port}</td>
                </tr>
                <tr style="border-bottom: 1px solid #eee;">
                  <td style="padding: 10px 0; font-weight: bold; color: #666;">Sécurité:</td>
                  <td style="padding: 10px 0;">${server.secure ? 'SSL/TLS' : 'STARTTLS'}</td>
                </tr>
                <tr style="border-bottom: 1px solid #eee;">
                  <td style="padding: 10px 0; font-weight: bold; color: #666;">Utilisateur:</td>
                  <td style="padding: 10px 0;">${server.username}</td>
                </tr>
                <tr style="border-bottom: 1px solid #eee;">
                  <td style="padding: 10px 0; font-weight: bold; color: #666;">Reply-To:</td>
                  <td style="padding: 10px 0;">${server.replyTo || server.username}</td>
                </tr>
                <tr>
                  <td style="padding: 10px 0; font-weight: bold; color: #666;">Temps de réponse:</td>
                  <td style="padding: 10px 0;">${responseTime}ms</td>
                </tr>
              </table>
              
              <div style="background: #f0f8ff; border-left: 4px solid #007cba; padding: 15px; margin: 20px 0; border-radius: 5px;">
                <p style="margin: 0; color: #007cba;">
                  <strong>🎉 Félicitations !</strong> Votre serveur SMTP est correctement configuré et prêt à envoyer des emails.
                </p>
              </div>
              
              <p style="color: #666; font-size: 14px; margin-top: 30px;">
                Cet email a été envoyé automatiquement par BlackQuiet EmailSender pour tester votre configuration SMTP.
              </p>
            </div>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      result.message += ` - Email de test envoyé à ${testEmail}`;
    }

    // Fermer la connexion
    transporter.close();
    
    res.json(result);
    
  } catch (error) {
    console.error('❌ Erreur SMTP:', error);
    
    let errorMessage = error.message;
    let errorCode = 'UNKNOWN_ERROR';
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'Connexion refusée - Vérifiez l\'host et le port';
      errorCode = 'ECONNREFUSED';
    } else if (error.code === 'ENOTFOUND') {
      errorMessage = 'Serveur introuvable - Vérifiez l\'adresse du serveur';
      errorCode = 'ENOTFOUND';
    } else if (error.responseCode === 535 || error.code === 'EAUTH') {
      errorMessage = 'Authentification échouée - Vérifiez vos identifiants';
      errorCode = 'EAUTH';
    } else if (error.code === 'ETIMEDOUT') {
      errorMessage = 'Timeout - Le serveur ne répond pas';
      errorCode = 'ETIMEDOUT';
    } else if (error.code === 'ESOCKET') {
      errorMessage = 'Erreur de socket - Problème de connexion réseau';
      errorCode = 'ESOCKET';
    } else if (error.code === 'ESOCKET' || error.message.includes('socket')) {
      errorMessage = 'Erreur de socket - Vérifiez votre connexion internet et les paramètres du serveur SMTP';
      errorCode = 'ESOCKET';
    } else if (error.code === 'ECONNRESET') {
      errorMessage = 'Connexion réinitialisée par le serveur - Essayez avec des timeouts plus longs';
      errorCode = 'ECONNRESET';
    } else if (error.message.includes('self signed certificate')) {
      errorMessage = 'Certificat SSL auto-signé - Configuration TLS ajustée automatiquement';
      errorCode = 'CERT_ERROR';
    }
    
    res.json({
      success: false,
      message: errorMessage,
      responseTime: 0,
      error: errorCode,
      details: {
        host: req.body.server?.host || 'unknown',
        port: req.body.server?.port || 0,
        secure: req.body.server?.secure || false,
        auth: false
      }
    });
  }
});

// ==================== CAMPAIGN MANAGEMENT ====================

app.post('/api/campaign/start', async (req, res) => {
  try {
    const campaignData = req.body;
    const campaignId = Date.now().toString();
    
    console.log(`🚀 Démarrage campagne ${campaignId}:`, {
      recipients: campaignData.recipients?.length || 0,
      subject: campaignData.subject,
      smtp: campaignData.smtpServer?.name
    });
    
    // Validation des données
    if (!campaignData.smtpServer || !campaignData.recipients || !campaignData.subject || !campaignData.content) {
      return res.status(400).json({
        success: false,
        message: 'Données de campagne incomplètes'
      });
    }
    
    // Stocker la campagne
    activeCampaigns.set(campaignId, {
      ...campaignData,
      id: campaignId,
      status: 'running',
      sent: 0,
      success: 0,
      failed: 0,
      logs: [],
      errors: [],
      startTime: Date.now(),
      currentEmail: ''
    });
    
    // Démarrer l'envoi en arrière-plan
    processCampaign(campaignId);
    
    res.json({
      success: true,
      campaignId,
      message: 'Campagne démarrée avec succès'
    });
    
  } catch (error) {
    console.error('❌ Erreur démarrage campagne:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

app.get('/api/campaign/:id/status', (req, res) => {
  try {
    const campaign = activeCampaigns.get(req.params.id);
    
    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }
    
    const elapsedMinutes = (Date.now() - campaign.startTime) / 60000;
    const speed = elapsedMinutes > 0 ? Math.round(campaign.sent / elapsedMinutes) : 0;
    const remaining = campaign.recipients.length - campaign.sent;
    const estimatedMinutes = speed > 0 ? Math.ceil(remaining / speed) : 0;
    
    res.json({
      success: true,
      campaign: {
        id: campaign.id,
        status: campaign.status,
        sent: campaign.sent,
        total: campaign.recipients.length,
        success: campaign.success,
        failed: campaign.failed,
        remaining,
        currentSmtp: campaign.smtpServer.name,
        currentEmail: campaign.currentEmail || '',
        speed,
        estimatedTime: estimatedMinutes > 0 ? `${estimatedMinutes} min restantes` : 'Calcul...',
        logs: campaign.logs.slice(-50), // Derniers 50 logs
        errors: campaign.errors.slice(-10) // Dernières 10 erreurs
      }
    });
  } catch (error) {
    console.error('❌ Erreur statut campagne:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

app.post('/api/campaign/:id/stop', (req, res) => {
  try {
    const campaign = activeCampaigns.get(req.params.id);
    
    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }
    
    campaign.status = 'stopped';
    campaign.logs.push('🛑 Campagne arrêtée par l\'utilisateur');
    
    console.log(`🛑 Campagne ${req.params.id} arrêtée`);
    
    res.json({
      success: true,
      message: 'Campagne arrêtée avec succès'
    });
  } catch (error) {
    console.error('❌ Erreur arrêt campagne:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

// ==================== CAMPAIGN PROCESSING ====================

async function processCampaign(campaignId) {
  const campaign = activeCampaigns.get(campaignId);
  if (!campaign) return;
  
  let transporter = null;
  
  try {
    // Créer le transporteur SMTP
    transporter = nodemailer.createTransport({
      host: campaign.smtpServer.host,
      port: parseInt(campaign.smtpServer.port),
      secure: campaign.smtpServer.secure || false,
      auth: {
        user: campaign.smtpServer.username,
        pass: campaign.smtpServer.password
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    });
    
    campaign.logs.push(`🚀 Démarrage de la campagne - ${campaign.recipients.length} emails à envoyer`);
    campaign.logs.push(`📡 Serveur SMTP: ${campaign.smtpServer.name} (${campaign.smtpServer.host}:${campaign.smtpServer.port})`);
    
    // Vérifier la connexion SMTP
    await transporter.verify();
    campaign.logs.push(`✅ Connexion SMTP vérifiée`);
    
    // Traiter chaque destinataire
    for (let i = 0; i < campaign.recipients.length; i++) {
      if (campaign.status !== 'running') {
        campaign.logs.push(`⏸️ Campagne interrompue (statut: ${campaign.status})`);
        break;
      }
      
      const recipient = campaign.recipients[i];
      campaign.currentEmail = recipient;
      
      try {
        // Personnaliser le contenu
        let personalizedSubject = campaign.subject;
        let personalizedContent = campaign.content;
        
        // Variables de base
        const name = recipient.split('@')[0];
        const unsubscribeLink = `https://example.com/unsubscribe?email=${encodeURIComponent(recipient)}`;
        
        personalizedSubject = personalizedSubject.replace(/\{\{name\}\}/g, name);
        personalizedSubject = personalizedSubject.replace(/\{\{email\}\}/g, recipient);
        
        personalizedContent = personalizedContent.replace(/\{\{name\}\}/g, name);
        personalizedContent = personalizedContent.replace(/\{\{email\}\}/g, recipient);
        personalizedContent = personalizedContent.replace(/\{\{unsubscribe\}\}/g, unsubscribeLink);
        personalizedContent = personalizedContent.replace(/\{\{date\}\}/g, new Date().toLocaleDateString('fr-FR'));
        
        // Générer des variations si demandé
        if (campaign.useRandomSubject) {
          personalizedSubject = generateSubjectVariation(personalizedSubject);
        }
        
        const fromName = campaign.useRandomFromName ? generateRandomFromName() : campaign.smtpServer.username.split('@')[0];
        
        // Options de l'email
        const mailOptions = {
          from: `"${fromName}" <${campaign.smtpServer.username}>`,
          to: recipient,
          replyTo: campaign.customReplyTo || campaign.smtpServer.replyTo || campaign.smtpServer.username,
          subject: personalizedSubject,
          [campaign.isHTML ? 'html' : 'text']: personalizedContent
        };
        
        // Envoyer l'email
        const info = await transporter.sendMail(mailOptions);
        
        campaign.sent++;
        campaign.success++;
        campaign.logs.push(`✅ Email ${campaign.sent}/${campaign.recipients.length} envoyé → ${recipient}`);
        
        console.log(`✅ Email envoyé à ${recipient}:`, info.messageId);
        
      } catch (error) {
        campaign.sent++;
        campaign.failed++;
        campaign.errors.push({
          email: recipient,
          error: error.message,
          timestamp: new Date().toLocaleTimeString('fr-FR'),
          smtp: campaign.smtpServer.name
        });
        campaign.logs.push(`❌ Email ${campaign.sent}/${campaign.recipients.length} échoué → ${recipient}: ${error.message}`);
        
        console.error(`❌ Erreur envoi à ${recipient}:`, error.message);
      }
      
      // Délai entre les emails
      if (i < campaign.recipients.length - 1 && campaign.status === 'running') {
        const delay = (campaign.delayBetweenEmails || 5) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // Campagne terminée
    if (campaign.status === 'running') {
      campaign.status = 'completed';
    }
    campaign.currentEmail = 'Campagne terminée';
    campaign.logs.push(`🎉 Campagne terminée : ${campaign.recipients.length} emails traités`);
    campaign.logs.push(`📊 Résultats : ${campaign.success} succès, ${campaign.failed} échecs`);
    
    console.log(`🎉 Campagne ${campaignId} terminée:`, {
      total: campaign.recipients.length,
      success: campaign.success,
      failed: campaign.failed
    });
    
  } catch (error) {
    campaign.status = 'error';
    campaign.logs.push(`❌ Erreur fatale: ${error.message}`);
    console.error(`❌ Erreur campagne ${campaignId}:`, error);
  } finally {
    // Fermer le transporteur
    if (transporter) {
      transporter.close();
    }
  }
}

// ==================== UTILITY FUNCTIONS ====================

function generateSubjectVariation(baseSubject) {
  const variations = [
    `Re: ${baseSubject}`,
    `${baseSubject} - Suivi`,
    `Concernant: ${baseSubject}`,
    `${baseSubject} - Détails`,
    `À propos de: ${baseSubject}`,
    `${baseSubject} - Information complémentaire`
  ];
  return variations[Math.floor(Math.random() * variations.length)];
}

function generateRandomFromName() {
  const names = [
    "Marc Dubois", "Sophie Laurent", "Pierre Martin", "Claire Durand",
    "Antoine Moreau", "Camille Bernard", "Julien Leroy", "Émilie Petit",
    "Thomas Rousseau", "Marine Girard", "Nicolas Fournier", "Aurélie Michel",
    "Maxime Bonnet", "Léa Dupuis", "Romain Garcia", "Manon Roux"
  ];
  return names[Math.floor(Math.random() * names.length)];
}

// ==================== ERROR HANDLING ====================

// Gestion des erreurs 404
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint non trouvé',
    path: req.originalUrl,
    method: req.method
  });
});

// Gestion des erreurs globales
app.use((error, req, res, next) => {
  console.error('❌ Erreur serveur:', error);
  res.status(500).json({
    success: false,
    message: 'Erreur interne du serveur',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Internal Server Error'
  });
});

// ==================== SERVER START ====================

// Nettoyage des campagnes anciennes (toutes les heures)
setInterval(() => {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  
  for (const [id, campaign] of activeCampaigns.entries()) {
    if (now - campaign.startTime > oneHour && ['completed', 'stopped', 'error'].includes(campaign.status)) {
      activeCampaigns.delete(id);
      console.log(`🧹 Campagne ${id} nettoyée (ancienne)`);
    }
  }
}, 60 * 60 * 1000);

// Démarrer le serveur
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 BlackQuiet EmailSender démarré sur le port ${PORT}`);
  console.log(`📧 API Health: http://localhost:${PORT}/api/health`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
});

// Gestion propre de l'arrêt du serveur
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM reçu, arrêt du serveur...');
  server.close(() => {
    console.log('✅ Serveur arrêté proprement');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT reçu, arrêt du serveur...');
  server.close(() => {
    console.log('✅ Serveur arrêté proprement');
    process.exit(0);
  });
});

module.exports = app;
