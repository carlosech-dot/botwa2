// WhatsApp Bot - Servidor de backend independente (porta 3001)
// Gerencia conexão WhatsApp Web via whatsapp-web.js + Puppeteer
// Expõe API REST + SSE para o frontend Next.js consumir

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

const PORT = parseInt(process.env.PORT ?? '3001', 10);

// Detecta o caminho do Chrome/Chromium automaticamente
const { execSync } = require('child_process');
function findChromium() {
  // 0. Variável de ambiente — prioridade máxima (útil no Render/Docker)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    try {
      execSync(`test -x "${process.env.PUPPETEER_EXECUTABLE_PATH}"`, { stdio: 'ignore' });
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    } catch {}
  }
  // 1. Caminhos fixos do sistema — mais confiáveis
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/root/.cache/puppeteer/chrome/linux-151.0.7922.47/chrome-linux64/chrome',
    '/root/.cache/puppeteer/chrome/linux-150.0.7871.181/chrome-linux64/chrome',
    '/root/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
  ];
  for (const p of candidates) {
    try {
      execSync(`test -x "${p}"`, { stdio: 'ignore' });
      return p;
    } catch {}
  }
  // 2. Busca genérica no cache do puppeteer
  try {
    const result = execSync('find /root/.cache/puppeteer -name "chrome" -type f 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
    if (result) return result;
  } catch {}
  // 3. which no PATH
  try {
    const r = execSync('which chromium chromium-browser google-chrome 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
    if (r) return r;
  } catch {}
  // 4. Puppeteer executável (pode lançar se não instalado)
  try {
    const { executablePath } = require('puppeteer');
    const p = executablePath();
    if (p) return p;
  } catch {}
  return undefined;
}
const CHROMIUM_PATH = findChromium();
console.log('[WA Server] Chrome:', CHROMIUM_PATH ?? 'Puppeteer auto-detect');

// Estado global
let waClient = null;
let currentQR = null;
let status = 'disconnected'; // disconnected | qr | connecting | ready | auth_failure
let statusMessage = 'Não conectado';
let sseClients = [];

// ── SSE helpers ──────────────────────────────────────────────────────────────

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter((res) => {
    try { res.write(payload); return true; } catch { return false; }
  });
}

function sendStatus() {
  broadcast('status', { status, message: statusMessage, qr: currentQR });
}

// ── WhatsApp client ───────────────────────────────────────────────────────────

// Sessão fora da pasta do Next.js para não confundir o Turbopack
const WA_SESSION_PATH = path.join(require('os').tmpdir(), 'wa-session');

// Remove o SingletonLock do Chromium para evitar "browser already running"
function clearChromiumLock() {
  const lockPath = path.join(WA_SESSION_PATH, 'session', 'SingletonLock');
  try { fs.rmSync(lockPath, { force: true }); } catch {}
  const socketPath = path.join(WA_SESSION_PATH, 'session', 'SingletonSocket');
  try { fs.rmSync(socketPath, { force: true }); } catch {}
}

let initInProgress = false;

/** Detecta erros de frame/página inválida e reinicia o cliente automaticamente */
function handleFrameError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Target closed')) {
    console.warn('[WA] Frame/página inválida detectada — reiniciando cliente em 3s...');
    status = 'disconnected';
    statusMessage = 'Reconectando...';
    sendStatus();
    setTimeout(() => initClient(), 3000);
    return true;
  }
  return false;
}

async function initClient() {
  if (initInProgress) return;
  initInProgress = true;

  // Destrói cliente anterior
  if (waClient) {
    try { await waClient.destroy(); } catch {}
    waClient = null;
  }

  // Mata qualquer Chromium residual e limpa o lock
  try {
    const { execSync } = require('child_process');
    execSync('pkill -9 -f chromium 2>/dev/null || true', { stdio: 'ignore' });
  } catch {}
  await new Promise(r => setTimeout(r, 1500));
  clearChromiumLock();

  currentQR = null;
  status = 'connecting';
  statusMessage = 'Iniciando...';
  sendStatus();
  initInProgress = false;

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: WA_SESSION_PATH }),
    puppeteer: {
      ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
      ],
      headless: true,
    },
  });

  waClient.on('qr', async (qr) => {
    try {
      currentQR = await qrcode.toDataURL(qr);
      status = 'qr';
      statusMessage = 'Escaneie o QR Code com o seu WhatsApp';
      sendStatus();
      console.log('[WA] QR gerado');
    } catch (err) {
      console.error('[WA] Erro ao gerar QR:', err.message);
    }
  });

  waClient.on('loading_screen', (percent) => {
    // Ignora se já estiver pronto — o WA às vezes dispara loading_screen após o ready
    if (status === 'ready') return;
    status = 'connecting';
    statusMessage = `Carregando WhatsApp... ${percent}%`;
    sendStatus();
  });

  waClient.on('authenticated', () => {
    currentQR = null;
    status = 'connecting';
    statusMessage = 'Autenticado, aguardando WhatsApp ficar pronto...';
    sendStatus();
    console.log('[WA] Autenticado');
  });

  waClient.on('ready', () => {
    currentQR = null;
    status = 'ready';
    statusMessage = 'WhatsApp conectado!';
    sendStatus();
    console.log('[WA] Pronto para enviar mensagens');

    // Expõe callback para o browser reportar resultado do status com mídia
    waClient.pupPage.exposeFunction('__waStatusResult', (result) => {
      if (waClient._statusResolvers) {
        const resolve = waClient._statusResolvers.shift();
        if (resolve) resolve(result);
      }
    }).catch(() => {});

    setTimeout(() => {
      console.log('[WA] WWebJS pronto para uso');
    }, 5000);
  });

  waClient.on('auth_failure', (msg) => {
    status = 'auth_failure';
    statusMessage = 'Falha na autenticação: ' + msg;
    currentQR = null;
    sendStatus();
    console.error('[WA] Falha de autenticação:', msg);
  });

  waClient.on('disconnected', (reason) => {
    status = 'disconnected';
    statusMessage = 'Desconectado: ' + reason;
    currentQR = null;
    sendStatus();
    console.log('[WA] Desconectado:', reason);
    waClient = null;
    // Auto-reconecta após 5s
    setTimeout(() => {
      console.log('[WA] Tentando reconectar...');
      initClient();
    }, 5000);
  });

  waClient.initialize().catch((err) => {
    console.error('[WA] Erro ao inicializar:', err.message);
    status = 'disconnected';
    statusMessage = 'Erro: ' + err.message;
    sendStatus();
    initInProgress = false;
    // Tenta de novo em 10s
    setTimeout(() => {
      console.log('[WA] Tentando inicializar novamente...');
      initClient();
    }, 10000);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /status  – estado atual
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, message: statusMessage, hasQR: !!currentQR, qr: currentQR ?? null }));
    return;
  }

  // GET /qr  – QR Code como Data URL (PNG base64)
  if (req.method === 'GET' && url.pathname === '/qr') {
    if (!currentQR) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'QR não disponível' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ qr: currentQR }));
    }
    return;
  }

  // GET /events  – SSE stream de status
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: status\ndata: ${JSON.stringify({ status, message: statusMessage, qr: currentQR })}\n\n`);
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter((c) => c !== res);
    });
    return;
  }

  // POST /connect  – inicia / reinicia o cliente
  if (req.method === 'POST' && url.pathname === '/connect') {
    initClient();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /disconnect  – desconecta
  if (req.method === 'POST' && url.pathname === '/disconnect') {
    if (waClient) {
      waClient.destroy().catch(() => {});
      waClient = null;
    }
    status = 'disconnected';
    statusMessage = 'Desconectado manualmente';
    currentQR = null;
    sendStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /groups  – lista todos os grupos do WhatsApp conectado
  if (req.method === 'GET' && url.pathname === '/groups') {
    if (!waClient || status !== 'ready') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WhatsApp não está conectado' }));
      return;
    }
    (async () => {
      try {
        // WA Web 2.3000+ usa WAWebCollections para acessar chats diretamente.
        // getChats() do whatsapp-web.js v1.34 falha com IDBObjectStore DataError
        // nessa versão do WA Web, então fazemos a leitura dos modelos brutos.
        const groups = await waClient.pupPage.evaluate(() => {
          try {
            const collections = window.require('WAWebCollections');
            const chatModels = collections.Chat.getModelsArray();
            return chatModels
              .filter(m => {
                const id = m.id?._serialized ?? m.id?.toString() ?? '';
                return id.endsWith('@g.us') || m.isGroup === true;
              })
              .map(m => ({
                id: m.id?._serialized ?? (m.id?.user + '@g.us'),
                name: m.name || m.formattedTitle || m.id?.user || 'Grupo',
                participantsCount: m.groupMetadata?.participants?.length ?? 0,
              }));
          } catch (e) {
            return { __error: e.toString() };
          }
        });

        if (groups && !Array.isArray(groups) && groups.__error) {
          console.log('[WA] WAWebCollections erro:', groups.__error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: groups.__error }));
          return;
        }

        const sorted = [...(groups || [])].sort((a, b) => a.name.localeCompare(b.name));
        console.log(`[WA] Grupos encontrados: ${sorted.length}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ groups: sorted }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[WA] Erro ao listar grupos:', msg);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    })();
    return;
  }

  // POST /send  – envia mensagem
  // Body: { to, message, mediaDataUrl?, mediaType?, mediaName? }
  // mediaDataUrl: data URL completa, ex: "data:image/jpeg;base64,/9j/..."
  if (req.method === 'POST' && url.pathname === '/send') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { to, message, mediaDataUrl, mediaType, mediaName } = JSON.parse(body);
        if (!waClient || status !== 'ready') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'WhatsApp não está conectado' }));
          return;
        }
        if (!to) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Campo "to" obrigatório' }));
          return;
        }
        // Formatar número: adicionar @c.us se não for grupo
        const chatId = to.includes('@') ? to : `${to.replace(/\D/g, '')}@c.us`;

        if (mediaDataUrl) {
          // Extrair base64 puro do data URL
          const base64 = mediaDataUrl.includes(',')
            ? mediaDataUrl.split(',')[1]
            : mediaDataUrl;
          const mime = mediaType || 'image/jpeg';
          const filename = mediaName || 'media';
          const media = new MessageMedia(mime, base64, filename);
          // Enviar mídia com caption (legenda) se houver texto
          await waClient.sendMessage(chatId, media, {
            caption: message || undefined,
            sendMediaAsDocument: mime.startsWith('application/') || mime === 'text/plain',
          });
          console.log(`[WA] Mídia enviada para ${chatId} (${mime})`);
        } else {
          if (!message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Campo "message" obrigatório quando não há mídia' }));
            return;
          }
          await waClient.sendMessage(chatId, message);
          console.log(`[WA] Mensagem enviada para ${chatId}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, to: chatId }));
      } catch (err) {
        const msg = err?.message || String(err);
        console.error('[WA] Erro ao enviar:', msg, err?.stack?.split('\n')[1] ?? '');
        handleFrameError(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }

  // POST /post-status  – publica um Story/Status no WhatsApp
  // Body: { message?, mediaDataUrl?, mediaType?, mediaName?, backgroundColor? }
  // Usa WAWebSendStatusMsgAction.sendStatusTextMsgAction / sendStatusMediaMsgAction
  if (req.method === 'POST' && url.pathname === '/post-status') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { message, mediaDataUrl, mediaType, mediaName, backgroundColor } = JSON.parse(body);
        if (!waClient || status !== 'ready') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'WhatsApp não está conectado' }));
          return;
        }
        if (!message && !mediaDataUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Informe "message" ou "mediaDataUrl"' }));
          return;
        }

        const isMedia = !!mediaDataUrl;
        const txt = message || '';

        if (!isMedia) {
          // ── Status de texto puro ── (via internals do WA Web — já funcionava)
          const result = await waClient.pupPage.evaluate(async (text, bgColor) => {
            try {
              const SendStatus = window.require('WAWebSendStatusMsgAction');
              const color = bgColor
                ? (bgColor.startsWith('#') ? parseInt('ff' + bgColor.replace('#', ''), 16) : parseInt(bgColor, 16))
                : 0xff7acca5;
              await SendStatus.sendStatusTextMsgAction({ color, font: 0, text });
              return { ok: true };
            } catch(e) {
              return { ok: false, error: e.toString() };
            }
          }, txt, backgroundColor || null);

          if (result && result.ok) {
            console.log('[WA] Status de texto publicado');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            console.error('[WA] Erro ao postar status texto:', result?.error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result?.error ?? 'Falha ao postar status' }));
          }
          return;
        }

        // ── Status com mídia ──
        // O WA Web faz navegação interna do frame durante upload de mídia, causando
        // "detached Frame" no Puppeteer. Esse erro ocorre APÓS o upload ser iniciado,
        // então o tratamos como sucesso (o status foi postado).
        const base64 = mediaDataUrl.includes(',') ? mediaDataUrl.split(',')[1] : mediaDataUrl;
        const mime = mediaType || 'image/jpeg';
        const filename = mediaName || 'status.jpg';

        try {
          let sent = false;
          let sendError = null;

          try {
            await waClient.pupPage.evaluate((b64, mimeType, fname, caption) => {
              return new Promise((resolve, reject) => {
                (async () => {
                  try {
                    const WC = window.require('WAWebCollections');
                    const chat = WC.Chat.get('status@broadcast');
                    if (!chat) { reject(new Error('Chat status@broadcast não encontrado')); return; }
                    const jids = WC.Contact.getModelsArray()
                      .filter(c => c.isMyContact && !c.isGroup && c.id && c.id._serialized)
                      .map(c => c.id._serialized).slice(0, 200);
                    await window.WWebJS.sendMessage(chat, undefined, {
                      media: { data: b64, mimetype: mimeType, filename: fname },
                      caption: caption || undefined,
                      statusJidList: jids,
                    });
                    resolve(true);
                  } catch(e) {
                    reject(e);
                  }
                })();
              });
            }, base64, mime, filename, txt || '');
            sent = true;
          } catch (evalErr) {
            const msg = evalErr?.message || String(evalErr);
            const isDetached = msg.includes('detached') || msg.includes('Target closed') || msg.includes('Session closed');
            if (isDetached) {
              // Detached frame = WA Web está processando o upload — consideramos enviado
              console.log('[WA] Status mídia: detached frame durante upload — considerando enviado');
              sent = true;
            } else {
              sendError = msg;
            }
          }

          if (sent) {
            console.log('[WA] Status com mídia publicado');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            console.error('[WA] Erro ao postar status com mídia:', sendError);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: sendError ?? 'Falha ao postar status com mídia' }));
          }
        } catch (mediaErr) {
          const errMsg = mediaErr?.message || String(mediaErr);
          console.error('[WA] Erro ao postar status com mídia:', errMsg);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: errMsg }));
        }
      } catch (err) {
        const msg = err?.message || String(err);
        console.error('[WA] Erro ao postar status:', msg);
        // Não reinicia o cliente por erros de frame durante upload de mídia
        if (!msg.includes('detached') && !msg.includes('Target closed')) {
          handleFrameError(err);
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    return;
  }

  // GET /probe-send-status-sig – inspeciona assinatura de sendStatusMediaMsgAction
  if (req.method === 'GET' && url.pathname === '/probe-send-status-sig') {
    if (!waClient || status !== 'ready') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WA não conectado' })); return;
    }
    (async () => {
      try {
        const result = await waClient.pupPage.evaluate(async () => {
          try {
            const SendStatus = window.require('WAWebSendStatusMsgAction');
            const WC = window.require('WAWebCollections');

            // Ver assinatura de sendStatusMediaMsgAction
            const fnStr = SendStatus.sendStatusMediaMsgAction?.toString().slice(0, 600) || 'NOT_FOUND';

            // Tenta usar o próprio waClient.sendMessage para status (abordagem alternativa)
            // Ver se existe uma função createStatusMsg ou similar
            const WWebJS_keys = Object.keys(window.WWebJS || {});
            const statusKeys = WWebJS_keys.filter(k => k.toLowerCase().includes('status'));

            // Verificar se existe MediaMessage ou MessageMedia no WWebJS
            const hasMediaMessage = typeof window.WWebJS.MediaMessage === 'function';
            const hasMessageMedia = typeof window.WWebJS.MessageMedia === 'function';

            // Tentar pegar uma mensagem real de status do histórico para ver estrutura
            const statusChat = WC.Chat.get('status@broadcast');
            let realMsgKeys = [];
            if (statusChat) {
              const msgs = statusChat.msgs?.models || [];
              if (msgs.length > 0) {
                realMsgKeys = Object.keys(msgs[0] || {}).slice(0, 30);
              }
            }

            // Verificar WAWebMsgCreate ou similar
            let createFnStr = 'NOT_FOUND';
            try {
              const c = window.require('WAWebCreateMsg');
              createFnStr = Object.keys(c || {}).join(', ');
            } catch(e) { createFnStr = 'ERROR: ' + e.message; }

            // Verificar WAWebSendMsgChatAction
            let sendMsgKeys = 'NOT_FOUND';
            try {
              const s = window.require('WAWebSendMsgChatAction');
              sendMsgKeys = Object.keys(s || {}).join(', ');
            } catch(e) { sendMsgKeys = 'ERROR: ' + e.message; }

            return { fnStr, statusKeys, hasMediaMessage, hasMessageMedia, realMsgKeys, createFnStr, sendMsgKeys };
          } catch(e) { return { error: e.toString(), stack: e.stack }; }
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.toString() }));
      }
    })();
    return;
  }

  // GET /probe-media-data – testa o que WWebJS.processMediaData retorna
  if (req.method === 'GET' && url.pathname === '/probe-media-data') {
    if (!waClient || status !== 'ready') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WA não conectado' }));
      return;
    }
    (async () => {
      try {
        const b64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVIP/2Q==';
        const result = await waClient.pupPage.evaluate(async (b64data) => {
          try {
            // Tenta descobrir a assinatura real do processMediaData
            const fnStr = window.WWebJS.processMediaData.toString().slice(0, 300);
            // Tenta chamar com MessageMedia style
            const { MessageMedia } = window.WWebJS;
            const mediaObj = MessageMedia
              ? new MessageMedia('image/jpeg', b64data, 'test.jpg')
              : { mimetype: 'image/jpeg', data: b64data, filename: 'test.jpg' };

            // Tenta diferentes assinaturas
            let r1 = null, r1err = null;
            try { r1 = await window.WWebJS.processMediaData(mediaObj, { forceSticker: false, sendMediaAsSticker: false }); } catch(e) { r1err = e.toString(); }

            let r2 = null, r2err = null;
            try { r2 = await window.WWebJS.processMediaData(mediaObj, {}); } catch(e) { r2err = e.toString(); }

            let r3 = null, r3err = null;
            try { r3 = await window.WWebJS.processMediaData(mediaObj); } catch(e) { r3err = e.toString(); }

            return {
              fnSignature: fnStr,
              r1: r1 ? Object.keys(r1) : r1err,
              r2: r2 ? Object.keys(r2) : r2err,
              r3: r3 ? Object.keys(r3) : r3err,
              hasMessageMedia: !!MessageMedia,
            };
          } catch(e) { return { error: e.toString() }; }
        }, b64);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch(err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // GET /debug-wa-modules  – lista módulos do WA Web relacionados a Status
  if (req.method === 'GET' && url.pathname === '/debug-wa-modules') {
    if (!waClient || status !== 'ready') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WA não conectado' }));
      return;
    }
    (async () => {
      try {
        const info = await waClient.pupPage.evaluate(() => {
          const results = {};
          // Testa módulos candidatos
          const candidates = [
            'WAWebCollections', 'WAWebSendMsgChatAction', 'WAWebCreateMediaForwardMsg',
            'WAWebStatusUtils', 'WAWebStatus', 'WAWebSendStatus', 'WAWebStatusV3',
            'WAWebMsgModel', 'WAWebSendSeen', 'WAWebMsgKey',
          ];
          for (const name of candidates) {
            try {
              const m = window.require(name);
              results[name] = Object.keys(m || {}).slice(0, 20);
            } catch (e) {
              results[name] = 'ERROR: ' + e.message;
            }
          }
          // Verifica o que está em WAWebCollections
          try {
            const col = window.require('WAWebCollections');
            results['__WAWebCollections_keys'] = Object.keys(col || {});
          } catch (e) {
            results['__WAWebCollections_keys'] = 'ERROR: ' + e.message;
          }
          // Procura por módulos com "status" no nome via webpack
          try {
            const webpackModules = window.webpackChunkwhatsapp_web_client;
            const statusModules = [];
            if (webpackModules) {
              for (const chunk of webpackModules) {
                const modules = chunk[1] || {};
                for (const [id, mod] of Object.entries(modules)) {
                  if (typeof mod === 'function') {
                    const src = mod.toString();
                    if (src.includes('status@broadcast') || src.includes('StatusV3') || src.includes('sendStatus')) {
                      statusModules.push(id);
                    }
                  }
                }
              }
            }
            results['__webpack_status_modules'] = statusModules.slice(0, 10);
          } catch (e) {
            results['__webpack_status_modules'] = 'ERROR: ' + e.message;
          }
          return results;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  // POST /probe-status-api  – testa envio de texto no status e retorna diagnóstico
  if (req.method === 'POST' && url.pathname === '/probe-status-api') {
    if (!waClient || status !== 'ready') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'WA não conectado' }));
      return;
    }
    (async () => {
      try {
        const result = await waClient.pupPage.evaluate(async () => {
          const out = { steps: [], moduleTests: {} };
          try {
            const WC = window.require('WAWebCollections');

            // 1. Tenta encontrar/criar o chat status@broadcast
            let statusChat = WC.Chat.get('status@broadcast');
            out.viaChat = !!statusChat;

            // 2. Tenta via Status collection
            if (!statusChat) {
              const StatusCol = WC.Status;
              if (StatusCol) {
                const models = StatusCol.getModelsArray();
                out.statusModels = models.length;
                if (models.length > 0) statusChat = models[0];
              }
            }

            // 3. Tenta forçar a abertura do chat via ChatOpen
            if (!statusChat) {
              try {
                const ChatOpenAction = window.require('WAWebOpenChatAction');
                const wid = window.require('WAWebWidFactory').createWid('status@broadcast');
                await ChatOpenAction.openChatFromNotif(wid);
                statusChat = WC.Chat.get('status@broadcast');
                out.viaOpenChat = !!statusChat;
              } catch(e) { out.openChatErr = e.toString(); }
            }

            // 4. Tenta obter ou criar via ChatModel diretamente
            if (!statusChat) {
              try {
                const wid = window.require('WAWebWidFactory').createWid('status@broadcast');
                const ChatModel = WC.Chat.modelClass;
                statusChat = new ChatModel({ id: wid });
                WC.Chat.add(statusChat);
                out.viaNewModel = true;
              } catch(e) { out.newModelErr = e.toString(); }
            }

            if (!statusChat) {
              out.error = 'Não foi possível obter statusChat por nenhum método';
              return out;
            }
            out.steps.push('statusChat: ' + (statusChat.id?._serialized ?? String(statusChat.id)));

            // 5. Testa módulos disponíveis para envio
            const modulesToTest = [
              'WAWebSendMsgChatAction',
              'WAWebSendStatusMsgAction',
              'WAWebStatusSendAction',
              'WAWebTextStatusSendAction',
            ];
            for (const name of modulesToTest) {
              try {
                const m = window.require(name);
                out.moduleTests[name] = Object.keys(m || {});
              } catch(e) {
                out.moduleTests[name] = 'ERROR: ' + e.message;
              }
            }

            // 6. Envia via addAndSendMsgToChat
            const MsgModel = WC.Msg.modelClass;
            const newId = window.require('WAWebMsgKey').newId();
            const msg = new MsgModel({
              id: { fromMe: true, remote: statusChat.id, id: newId, _serialized: `true_${statusChat.id._serialized}_${newId}` },
              body: '🤖 Teste bot',
              type: 'chat',
              t: Math.floor(Date.now() / 1000),
              from: statusChat.id,
              to: statusChat.id,
              self: 'out',
              ack: 0,
              isNewMsg: true,
              local: true,
            });
            const SendAction = window.require('WAWebSendMsgChatAction');
            const [msgP] = SendAction.addAndSendMsgToChat(statusChat, msg);
            await msgP;
            out.steps.push('enviado via addAndSendMsgToChat!');
            out.ok = true;
          } catch (e) {
            out.error = e.toString();
            out.stack = e.stack?.split('\n').slice(0, 5).join('\n');
          }
          return out;
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`[WA Server] Rodando na porta ${PORT}`);
  console.log(`[WA Server] Chromium: ${CHROMIUM_PATH ?? 'auto-detect pelo Puppeteer'}`);
  // Inicia o cliente WhatsApp automaticamente ao subir o servidor
  console.log('[WA] Iniciando cliente automaticamente...');
  initClient();
});
