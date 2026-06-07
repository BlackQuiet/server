// server.js - BACKEND NODE.JS POUR RENDER
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { SocksClient } = require('socks');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const Queue = require('bull');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Pour servir le frontend si inclus

// ============ CONFIGURATION ============
const PORT = process.env.PORT || 3000;

// Configuration 9Proxy (depuis les variables d'environnement Render)
const PROXY_CONFIG = {
    proxy_host: process.env.PROXY_HOST || 'niceproxy.io',
    proxy_port: process.env.PROXY_PORT || 17521,
    proxy_user_template: process.env.PROXY_USER || 'black_rIxx-country-CA-isp-as11260_eastlink',
    proxy_pass: process.env.PROXY_PASS || 'Kouame07',
    smtp_host: process.env.SMTP_HOST || 'smtp.eastlink.ca',
    smtp_port: process.env.SMTP_PORT || 25
};

// Compteur d'endpoints (statistiques)
let endpointCount = parseInt(process.env.ENDPOINT_COUNT) || 0;

// ============ FONCTION DE ROTATION SSID ============
function rotateProxySSID(username) {
    if (!username) return username;
    const newSsid = crypto.randomBytes(5).toString('hex').toUpperCase();
    endpointCount++;
    let result;
    if (username.includes('-ssid-')) {
        result = username.replace(/-ssid-[a-zA-Z0-9]+/, `-ssid-${newSsid}`);
    } else {
        result = `${username}-ssid-${newSsid}`;
    }
    return result;
}

// ============ FONCTION DE REMPLACEMENT DES PLACEHOLDERS ============
function replacePlaceholders(text, recipientEmail, link = null) {
    let result = text;
    const domain = recipientEmail.split('@')[1] || 'example.ca';
    const username = recipientEmail.split('@')[0] || 'client';
    const firstName = username.charAt(0).toUpperCase() + username.slice(1);
    const invoiceNum = 'INV-' + Math.floor(100000 + Math.random() * 900000);
    const amount = '$' + (Math.random() * 5000).toFixed(2);
    
    const replacements = {
        '[EMAIL]': recipientEmail,
        '[DOMAIN]': domain,
        '[UNAME]': username,
        '[FIRST_NAME]': firstName,
        '[REAL_NAME]': firstName + ' ' + ['Smith', 'Johnson', 'Williams'][Math.floor(Math.random() * 3)],
        '[DATE]': new Date().toLocaleDateString(),
        '[TIME]': new Date().toLocaleTimeString(),
        '[INVOICE_NUM]': invoiceNum,
        '[BALANCE_AMOUNT]': amount,
        '[DEADLINE_DATE]': new Date(Date.now() + 7 * 86400000).toLocaleDateString(),
        '[PATIENT_ID]': 'PT-' + Math.floor(100000 + Math.random() * 900000),
        '[TRACKING_NUM]': '1Z' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        '[VERIFICATION_CODE]': Math.floor(100000 + Math.random() * 900000).toString(),
        '[RAND1]': Math.floor(10000 + Math.random() * 90000).toString(),
        '[RAND2]': Math.floor(10000000 + Math.random() * 90000000).toString(),
        '[IP_ADDRESS]': '192.168.' + Math.floor(1 + Math.random() * 254) + '.' + Math.floor(1 + Math.random() * 254)
    };
    
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replaceAll(key, value);
    }
    
    if (result.includes('[LINK]') && link) {
        result = result.replace('[LINK]', link);
    }
    
    return result;
}

// ============ ENVOI VIA TUNNEL SOCKS5 ============
async function sendWithProxyTunnel(proxyConfig, mailOptions) {
    let socket = null;
    try {
        const rotatedUser = rotateProxySSID(proxyConfig.proxy_user_template);
        
        console.log(`[PROXY] Tunnel SOCKS5 vers ${proxyConfig.proxy_host}:${proxyConfig.proxy_port}`);
        console.log(`[PROXY] Username: ${rotatedUser.substring(0, 50)}...`);
        
        // Création du tunnel SOCKS5
        const tunnel = await SocksClient.createConnection({
            proxy: {
                ipaddress: proxyConfig.proxy_host,
                port: parseInt(proxyConfig.proxy_port),
                type: 5,
                userId: rotatedUser,
                password: proxyConfig.proxy_pass
            },
            destination: {
                host: proxyConfig.smtp_host,
                port: parseInt(proxyConfig.smtp_port)
            },
            command: 'connect'
        });
        
        socket = tunnel.socket;
        
        // Création du transporteur Nodemailer
        const transporter = nodemailer.createTransport({
            host: proxyConfig.smtp_host,
            port: parseInt(proxyConfig.smtp_port),
            secure: proxyConfig.smtp_port === 465,
            ignoreTLS: proxyConfig.smtp_port === 25,
            connection: socket,
            tls: { rejectUnauthorized: false },
            timeout: 30000
        });
        
        // Envoi de l'email
        const result = await transporter.sendMail(mailOptions);
        transporter.close();
        
        console.log(`[SUCCESS] Email envoyé à ${mailOptions.to}`);
        return { success: true, messageId: result.messageId };
        
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        return { success: false, error: error.message };
    } finally {
        if (socket && !socket.destroyed) socket.end();
    }
}

// ============ GÉNÉRATION DE PDF AVEC PUPPETEER ============
async function generatePDFFromHTML(htmlContent) {
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();
    return pdf;
}

// ============ API ENDPOINTS ============

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString(), endpoints: endpointCount });
});

// Envoi d'un seul email
app.post('/api/send', async (req, res) => {
    const { to, subject, html, fromEmail, fromName, link } = req.body;
    
    if (!to || !subject || !html) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }
    
    const processedHtml = replacePlaceholders(html, to, link);
    const processedSubject = replacePlaceholders(subject, to, link);
    
    const mailOptions = {
        from: `"${fromName || 'Service Client'}" <${fromEmail || 'noreply@eastlink.ca'}>`,
        to: to,
        subject: processedSubject,
        html: processedHtml,
        headers: {
            'X-Priority': '3',
            'X-Mailer': 'Microsoft Outlook 16.0',
            'X-MS-Exchange-Organization-AuthAs': 'Internal'
        }
    };
    
    const result = await sendWithProxyTunnel(PROXY_CONFIG, mailOptions);
    res.json(result);
});

// Envoi en masse (avec file d'attente)
const emailQueue = new Queue('email sending', process.env.REDIS_URL || 'redis://localhost:6379');

emailQueue.process(async (job) => {
    const { to, subject, html, fromEmail, fromName, link } = job.data;
    const processedHtml = replacePlaceholders(html, to, link);
    const mailOptions = {
        from: `"${fromName}" <${fromEmail}>`,
        to: to,
        subject: replacePlaceholders(subject, to, link),
        html: processedHtml
    };
    return await sendWithProxyTunnel(PROXY_CONFIG, mailOptions);
});

app.post('/api/bulk-send', async (req, res) => {
    const { recipients, subject, html, fromEmail, fromName, link } = req.body;
    
    if (!recipients || !Array.isArray(recipients)) {
        return res.status(400).json({ success: false, error: 'Invalid recipients array' });
    }
    
    const jobs = recipients.map(recipient => {
        return emailQueue.add({
            to: recipient,
            subject,
            html,
            fromEmail,
            fromName,
            link
        });
    });
    
    res.json({ success: true, queued: jobs.length, message: 'Emails queued for sending' });
});

// Vérification DNS (GhostHackerDNS)
app.post('/api/dns-check', async (req, res) => {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain required' });
    
    const results = [];
    
    // Niveau 1: DNS Direct
    try {
        const response = await axios.get(`https://dns.google/resolve?name=${domain}&type=MX`);
        if (response.data?.Answer?.length) {
            const mx = response.data.Answer.filter(a => a.type === 15).map(a => a.data);
            if (mx.length) {
                results.push({ method: 'Direct', mx: mx[0], success: true });
            }
        }
    } catch (e) {}
    
    // Niveau 2: DoH
    if (results.length === 0) {
        try {
            const response = await axios.get(`https://cloudflare-dns.com/dns-query?name=${domain}&type=MX`, {
                headers: { Accept: 'application/dns-json' }
            });
            if (response.data?.Answer?.length) {
                const mx = response.data.Answer.filter(a => a.type === 15).map(a => a.data);
                if (mx.length) {
                    results.push({ method: 'DoH', mx: mx[0], success: true });
                }
            }
        } catch (e) {}
    }
    
    // Niveau 3: Proxy (simulé si les deux précédents échouent)
    if (results.length === 0) {
        results.push({ method: 'Proxy', success: false, error: 'No MX records found' });
    }
    
    res.json({ domain, results, valid: results.some(r => r.success) });
});

// Statistiques
app.get('/api/stats', (req, res) => {
    res.json({
        endpoints_generated: endpointCount,
        proxy_config: {
            host: PROXY_CONFIG.proxy_host,
            port: PROXY_CONFIG.proxy_port,
            smtp: `${PROXY_CONFIG.smtp_host}:${PROXY_CONFIG.smtp_port}`
        },
        uptime: process.uptime()
    });
});

// ============ DÉMARRAGE ============
app.listen(PORT, () => {
    console.log(`[SERVER] BLACKQUIET BACKEND running on port ${PORT}`);
    console.log(`[PROXY] Config: ${PROXY_CONFIG.proxy_host}:${PROXY_CONFIG.proxy_port}`);
    console.log(`[SMTP] Target: ${PROXY_CONFIG.smtp_host}:${PROXY_CONFIG.smtp_port}`);
});
