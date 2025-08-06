import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';
import winston from 'winston';
import { config } from 'dotenv';

config();

const app = express();

// Configuration du port
const PORT = process.env.PORT || 3001;

// ==================== LOGGING AVANCÉ ====================

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'blackquiet-emailsender' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// ==================== SÉCURITÉ AVANCÉE ====================

// Helmet pour la sécurité des headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Compression GZIP
app.use(compression());

// Rate limiting avancé
const createRateLimit = (windowMs, max, message) => rateLimit({
  windowMs,
  max,
  message: { success: false, message },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn(`Rate limit exceeded for IP: ${req.ip}`, {
      ip: req.ip,
      endpoint: req.path,
      userAgent: req.get('User-Agent')
    });
    res.status(429).json({ success: false, message });
  }
});

// Rate limits différenciés
app.use('/api/smtp/test', createRateLimit(15 * 60 * 1000, 10, 'Trop de tests SMTP. Réessayez dans 15 minutes.'));
app.use('/api/campaign/start', createRateLimit(60 * 60 * 1000, 5, 'Trop de campagnes lancées. Réessayez dans 1 heure.'));
app.use('/api/', createRateLimit(15 * 60 * 1000, 100, 'Trop de requêtes API. Réessayez dans 15 minutes.'));

// CORS avancé avec validation d'origine
const allowedOrigins = [
  'https://quiet-semolina-0bedc6.netlify.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'https://blackquiet-sender.onrender.com'
];

app.use(cors({
  origin: (origin, callback) => {
    // Permettre les requêtes sans origine (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked origin: ${origin}`);
      callback(new Error('Non autorisé par CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  maxAge: 86400 // Cache preflight 24h
}));

// Middleware pour parser le JSON avec limite
app.use(express.json({ 
  limit: '10mb',
  verify: (req, res, buf) => {
    try {
      JSON.parse(buf);
    } catch (e) {
      logger.error('Invalid JSON received', { ip: req.ip, error: e.message });
      throw new Error('JSON invalide');
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging middleware avancé
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP Request', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      contentLength: res.get('Content-Length')
    });
  });
  
  next();
});

// ==================== GESTION AVANCÉE DES CAMPAGNES ====================

class CampaignManager {
  constructor() {
    this.campaigns = new Map();
    this.transporterPool = new Map();
    this.maxConcurrentCampaigns = 3;
    this.activeCampaigns = 0;
    this.smtpRotation = new Map(); // Rotation par campagne
    this.emailCounters = new Map(); // Compteurs d'emails par serveur
  }

  async createTransporter(smtpConfig) {
    const key = `${smtpConfig.host}:${smtpConfig.port}:${smtpConfig.username}`;
    
    if (this.transporterPool.has(key)) {
      return this.transporterPool.get(key);
    }

    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: parseInt(smtpConfig.port),
      secure: smtpConfig.port == 465,
      auth: {
        user: smtpConfig.username,
        pass: smtpConfig.password
      },
      pool: false, // Désactiver le pool pour contrôler manuellement
      maxConnections: 1,
      maxMessages: 1,
      connectionTimeout: 30000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      requireTLS: smtpConfig.port == 587,
      tls: {
        rejectUnauthorized: false,
        ciphers: 'SSLv3'
      },
      // Retry automatique
      retryDelay: 5000,
      maxRetries: 3
    });

    // Vérifier la connexion
    await transporter.verify();
    
    this.transporterPool.set(key, transporter);
    logger.info(`Transporter créé et mis en cache: ${key}`);
    
    return transporter;
  }

  async startCampaign(campaignData) {
    if (this.activeCampaigns >= this.maxConcurrentCampaigns) {
      throw new Error(`Limite de campagnes simultanées atteinte (${this.maxConcurrentCampaigns})`);
    }

    const campaignId = `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const campaign = {
      ...campaignData,
      id: campaignId,
      status: 'running',
      sent: 0,
      success: 0,
      failed: 0,
      logs: [],
      errors: [],
      startTime: Date.now(),
      currentEmail: '',
      priority: campaignData.priority || 'normal',
      retryQueue: []
    };

    this.campaigns.set(campaignId, campaign);
    this.activeCampaigns++;

    logger.info(`Campagne créée: ${campaignId}`, {
      recipients: campaign.recipients.length,
      priority: campaign.priority,
      smtp: campaign.smtpServer.name
    });

    // Démarrer le traitement en arrière-plan
    this.processCampaign(campaignId).catch(error => {
      logger.error(`Erreur campagne ${campaignId}:`, error);
      campaign.status = 'error';
      campaign.logs.push(`❌ Erreur fatale: ${error.message}`);
    });

    return campaignId;
  }

  async processCampaign(campaignId) {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;

    // Initialiser la rotation SMTP pour cette campagne avec validation
    let availableServers = [];
    
    if (campaign.useSmtpRotation && campaign.smtpServers && campaign.smtpServers.length > 1) {
      availableServers = campaign.smtpServers;
      console.log(`🔄 Rotation SMTP activée avec ${availableServers.length} serveurs`);
    } else {
      availableServers = [campaign.smtpServer];
      console.log(`📡 Serveur SMTP unique utilisé: ${campaign.smtpServer?.name}`);
    }
    
    const smtpRotation = {
      servers: availableServers.map(server => ({
        ...server,
        isActive: true,
        failureCount: 0,
        sentCount: 0,
        lastUsed: null
      })),
      currentIndex: 0
    };
    this.smtpRotation.set(campaignId, smtpRotation);

    try {
      campaign.logs.push(`🚀 Démarrage - ${campaign.recipients.length} emails à envoyer`);
      campaign.logs.push(`📡 ${availableServers.length} serveur(s) SMTP disponible(s)`);
      
      if (campaign.useCustomSubjects && campaign.customSubjects?.length > 0) {
        campaign.logs.push(`📝 ${campaign.customSubjects.length} sujet(s) personnalisé(s) activé(s)`);
      }
      
      if (campaign.useCustomSenders && campaign.customSenders?.length > 0) {
        campaign.logs.push(`👤 ${campaign.customSenders.length} expéditeur(s) personnalisé(s) activé(s)`);
      }
      
      if (campaign.useSmtpRotation) {
        campaign.logs.push(`🔄 Rotation SMTP activée (fréquence: ${campaign.rotationFrequency || 1})`);
      }

      // Envoi séquentiel UN PAR UN (méthode pro anti-spam)
      for (let i = 0; i < campaign.recipients.length; i++) {
        if (campaign.status !== 'running') break;

        const recipient = campaign.recipients[i];
        campaign.currentEmail = recipient;
        
        // Obtenir le prochain serveur SMTP disponible
        const smtpServer = this.getNextAvailableSMTP(campaignId);
        if (!smtpServer) {
          campaign.logs.push(`❌ Aucun serveur SMTP disponible - Arrêt de la campagne`);
          campaign.status = 'error';
          break;
        }

        campaign.logs.push(`📧 ${i + 1}/${campaign.recipients.length} → ${recipient} via ${smtpServer.name}`);
        
        try {
          // Créer un transporter pour ce serveur spécifique
          const transporter = await this.createTransporter(smtpServer);
          
          // Envoyer l'email
          await this.sendEmail(campaign, transporter, recipient, smtpServer);
          
          campaign.sent++;
          campaign.success++;
          
          // Marquer le serveur comme utilisé avec succès
          this.markSMTPSuccess(campaignId, smtpServer.id);
          
          campaign.logs.push(`✅ ${campaign.sent}/${campaign.recipients.length} → ${recipient} envoyé avec succès`);
          
        } catch (error) {
          campaign.sent++;
          campaign.failed++;
          
          // Marquer le serveur comme ayant échoué
          this.markSMTPFailure(campaignId, smtpServer.id, error.message);
          
          campaign.errors.push({
            email: recipient,
            error: error.message,
            smtp: smtpServer.name,
            timestamp: new Date().toISOString()
          });
          
          campaign.logs.push(`❌ ${campaign.sent}/${campaign.recipients.length} → ${recipient}: ${error.message}`);
        }

        // Calculer les statistiques en temps réel
        const elapsedMinutes = (Date.now() - campaign.startTime) / 60000;
        campaign.speed = elapsedMinutes > 0 ? Math.round(campaign.sent / elapsedMinutes) : 0;
        campaign.remaining = campaign.recipients.length - campaign.sent;
        
        const estimatedMinutes = campaign.speed > 0 ? Math.ceil(campaign.remaining / campaign.speed) : 0;
        campaign.estimatedTime = estimatedMinutes > 0 ? `${estimatedMinutes} min restantes` : 'Calcul...';

        // Délai anti-spam entre chaque email (CRUCIAL)
        if (i < campaign.recipients.length - 1 && campaign.status === 'running') {
          const delay = (campaign.delayBetweenEmails || 5) * 1000;
          campaign.logs.push(`⏳ Délai anti-spam: ${delay/1000}s`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      // Traitement des retry
      if (campaign.retryQueue.length > 0 && campaign.status === 'running') {
        campaign.logs.push(`🔄 Retry de ${campaign.retryQueue.length} emails échoués`);
        await this.processRetryQueue(campaign, transporter);
      }

      if (campaign.status === 'running') {
        campaign.status = 'completed';
      }

      campaign.logs.push(`🎉 Terminé: ${campaign.success} succès, ${campaign.failed} échecs`);
      
      logger.info(`Campagne terminée: ${campaignId}`, {
        total: campaign.recipients.length,
        success: campaign.success,
        failed: campaign.failed,
        duration: Date.now() - campaign.startTime
      });

    } catch (error) {
      campaign.status = 'error';
      campaign.logs.push(`❌ Erreur fatale: ${error.message}`);
      logger.error(`Erreur campagne ${campaignId}:`, error);
    } finally {
      this.activeCampaigns--;
      campaign.currentEmail = 'Campagne terminée';
    }
  }

  async sendEmail(campaign, transporter, recipient) {
    try {
      // Personnalisation avancée
      const personalizedContent = this.personalizeContent(campaign, recipient);
      
      const mailOptions = {
        from: `"${personalizedContent.fromName}" <${campaign.smtpServer.username}>`,
        to: recipient,
        replyTo: campaign.customReplyTo || campaign.smtpServer.replyTo || campaign.smtpServer.username,
        subject: personalizedContent.subject,
        [campaign.isHTML ? 'html' : 'text']: personalizedContent.content,
        headers: {
          'X-Campaign-ID': campaign.id,
          'X-Mailer': 'BlackQuiet EmailSender v2.0',
          'List-Unsubscribe': `<https://example.com/unsubscribe?email=${encodeURIComponent(recipient)}>`
        }
      };

      const info = await transporter.sendMail(mailOptions);
      
      logger.debug(`Email envoyé: ${recipient}`, { messageId: info.messageId });
      return info;

    } catch (error) {
      // Ajouter à la queue de retry pour certaines erreurs
      if (this.isRetryableError(error)) {
        campaign.retryQueue.push(recipient);
      }
      throw error;
    }
  }

  personalizeContent(campaign, recipient) {
    const name = recipient.split('@')[0];
    const domain = recipient.split('@')[1];
    const unsubscribeLink = `https://example.com/unsubscribe?email=${encodeURIComponent(recipient)}`;
    
    let subject = campaign.subject;
    
    // Utiliser un sujet personnalisé si activé
    if (campaign.useCustomSubjects && campaign.customSubjects && campaign.customSubjects.length > 0) {
      const randomSubject = campaign.customSubjects[Math.floor(Math.random() * campaign.customSubjects.length)];
      subject = randomSubject;
      console.log(`📝 Sujet personnalisé utilisé: ${subject}`);
    } else {
      console.log(`📝 Sujet original utilisé: ${subject}`);
    }
    
    let content = campaign.content;
    
    // Variables de base
    const variables = {
      '{{name}}': name,
      '{{email}}': recipient,
      '{{domain}}': domain,
      '{{unsubscribe}}': unsubscribeLink,
      '{{date}}': new Date().toLocaleDateString('fr-FR'),
      '{{time}}': new Date().toLocaleTimeString('fr-FR'),
      '{{campaign_id}}': campaign.id,
      '{{ref}}': 'REF' + Math.floor(Math.random() * 100000)
    };

    // Appliquer les variables
    Object.entries(variables).forEach(([variable, value]) => {
      subject = subject.replace(new RegExp(variable, 'g'), value);
      content = content.replace(new RegExp(variable, 'g'), value);
    });


    let fromName;
    
    // Utiliser un expéditeur personnalisé si activé
    if (campaign.useCustomSenders && campaign.customSenders && campaign.customSenders.length > 0) {
      const randomSender = campaign.customSenders[Math.floor(Math.random() * campaign.customSenders.length)];
      fromName = randomSender;
      console.log(`👤 Expéditeur personnalisé utilisé: ${fromName}`);
    } else {
      fromName = campaign.smtpServer?.username?.split('@')[0] || 'Expéditeur';
      console.log(`👤 Expéditeur par défaut utilisé: ${fromName}`);
    }

    return { subject, content, fromName };
  }


  async processRetryQueue(campaign, transporter) {
    const retryBatch = campaign.retryQueue.splice(0, 5); // Retry par petits batches
    
    for (const recipient of retryBatch) {
      if (campaign.status !== 'running') break;
      
      try {
        await this.sendEmail(campaign, transporter, recipient);
        campaign.success++;
        campaign.logs.push(`🔄✅ Retry réussi → ${recipient}`);
      } catch (error) {
        campaign.failed++;
        campaign.logs.push(`🔄❌ Retry échoué → ${recipient}`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000)); // Délai entre retry
    }
  }

  isRetryableError(error) {
    const retryableCodes = ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'];
    return retryableCodes.includes(error.code) || 
           error.responseCode >= 400 && error.responseCode < 500;
  }

  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  getCampaign(id) {
    return this.campaigns.get(id);
  }

  stopCampaign(id) {
    const campaign = this.campaigns.get(id);
    if (campaign) {
      campaign.status = 'stopped';
      campaign.logs.push('🛑 Campagne arrêtée par l\'utilisateur');
      logger.info(`Campagne arrêtée: ${id}`);
      return true;
    }
    return false;
  }

  // Méthode spécifique pour obtenir le prochain serveur SMTP dans une campagne
  getNextAvailableSMTP(campaignId) {
    const rotation = this.smtpRotation.get(campaignId);
    if (!rotation) return null;

    // Filtrer les serveurs actifs
    const activeServers = rotation.servers.filter(server => {
      // Vérifier si le serveur est actif
      if (!server.isActive) {
        // Vérifier si le cooldown est terminé
        if (server.lastFailure) {
          const cooldownEnd = new Date(server.lastFailure.getTime() + 30 * 60000); // 30 min
          if (new Date() > cooldownEnd) {
            server.isActive = true;
            server.failureCount = 0;
            logger.info(`🔄 Serveur ${server.name} réactivé après cooldown`);
          } else {
            return false;
          }
        }
      }

      // Vérifier la limite quotidienne
      if (server.sentCount >= (server.dailyLimit || 500)) {
        return false;
      }

      return true;
    });

    if (activeServers.length === 0) {
      console.warn(`❌ Aucun serveur SMTP actif disponible pour la campagne ${campaignId}`);
      return null;
    }

    // Rotation intelligente : sélectionner le serveur optimal
    const selectedServer = activeServers.sort((a, b) => {
      // Prioriser par : moins d'échecs, moins d'envois, meilleur temps de réponse
      if (a.failureCount !== b.failureCount) {
        return a.failureCount - b.failureCount;
      }
      if (a.sentCount !== b.sentCount) {
        return a.sentCount - b.sentCount;
      }
      return (a.responseTime || 0) - (b.responseTime || 0);
    })[0];
    
    console.log(`🎯 Serveur SMTP sélectionné: ${selectedServer.name} (échecs: ${selectedServer.failureCount}, envoyés: ${selectedServer.sentCount})`);

    return selectedServer;
  }

  // Marquer un serveur comme ayant échoué dans une campagne
  markSMTPFailure(campaignId, serverId, error, campaign = null) {
    const rotation = this.smtpRotation.get(campaignId);
    if (!rotation) return;

    const server = rotation.servers.find(s => s.id === serverId);
    if (!server) return;

    server.failureCount++;
    server.lastFailure = new Date();
    
    const maxFailures = campaign?.maxFailuresPerServer || 3;

    // Désactiver le serveur si trop d'échecs
    if (server.failureCount >= maxFailures) {
      server.isActive = false;
      logger.warn(`⚠️ Serveur SMTP ${server.name} désactivé après ${server.failureCount} échecs (limite: ${maxFailures})`);
    }

    logger.error(`❌ Échec SMTP ${server.name}: ${error}`);
  }

  // Marquer un envoi réussi dans une campagne
  markSMTPSuccess(campaignId, serverId) {
    const rotation = this.smtpRotation.get(campaignId);
    if (!rotation) return;

    const server = rotation.servers.find(s => s.id === serverId);
    if (!server) return;

    server.sentCount++;
    server.lastUsed = new Date();
    
    // Réduire le compteur d'échecs en cas de succès
    if (server.failureCount > 0) {
      server.failureCount = Math.max(0, server.failureCount - 1);
    }
  }

  // Nettoyage automatique des anciennes campagnes
  cleanup() {
    const now = Date.now();
    const maxAge = 2 * 60 * 60 * 1000; // 2 heures

    for (const [id, campaign] of this.campaigns.entries()) {
      if (now - campaign.startTime > maxAge && 
          ['completed', 'stopped', 'error'].includes(campaign.status)) {
        this.campaigns.delete(id);
        logger.info(`Campagne nettoyée: ${id}`);
      }
    }
  }
}

// Méthode pour obtenir le statut de rotation SMTP
CampaignManager.prototype.getSMTPRotationStatus = function(campaignId) {
  const rotation = this.smtpRotation.get(campaignId);
  if (!rotation) return null;
  
  return {
    totalServers: rotation.servers.length,
    activeServers: rotation.servers.filter(s => s.isActive).length,
    inactiveServers: rotation.servers.filter(s => !s.isActive).length,
    servers: rotation.servers.map(server => ({
      id: server.id,
      name: server.name,
      isActive: server.isActive,
      sentCount: server.sentCount,
      failureCount: server.failureCount,
      lastUsed: server.lastUsed,
      lastFailure: server.lastFailure
    }))
  };
};

// Instance globale du gestionnaire de campagnes
const campaignManager = new CampaignManager();

// ==================== FONCTIONS UTILITAIRES ====================

function generateTestEmailHTML(server, responseTime) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px;">
        <h1 style="margin: 0; font-size: 24px;">✅ Test SMTP Pro Réussi !</h1>
        <p style="margin: 10px 0 0 0;">Configuration validée avec succès</p>
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
            <td style="padding: 10px 0;">${server.port == 465 ? 'SSL/TLS' : 'STARTTLS'}</td>
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
            <strong>🎉 Excellent !</strong> Votre serveur SMTP est parfaitement configuré et optimisé pour l'envoi en masse.
          </p>
        </div>
        
        <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin-top: 20px;">
          <h3 style="margin-top: 0; color: #333;">🚀 Fonctionnalités Pro activées:</h3>
          <ul style="margin: 0; padding-left: 20px; color: #666;">
            <li>Pool de connexions optimisé</li>
            <li>Retry automatique des échecs</li>
            <li>Personnalisation intelligente</li>
            <li>Logging avancé</li>
            <li>Rate limiting de sécurité</li>
          </ul>
        </div>
        
        <p style="color: #666; font-size: 14px; margin-top: 30px; text-align: center;">
          Email généré par <strong>BlackQuiet EmailSender Pro v2.0</strong><br>
          Test effectué le ${new Date().toLocaleString('fr-FR')}
        </p>
      </div>
    </div>
  `;
}

function handleSMTPError(error, server) {
  let errorMessage = error.message;
  let errorCode = 'UNKNOWN_ERROR';
  
  const errorMappings = {
    'ECONNREFUSED': 'Connexion refusée - Vérifiez l\'host et le port',
    'ENOTFOUND': 'Serveur introuvable - Vérifiez l\'adresse du serveur',
    'EAUTH': 'Authentification échouée - Vérifiez vos identifiants',
    'ETIMEDOUT': 'Timeout - Le serveur ne répond pas assez rapidement',
    'ESOCKET': 'Erreur de socket - Problème de connexion réseau',
    'ECONNRESET': 'Connexion réinitialisée - Serveur surchargé ou instable'
  };
  
  if (errorMappings[error.code]) {
    errorMessage = errorMappings[error.code];
    errorCode = error.code;
  } else if (error.responseCode === 535) {
    errorMessage = 'Authentification échouée - Mot de passe incorrect ou 2FA requis';
    errorCode = 'AUTH_FAILED';
  }
  
  logger.warn('Échec test SMTP', { 
    server: server?.name || 'unknown',
    error: errorCode,
    message: errorMessage 
  });
  
  return {
    success: false,
    message: errorMessage,
    responseTime: 0,
    error: errorCode,
    details: {
      host: server?.host || 'unknown',
      port: server?.port || 0,
      secure: server?.port == 465,
      auth: false
    }
  };
}

function validateCampaignData(data) {
  const errors = [];
  
  if (!data.smtpServer) errors.push('Serveur SMTP requis');
  if (!data.recipients || !Array.isArray(data.recipients) || data.recipients.length === 0) {
    errors.push('Liste de destinataires requise');
  }
  if (!data.subject || data.subject.trim().length === 0) errors.push('Sujet requis');
  if (!data.content || data.content.trim().length === 0) errors.push('Contenu requis');
  
  // Validation des emails
  if (data.recipients) {
    const invalidEmails = data.recipients.filter(email => 
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    );
    if (invalidEmails.length > 0) {
      errors.push(`Emails invalides: ${invalidEmails.slice(0, 3).join(', ')}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

function calculateCampaignStats(campaign) {
  const elapsedMinutes = (Date.now() - campaign.startTime) / 60000;
  const speed = elapsedMinutes > 0 ? Math.round(campaign.sent / elapsedMinutes) : 0;
  const remaining = campaign.recipients.length - campaign.sent;
  const estimatedMinutes = speed > 0 ? Math.ceil(remaining / speed) : 0;
  const successRate = campaign.sent > 0 ? (campaign.success / campaign.sent * 100) : 0;
  
  return {
    sent: campaign.sent,
    total: campaign.recipients.length,
    success: campaign.success,
    failed: campaign.failed,
    remaining,
    speed,
    estimatedTime: estimatedMinutes > 0 ? `${estimatedMinutes} min restantes` : 'Calcul...',
    successRate: Math.round(successRate * 100) / 100,
    retryQueueSize: campaign.retryQueue?.length || 0
  };
}

function estimateCampaignDuration(campaignData) {
  const emailCount = campaignData.recipients.length;
  const delaySeconds = campaignData.delayBetweenEmails || 5;
  const totalSeconds = emailCount * delaySeconds;
  const minutes = Math.ceil(totalSeconds / 60);
  
  return `~${minutes} minutes`;
}

// ==================== ROUTES AMÉLIORÉES ====================

// Health check avancé
app.get('/api/health', (req, res) => {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();
  
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    service: 'BlackQuiet EmailSender Pro',
    version: '2.0.0',
    uptime: {
      seconds: Math.floor(uptime),
      human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    },
    memory: {
      used: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      total: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)} MB`
    },
    campaigns: {
      active: campaignManager.activeCampaigns,
      total: campaignManager.campaigns.size
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Route racine améliorée
app.get('/', (req, res) => {
  res.json({
    message: 'BlackQuiet EmailSender Pro API v2.0',
    status: 'Running',
    documentation: 'https://github.com/blackquiet/emailsender',
    endpoints: {
      health: '/api/health',
      smtpTest: '/api/smtp/test',
      campaignStart: '/api/campaign/start',
      campaignStatus: '/api/campaign/:id/status',
      campaignStop: '/api/campaign/:id/stop',
      stats: '/api/stats'
    },
    features: [
      'SMTP Testing with real email sending',
      'Advanced campaign management',
      'Intelligent content personalization',
      'Rate limiting and security',
      'Comprehensive logging',
      'Automatic retry mechanism'
    ]
  });
});

// Test SMTP amélioré
app.post('/api/smtp/test', async (req, res) => {
  try {
    const { server, testEmail } = req.body;
    
    logger.info(`Test SMTP demandé: ${server.name}`, { 
      host: server.host, 
      port: server.port,
      testEmail: testEmail || 'connection-only'
    });
    
    // Validation renforcée
    if (!server || !server.host || !server.port || !server.username || !server.password) {
      return res.status(400).json({
        success: false,
        message: 'Configuration SMTP incomplète',
        responseTime: 0,
        error: 'INVALID_CONFIG'
      });
    }

    const transporter = nodemailer.createTransport({
      host: server.host,
      port: parseInt(server.port),
      secure: server.port == 465,
      auth: {
        user: server.username,
        pass: server.password
      },
      connectionTimeout: 30000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      requireTLS: server.port == 587,
      tls: {
        rejectUnauthorized: false
      },
      debug: true
    });
    
    const startTime = Date.now();
    
    // Test de connexion
    await transporter.verify();
    const responseTime = Date.now() - startTime;
    
    let result = {
      success: true,
      message: `Connexion SMTP réussie en ${responseTime}ms`,
      responseTime,
      details: {
        host: server.host,
        port: server.port,
        secure: server.port == 465,
        auth: true,
        pooled: true
      }
    };

    // Test d'envoi si email fourni
    if (testEmail && testEmail.trim()) {
      logger.info(`Envoi email de test vers: ${testEmail}`);
      
      const mailOptions = {
        from: `"Test EmailSender Pro" <${server.username}>`,
        to: testEmail.trim(),
        replyTo: server.replyTo || server.username,
        subject: `✅ Test SMTP Pro - ${server.name} - ${new Date().toLocaleString('fr-FR')}`,
        html: generateTestEmailHTML(server, responseTime),
        headers: {
          'X-Mailer': 'BlackQuiet EmailSender Pro v2.0',
          'X-Test-Type': 'SMTP-Configuration-Test'
        }
      };

      const info = await transporter.sendMail(mailOptions);
      result.message += ` - Email de test envoyé (ID: ${info.messageId})`;
      result.messageId = info.messageId;
    }

    logger.info(`Test SMTP réussi: ${server.name}`, { responseTime, testEmail });
    res.json(result);
    
  } catch (error) {
    logger.error('Erreur test SMTP:', error);
    
    const errorResponse = handleSMTPError(error, req.body.server);
    res.json(errorResponse);
  }
});

// Démarrage de campagne amélioré
app.post('/api/campaign/start', async (req, res) => {
  try {
    const campaignData = req.body;
    
    logger.info('Demande de création de campagne', {
      recipients: campaignData.recipients?.length || 0,
      smtp: campaignData.smtpServer?.name,
      ip: req.ip
    });
    
    // Validation renforcée
    const validation = validateCampaignData(campaignData);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: `Données invalides: ${validation.errors.join(', ')}`
      });
    }
    
    const campaignId = await campaignManager.startCampaign(campaignData);
    
    res.json({
      success: true,
      campaignId,
      message: 'Campagne démarrée avec succès',
      estimatedDuration: estimateCampaignDuration(campaignData)
    });
    
  } catch (error) {
    logger.error('Erreur création campagne:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

// Statut de campagne amélioré
app.get('/api/campaign/:id/status', (req, res) => {
  try {
    const campaign = campaignManager.getCampaign(req.params.id);
    
    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }
    
    const stats = calculateCampaignStats(campaign);
    
    res.json({
      success: true,
      campaign: {
        id: campaign.id,
        status: campaign.status,
        ...stats,
        currentSmtp: campaign.smtpServer.name,
        currentEmail: campaign.currentEmail || '',
        logs: campaign.logs.slice(-50),
        errors: campaign.errors.slice(-10)
      }
    });
  } catch (error) {
    logger.error('Erreur statut campagne:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

// Nouvelle route: Statut de la rotation SMTP
app.get('/api/campaign/:id/smtp-rotation', (req, res) => {
  try {
    const rotationStatus = campaignManager.getSMTPRotationStatus(req.params.id);
    
    if (!rotationStatus) {
      return res.status(404).json({
        success: false,
        message: 'Rotation SMTP non trouvée'
      });
    }
    
    res.json({
      success: true,
      rotation: rotationStatus
    });
  } catch (error) {
    logger.error('Erreur statut rotation SMTP:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

// Arrêt de campagne
app.post('/api/campaign/:id/stop', (req, res) => {
  try {
    const stopped = campaignManager.stopCampaign(req.params.id);
    
    if (!stopped) {
      return res.status(404).json({
        success: false,
        message: 'Campagne non trouvée'
      });
    }
    
    res.json({
      success: true,
      message: 'Campagne arrêtée avec succès'
    });
  } catch (error) {
    logger.error('Erreur arrêt campagne:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

// Nouvelle route: Statistiques globales
app.get('/api/stats', (req, res) => {
  try {
    const campaigns = Array.from(campaignManager.campaigns.values());
    
    const stats = {
      totalCampaigns: campaigns.length,
      activeCampaigns: campaigns.filter(c => c.status === 'running').length,
      completedCampaigns: campaigns.filter(c => c.status === 'completed').length,
      totalEmailsSent: campaigns.reduce((sum, c) => sum + c.sent, 0),
      totalEmailsSuccess: campaigns.reduce((sum, c) => sum + c.success, 0),
      totalEmailsFailed: campaigns.reduce((sum, c) => sum + c.failed, 0),
      averageSuccessRate: campaigns.length > 0 ? 
        campaigns.reduce((sum, c) => sum + (c.sent > 0 ? c.success / c.sent : 0), 0) / campaigns.length * 100 : 0,
      transporterPoolSize: campaignManager.transporterPool.size
    };
    
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Erreur statistiques:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Erreur interne du serveur'
    });
  }
});

// ==================== GESTION DES ERREURS ====================

// 404 Handler
app.use('*', (req, res) => {
  logger.warn(`404 - Route non trouvée: ${req.method} ${req.originalUrl}`, { ip: req.ip });
  res.status(404).json({
    success: false,
    message: 'Endpoint non trouvé',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: ['/api/health', '/api/smtp/test', '/api/campaign/start', '/api/stats']
  });
});

// Global Error Handler
app.use((error, req, res, next) => {
  logger.error('Erreur serveur non gérée:', {
    error: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    success: false,
    message: 'Erreur interne du serveur',
    error: process.env.NODE_ENV === 'development' ? error.message : 'Internal Server Error',
    timestamp: new Date().toISOString()
  });
});

// ==================== TÂCHES DE MAINTENANCE ====================

// Nettoyage automatique toutes les heures
setInterval(() => {
  campaignManager.cleanup();
  
  // Nettoyage du pool de transporteurs inactifs
  if (campaignManager.transporterPool.size > 10) {
    logger.info('Nettoyage du pool de transporteurs');
    // Logique de nettoyage des transporteurs non utilisés
  }
}, 60 * 60 * 1000);

// Statistiques périodiques (toutes les 15 minutes)
setInterval(() => {
  const memUsage = process.memoryUsage();
  logger.info('Statistiques serveur', {
    uptime: Math.floor(process.uptime()),
    memory: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
    activeCampaigns: campaignManager.activeCampaigns,
    totalCampaigns: campaignManager.campaigns.size,
    transporterPool: campaignManager.transporterPool.size
  });
}, 15 * 60 * 1000);

// ==================== DÉMARRAGE DU SERVEUR ====================

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 BlackQuiet EmailSender Pro v2.0 démarré`, {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
    nodeVersion: process.version
  });
  
  console.log(`📧 API Health: http://localhost:${PORT}/api/health`);
  console.log(`📊 API Stats: http://localhost:${PORT}/api/stats`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Gestion propre de l'arrêt
const gracefulShutdown = (signal) => {
  logger.info(`${signal} reçu, arrêt gracieux du serveur...`);
  
  server.close(() => {
    logger.info('Serveur HTTP fermé');
    
    // Fermer toutes les connexions SMTP
    for (const transporter of campaignManager.transporterPool.values()) {
      transporter.close();
    }
    
    logger.info('Toutes les connexions fermées, arrêt du processus');
    process.exit(0);
  });
  
  // Force l'arrêt après 30 secondes
  setTimeout(() => {
    logger.error('Arrêt forcé après timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  logger.error('Exception non capturée:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Promise rejetée non gérée:', { reason, promise });
});

export default app;
