require('dotenv').config();

// Suprimir logs internos do Baileys (Signal protocol session noise)
const _warn = console.warn.bind(console);
const _BAILEYS_RE = /Closing open session|Closing session:|SessionEntry|_chains|chainKey|registrationId|currentRatchet|ephemeralKeyPair|rootKey|indexInfo|baseKey|remoteIdentityKey/;
console.warn = (...a) => { if (!a.some(x => _BAILEYS_RE.test(String(x)))) _warn(...a); };

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const http = require('http');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// =============================================
//  SISTEMA DE MONITORAMENTO E AUTO-REPARO
// =============================================
const stats = {
    iniciadoEm: new Date().toISOString(),
    mensagensRecebidas: 0,
    mensagensReencaminhadas: 0,
    instagramPostado: 0,
    instagramFalha: 0,
    erros: [],
    ultimaMensagem: null,
    ultimoInstagram: null,
    reconexoes: 0,
    status: 'iniciando',
    // contadores diários — resetam à meia-noite
    diaPostado: 0,
    diaFalha: 0,
    diaReencaminhadas: 0,
    filaRetry: [],
};

function registrarErro(contexto, mensagem) {
    const entrada = { hora: new Date().toLocaleTimeString('pt-BR'), contexto, mensagem };
    stats.erros.unshift(entrada);
    if (stats.erros.length > 20) stats.erros.pop();
    console.error(`❌ [${contexto}] ${mensagem}`);
}

function registrarSucesso(contexto, mensagem) {
    console.log(`✅ [${contexto}] ${mensagem}`);
}

// =============================================
//  CACHE DE IMAGENS (qualidade máxima, sem Imgur)
// =============================================
// Armazena imagens em memória e as serve via URL própria
const imagensCache = new Map(); // token → { buffer, criadoEm }

// Limpa imagens com mais de 30 minutos
setInterval(() => {
    const agora = Date.now();
    for (const [token, data] of imagensCache.entries()) {
        if (agora - data.criadoEm > 30 * 60 * 1000) imagensCache.delete(token);
    }
}, 5 * 60 * 1000);

// Log diário de postagens + reset dos contadores à meia-noite
function agendarLogDiario() {
    const agora = new Date();
    const amanha = new Date(agora);
    amanha.setHours(0, 0, 0, 0);
    amanha.setDate(amanha.getDate() + 1);
    const msAteAmanha = amanha - agora;

    setTimeout(() => {
        console.log(
            `📊 [RESUMO DO DIA ${new Date().toLocaleDateString('pt-BR')}] ` +
            `Reencaminhadas: ${stats.diaReencaminhadas} | ` +
            `Instagram OK: ${stats.diaPostado} | ` +
            `Falhas: ${stats.diaFalha}`
        );
        stats.diaPostado = 0;
        stats.diaFalha = 0;
        stats.diaReencaminhadas = 0;
        agendarLogDiario(); // reagenda para a próxima meia-noite
    }, msAteAmanha);
}
agendarLogDiario();

// Limpa instagramPosts com mais de 7 dias (veículos já vendidos não precisam ficar em memória)
setInterval(() => {
    const limite = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let removidos = 0;
    for (const [id, dado] of instagramPosts.entries()) {
        if (new Date(dado.hora).getTime() < limite) {
            instagramPosts.delete(id);
            removidos++;
        }
    }
    if (removidos > 0) {
        console.log(`🧹 instagramPosts: ${removidos} entradas antigas removidas`);
        salvarInstagramPosts();
    }
}, 24 * 60 * 60 * 1000);

function gerarUrlImagem(buffer) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    imagensCache.set(token, { buffer, criadoEm: Date.now() });
    // RENDER_EXTERNAL_URL é definido automaticamente no Render.com
    const baseUrl = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    return { token, url: `${baseUrl}/img/${token}` };
}

// =============================================
//  MAPA DE POSTS DO INSTAGRAM (para marcar VENDIDO)
// =============================================
// Armazena: stanzaId da mensagem WhatsApp → instagramPostId
const INSTAGRAM_POSTS_FILE = path.join(__dirname, 'instagram_posts.json');

function carregarInstagramPosts() {
    try {
        if (fs.existsSync(INSTAGRAM_POSTS_FILE)) {
            const dados = JSON.parse(fs.readFileSync(INSTAGRAM_POSTS_FILE, 'utf8'));
            const mapa = new Map(Object.entries(dados));
            console.log(`📂 instagram_posts.json carregado: ${mapa.size} entradas`);
            return mapa;
        }
    } catch (err) {
        console.error('Erro ao carregar instagram_posts.json:', err.message);
    }
    return new Map();
}

function salvarInstagramPosts() {
    try {
        fs.writeFileSync(INSTAGRAM_POSTS_FILE, JSON.stringify(Object.fromEntries(instagramPosts), null, 2));
    } catch (err) {
        console.error('Erro ao salvar instagram_posts.json:', err.message);
    }
}

const instagramPosts = carregarInstagramPosts(); // stanzaId → { postId, caption, hora }

// Persiste e restaura filaRetry para dar visibilidade de retries perdidos em restart
const FILA_RETRY_FILE = path.join(__dirname, 'fila_retry.json');

function salvarFilaRetry() {
    try {
        fs.writeFileSync(FILA_RETRY_FILE, JSON.stringify(stats.filaRetry, null, 2));
    } catch (err) {
        console.error('Erro ao salvar fila_retry.json:', err.message);
    }
}

(function alertarRetrysPerdidos() {
    if (!fs.existsSync(FILA_RETRY_FILE)) return;
    try {
        const pendentes = JSON.parse(fs.readFileSync(FILA_RETRY_FILE, 'utf8'));
        if (pendentes.length > 0) {
            console.warn(`⚠️  ${pendentes.length} retry(s) pendente(s) foram perdidos no restart anterior:`);
            pendentes.forEach(f => console.warn(`   → ${f.tipo} | stanzaId: ${f.stanzaId} | tentativa: ${f.tentativas}`));
        }
        fs.writeFileSync(FILA_RETRY_FILE, JSON.stringify([]));
    } catch {}
})();

// Restaura o último post postado para que /vendido-teste funcione após restart
function restaurarUltimoPost() {
    if (instagramPosts.size === 0) return null;
    let ultimoDado = null;
    let ultimaHora = 0;
    for (const dado of instagramPosts.values()) {
        const hora = new Date(dado.hora || 0).getTime();
        if (hora > ultimaHora && dado.postId) {
            ultimaHora = hora;
            ultimoDado = dado;
        }
    }
    if (ultimoDado) {
        console.log(`🔖 Último post restaurado do disco: ${ultimoDado.postId} — "${(ultimoDado.caption || '').slice(0, 50)}"`);
        return { postId: ultimoDado.postId, caption: ultimoDado.caption || '' };
    }
    return null;
}

// =============================================
//  MAKE WEBHOOK (Instagram)
// =============================================
const MAKE_WEBHOOK         = process.env.MAKE_WEBHOOK;
const MAKE_WEBHOOK_VENDIDO = process.env.MAKE_WEBHOOK_VENDIDO || MAKE_WEBHOOK;

// Redimensiona para 1080x1080 com fundo desfocado da própria imagem + watermark da marca
async function prepararImagemInstagram(buffer) {
    try {
        // Fundo: imagem esticada + desfoque + escurecimento leve
        const fundo = await sharp(buffer)
            .resize(1080, 1080, { fit: 'cover', position: 'center' })
            .blur(28)
            .modulate({ brightness: 0.55 })
            .jpeg({ quality: 80 })
            .toBuffer();

        // Imagem principal centralizada com transparência nas bordas
        const frente = await sharp(buffer)
            .resize(1080, 1080, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();

        // Gradiente escuro + nome da marca na parte inferior
        const watermark = Buffer.from(`
            <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="black" stop-opacity="0"/>
                        <stop offset="100%" stop-color="black" stop-opacity="0.72"/>
                    </linearGradient>
                </defs>
                <rect x="0" y="860" width="1080" height="220" fill="url(#g)"/>
                <text x="540" y="1040" font-family="Arial Black, Arial, sans-serif"
                      font-size="40" font-weight="900" fill="white"
                      text-anchor="middle" letter-spacing="3">MINAS BRASIL REPASSE</text>
            </svg>`);

        return await sharp(fundo)
            .composite([
                { input: frente, blend: 'over' },
                { input: watermark, blend: 'over' },
            ])
            .jpeg({ quality: 95 })
            .toBuffer();
    } catch (err) {
        registrarErro('Sharp', err.message);
        return buffer;
    }
}

// Formata a legenda do Instagram: cabeçalho + corpo + CTA + hashtags separadas
function formatarLegendaInstagram(texto) {
    const corpo = texto.trim();
    return `🚗 MINAS BRASIL REPASSE

${corpo}

━━━━━━━━━━━━━━━━━━
💬 Consulte disponibilidade!
━━━━━━━━━━━━━━━━━━

.
.
.
#repasse #repasseminasbrasil #carrosbh #veiculosbh #seminovos #automoveis #carrosusados #minasbrasil #repassebh #comprarcarro #vendercarro #carrosminasgerais #bh`;
}

// Palavras que indicam REDUÇÃO DE PREÇO — NÃO postar no Instagram
const PALAVRAS_ABAIXOU = ['abaixou', 'abaixei', 'baixou', 'baixei', 'baixamos', 'desconto', 'reduzi', 'reduzido', 'nova oferta', 'novo valor', 'preço novo', 'valor novo'];

function isAnuncioAbaixouPreco(texto) {
    const lower = texto.toLowerCase();
    return PALAVRAS_ABAIXOU.some(p => lower.includes(p));
}

// Envia foto ou vídeo para Make (posta no Instagram) e guarda o postId retornado
// tipo: 'image' | 'video'
async function enviarMidiaParaMake(buffer, legenda, stanzaId, tipo = 'image', tentativa = 1) {
    try {
        const axios = require('axios');
        const { url } = gerarUrlImagem(buffer);
        const payload = tipo === 'video'
            ? { action: 'post_video', caption: legenda, videoUrl: url, stanzaId }
            : { action: 'post',       caption: legenda, imageUrl: url, stanzaId };

        const res = await axios.post(MAKE_WEBHOOK, payload, { timeout: 60000 });

        stats.instagramPostado++;
        stats.diaPostado++;
        stats.ultimoInstagram = new Date().toLocaleString('pt-BR') + ' — ' + legenda.slice(0, 40);
        registrarSucesso('Instagram', `Postado! Status ${res.status}`);

        // Guarda stanzaId + legenda agora; o postId chega via /webhook-instagram-id depois
        if (stanzaId) {
            instagramPosts.set(stanzaId, { postId: null, caption: legenda, hora: new Date().toISOString() });
            salvarInstagramPosts();
            console.log(`🔖 Aguardando postId do Make.com para msg ${stanzaId}`);
        }
        // Compatibilidade: se Make retornar o postId direto na resposta, usa também
        const postId = res.data?.postId || res.data?.id || null;
        if (postId && stanzaId) {
            const dado = instagramPosts.get(stanzaId) || { caption: legenda, hora: new Date().toISOString() };
            dado.postId = postId;
            instagramPosts.set(stanzaId, dado);
            salvarInstagramPosts();
            ultimoPostInstagram = { postId, caption: legenda };
            console.log(`🔖 Instagram postId armazenado direto: ${postId} (msg: ${stanzaId})`);
        }

        stats.filaRetry = stats.filaRetry.filter(f => f.stanzaId !== stanzaId);
        salvarFilaRetry();

    } catch (err) {
        stats.instagramFalha++;
        stats.diaFalha++;
        registrarErro('Make/Post', `Tentativa ${tentativa}: ${err.message}`);

        if (tentativa < 3) {
            // 429 = rate limit do Instagram: espera mais longa (90s/180s) para respeitar o cooldown
            const status = err.response?.status;
            const espera = status === 429 ? tentativa * 90000 : tentativa * 30000;
            const motivo = status === 429 ? '⏳ Rate limit (429)' : '🔁 Erro transitório';
            console.log(`${motivo} — retentando em ${espera / 1000}s... (tentativa ${tentativa + 1}/3)`);
            const jaExiste = stats.filaRetry.find(f => f.stanzaId === stanzaId);
            if (!jaExiste) stats.filaRetry.push({ tipo: 'Post Instagram', stanzaId, tentativas: tentativa });
            else jaExiste.tentativas = tentativa;
            salvarFilaRetry();
            setTimeout(() => enviarMidiaParaMake(buffer, legenda, stanzaId, tipo, tentativa + 1), espera);
        } else {
            registrarErro('Make/Post', `FALHOU 3x: ${legenda.slice(0, 40)}`);
            stats.filaRetry = stats.filaRetry.filter(f => f.stanzaId !== stanzaId);
            salvarFilaRetry();
        }
    }
}

// Marca post do Instagram como VENDIDO (adiciona comentário ou atualiza legenda)
async function marcarVendidoNoInstagram(stanzaIdCitado) {
    try {
        const axios = require('axios');
        const dado = instagramPosts.get(stanzaIdCitado);

        if (!dado) {
            console.log('⚠️ VENDIDO: postId do Instagram não encontrado para essa mensagem. Post pode ter sido feito antes desta sessão.');
            return;
        }

        await axios.post(MAKE_WEBHOOK, {
            action: 'vendido',
            postId: dado.postId,
            caption: dado.caption,
        }, { timeout: 15000 });

        registrarSucesso('Instagram/Vendido', `Post ${dado.postId} marcado como VENDIDO!`);
        instagramPosts.delete(stanzaIdCitado);
        salvarInstagramPosts();

    } catch (err) {
        registrarErro('Make/Vendido', err.message);
    }
}

// Último post do Instagram (para /vendido-teste) — restaurado do disco se disponível
let ultimoPostInstagram = restaurarUltimoPost();

// Painel HTML de monitoramento
function gerarHtmlStatus(qrDataUrl) {
    const uptime = Math.floor((Date.now() - new Date(stats.iniciadoEm)) / 1000);
    const horas  = Math.floor(uptime / 3600);
    const mins   = Math.floor((uptime % 3600) / 60);
    const segs   = uptime % 60;

    if (qrDataUrl) {
        return `<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
        <style>body{font-family:Arial,sans-serif;text-align:center;padding:40px;background:#1a1a2e;color:#eee}
        h2{color:#00d4ff}img{border:4px solid #00d4ff;border-radius:8px;padding:10px;background:#fff}</style></head>
        <body><h2>📱 Escaneie o QR Code com seu WhatsApp</h2>
        <img src="${qrDataUrl}"/><p>Página atualiza automaticamente a cada 10 segundos</p></body></html>`;
    }

    const corStatus = stats.status === 'conectado' ? '#00ff88' : stats.status === 'desconectado' ? '#ff4444' : '#ffaa00';
    const errosHtml = stats.erros.length === 0
        ? '<li style="color:#00ff88">Nenhum erro registrado ✅</li>'
        : stats.erros.map(e => `<li><b>${e.hora}</b> [${e.contexto}] ${e.mensagem}</li>`).join('');

    const filaHtml = stats.filaRetry.length === 0
        ? '<li style="color:#00ff88">Fila vazia ✅</li>'
        : stats.filaRetry.map(f => `<li>${f.tipo} — tentativa ${f.tentativas}</li>`).join('');

    return `<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15">
    <style>
      body{font-family:Arial,sans-serif;padding:20px;background:#1a1a2e;color:#eee;margin:0}
      h1{color:#00d4ff;font-size:22px} h2{color:#aaa;font-size:16px;border-bottom:1px solid #444;padding-bottom:5px}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:20px 0}
      .card{background:#16213e;border-radius:10px;padding:16px;text-align:center;border:1px solid #0f3460}
      .num{font-size:32px;font-weight:bold;color:#00d4ff} .label{font-size:12px;color:#888;margin-top:4px}
      .status{display:inline-block;padding:4px 14px;border-radius:20px;font-weight:bold;font-size:14px}
      ul{background:#16213e;border-radius:8px;padding:12px 12px 12px 28px;max-height:160px;overflow-y:auto}
      li{font-size:13px;margin:3px 0;color:#ccc}
    </style></head>
    <body>
    <h1>🤖 Minas Brasil Repasse — Painel do Bot</h1>
    <p>Status: <span class="status" style="background:${corStatus};color:#000">${stats.status.toUpperCase()}</span>
    &nbsp;|&nbsp; ⏱ Uptime: ${horas}h ${mins}m ${segs}s
    &nbsp;|&nbsp; 🔄 Reconexões: ${stats.reconexoes}
    &nbsp;|&nbsp; <small>Atualiza em 15s</small></p>

    <div class="grid">
      <div class="card"><div class="num">${stats.mensagensRecebidas}</div><div class="label">📨 Mensagens Recebidas</div></div>
      <div class="card"><div class="num">${stats.mensagensReencaminhadas}</div><div class="label">📤 Reencaminhadas</div></div>
      <div class="card"><div class="num">${stats.instagramPostado}</div><div class="label">📸 Instagram OK</div></div>
      <div class="card"><div class="num">${stats.instagramFalha}</div><div class="label">❌ Instagram Falha</div></div>
      <div class="card"><div class="num">${imagensCache.size}</div><div class="label">🖼️ Imagens em Cache</div></div>
      <div class="card"><div class="num">${instagramPosts.size}</div><div class="label">🔖 Posts Mapeados</div></div>
    </div>

    <h2>📋 Últimos Erros</h2>
    <ul>${errosHtml}</ul>

    <h2>🔁 Fila de Reenvio (retry)</h2>
    <ul>${filaHtml}</ul>

    <h2>📌 Últimas Atividades</h2>
    <ul>
      <li>💬 Última mensagem: ${stats.ultimaMensagem || 'nenhuma ainda'}</li>
      <li>📸 Último Instagram: ${stats.ultimoInstagram || 'nenhum ainda'}</li>
      <li>🕐 Bot iniciado em: ${new Date(stats.iniciadoEm).toLocaleString('pt-BR')}</li>
    </ul>

    <h2>🧪 Teste Manual</h2>
    ${ultimoPostInstagram
        ? `<p style="color:#aaa">Último post: <b style="color:#fff">${ultimoPostInstagram.caption.slice(0, 60)}...</b></p>
           <a href="/vendido-teste" style="display:inline-block;background:#ff4444;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;margin-top:8px">✅ Marcar último post como VENDIDO</a>`
        : `<p style="color:#888">Nenhum post feito ainda nesta sessão.<br>Aguarde um anúncio chegar do grupo Ronei Repasse.</p>`
    }
    </body></html>`;
}

let ultimoQR = null;

// Servidor web — painel + QR Code + serviço de imagens
http.createServer(async (req, res) => {
    // Rota QR dedicada: /qr
    if (req.url === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (ultimoQR) {
            const qrDataUrl = await QRCode.toDataURL(ultimoQR);
            res.end(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
            <style>body{font-family:Arial,sans-serif;text-align:center;padding:40px;background:#1a1a2e;color:#eee}
            h2{color:#00d4ff}img{border:4px solid #00d4ff;border-radius:8px;padding:10px;background:#fff}</style></head>
            <body><h2>📱 Escaneie o QR Code com seu WhatsApp</h2>
            <img src="${qrDataUrl}"/><p>Página atualiza automaticamente a cada 10 segundos</p>
            <p><a href="/" style="color:#00d4ff">← Voltar ao painel</a></p></body></html>`);
        } else {
            res.end(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5">
            <style>body{font-family:Arial,sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#eee}
            h2{color:#ffaa00}</style></head>
            <body><h2>⏳ Aguardando QR Code...</h2>
            <p>Status atual: <b>${stats.status}</b></p>
            <p>Se o bot está conectado, não é necessário escanear.</p>
            <p>Se está desconectado, acesse <a href="/reset-sessao" style="color:#ff4444">/reset-sessao</a> para forçar novo QR.</p>
            <p><a href="/" style="color:#00d4ff">← Voltar ao painel</a></p>
            <p style="color:#666;font-size:12px">Atualizando em 5s...</p></body></html>`);
        }
        return;
    }

    // Rota reset de sessão: /reset-sessao
    if (req.url === '/reset-sessao') {
        try {
            const sessaoDir = path.join(__dirname, 'sessao');
            if (fs.existsSync(sessaoDir)) {
                fs.readdirSync(sessaoDir).forEach(f => fs.unlinkSync(path.join(sessaoDir, f)));
            }
            ultimoQR = null;
            botRodando = false;
            stats.status = 'reiniciando';
            registrarSucesso('Reset', 'Sessão apagada — gerando novo QR...');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5;url=/qr">
            <style>body{font-family:Arial,sans-serif;text-align:center;padding:60px;background:#1a1a2e;color:#eee}
            h2{color:#00ff88}</style></head>
            <body><h2>✅ Sessão apagada!</h2>
            <p>O bot vai gerar um novo QR Code em instantes...</p>
            <p>Redirecionando para <a href="/qr" style="color:#00d4ff">/qr</a> em 5 segundos...</p></body></html>`);
            setTimeout(() => iniciarBot(), 1000);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body style="background:#1a1a2e;color:#ff4444;font-family:Arial;text-align:center;padding:60px">
            <h2>❌ Erro ao apagar sessão: ${err.message}</h2>
            <a href="/" style="color:#00d4ff">Voltar</a></body></html>`);
        }
        return;
    }

    // Rota de teste VENDIDO: /vendido-teste
    if (req.url === '/vendido-teste') {
        if (ultimoPostInstagram) {
            try {
                const axios = require('axios');
                await axios.post(MAKE_WEBHOOK, {
                    action: 'vendido',
                    postId: ultimoPostInstagram.postId,
                    caption: ultimoPostInstagram.caption,
                }, { timeout: 15000 });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/"></head>
                <body style="background:#1a1a2e;color:#eee;font-family:Arial;text-align:center;padding:60px">
                <h2 style="color:#00ff88">✅ Comando VENDIDO enviado com sucesso!</h2>
                <p>Post ID: <b>${ultimoPostInstagram.postId}</b></p>
                <p>Redirecionando para o painel...</p></body></html>`);
                registrarSucesso('Teste/Vendido', `Post ${ultimoPostInstagram.postId} marcado via painel`);
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body style="background:#1a1a2e;color:#ff4444;font-family:Arial;text-align:center;padding:60px">
                <h2>❌ Erro: ${err.message}</h2><a href="/" style="color:#00d4ff">Voltar</a></body></html>`);
            }
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><head><meta http-equiv="refresh" content="3;url=/"></head>
            <body style="background:#1a1a2e;color:#ffaa00;font-family:Arial;text-align:center;padding:60px">
            <h2>⚠️ Nenhum post feito nesta sessão ainda.</h2>
            <p>Aguarde um anúncio chegar do grupo Ronei Repasse.</p>
            <a href="/" style="color:#00d4ff">Voltar</a></body></html>`);
        }
        return;
    }

    // Rota de callback do Make.com com o postId do Instagram
    // Make.com envia: POST /webhook-instagram-id  { stanzaId, postId }
    if (req.method === 'POST' && req.url === '/webhook-instagram-id') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { stanzaId, postId } = JSON.parse(body);
                if (stanzaId && postId) {
                    const dado = instagramPosts.get(stanzaId) || {};
                    dado.postId = postId;
                    instagramPosts.set(stanzaId, dado);
                    ultimoPostInstagram = { postId, caption: dado.caption || '' };
                    salvarInstagramPosts();
                    registrarSucesso('Instagram/Callback', `postId ${postId} vinculado à msg ${stanzaId}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ erro: 'stanzaId e postId são obrigatórios' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ erro: err.message }));
            }
        });
        return;
    }

    // Rota de imagens: /img/:token
    if (req.url && req.url.startsWith('/img/')) {
        const token = req.url.slice(5);
        const dado = imagensCache.get(token);
        if (dado) {
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
            res.end(dado.buffer);
        } else {
            res.writeHead(404);
            res.end('Imagem não encontrada ou expirada');
        }
        return;
    }

    // Painel principal
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (ultimoQR) {
        const qrDataUrl = await QRCode.toDataURL(ultimoQR);
        res.end(gerarHtmlStatus(qrDataUrl));
    } else {
        res.end(gerarHtmlStatus(null));
    }
}).listen(process.env.PORT || 3000, () => {
    console.log('🌐 Painel de monitoramento rodando na porta ' + (process.env.PORT || 3000));
});

// =============================================
//  CONFIGURAÇÃO
// =============================================
const GRUPO_ORIGEM_NOME   = 'Ronei repasse';
const GRUPO_DESTINO_NOME  = 'MINAS BRASIL REPASSE GRUPO 8';
const GRUPO_AVISO_NOME    = 'MINAS BRASIL REPASSE GRUPO 8';
const ACRESCIMO           = 1000;
const HORA_AVISO          = 9;  // 9 UTC = 06:30 BRT
const MINUTO_AVISO        = 30;
// =============================================

const TEXTO_AVISO = `‼️ *INFORMAÇÕES IMPORTANTES* ‼️

➕ *AVISOS SOBRE O MERCADO DE REPASSE:*

*O REPASSE NÃO TEM GARANTIA* de motor, caixa, itens elétricos ou qualquer outro item. Vendido no estado em que se encontra, podendo haver vícios aparentes ou ocultos. Por isso é comercializado abaixo da Fipe. 🚨

Veículos *DESTINADOS SOMENTE A LOJISTAS E INVESTIDORES.*

*💰 PAGAMENTO:* Somente via *PIX ou TED* na conta da empresa. Não faça pagamentos em contas de pessoas físicas ou terceiros. Em caso de dúvida, faça uma vídeo chamada comigo.

*🚚 FRETE:* Enviamos para todo o Brasil, frete por conta do comprador. Não nos responsabilizamos por danos no transporte.

*🔍 VISTORIA CAUTELAR:* Sempre por conta do comprador. Recomendamos revisão do veículo após a compra.

*📦 PRAZO DE ENTREGA:* Em média 7 a 10 dias, podendo variar conforme localização.

*❌ NÃO ACEITAMOS:* Financiamento, consórcio, trocas. *Somente à vista.*

*Douglas Souza*
*Minas Brasil Repasse* 🚗

Fiquem atentos aos golpes! 🚨
*Boas vendas e ótimos negócios* 🚀`;

function ajustarPrecos(texto) {
    return texto.replace(/(R\$\s?)?(\d{1,3}(?:[.,]\d{3})+)/g, (match, prefixo, valorStr) => {
        const limpo  = valorStr.replace(/\./g, '').replace(',', '.');
        const numero = parseFloat(limpo);
        if (isNaN(numero)) return match;
        const novo    = numero + ACRESCIMO;
        const novoStr = novo.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        return (prefixo || '') + novoStr;
    });
}

// Handle global — cancelado e recriado a cada reconexão para evitar timers duplicados
let timerAvisoMatinal = null;

function agendarAvisoMatinal(sock, grupoAvisoId) {
    if (timerAvisoMatinal) {
        clearTimeout(timerAvisoMatinal);
        timerAvisoMatinal = null;
    }

    const agora   = new Date();
    const disparo = new Date();
    disparo.setHours(HORA_AVISO, MINUTO_AVISO, 0, 0);
    if (disparo <= agora) disparo.setDate(disparo.getDate() + 1);

    const ms      = disparo - agora;
    const horas   = Math.floor(ms / 3600000);
    const minutos = Math.floor((ms % 3600000) / 60000);
    console.log(`⏰ Aviso matinal agendado para ${disparo.toLocaleTimeString('pt-BR')} (em ${horas}h ${minutos}min)`);

    timerAvisoMatinal = setTimeout(async () => {
        timerAvisoMatinal = null;
        try {
            await sock.sendMessage(grupoAvisoId, { text: TEXTO_AVISO });
            registrarSucesso('Aviso Matinal', 'Enviado com sucesso!');
        } catch (err) {
            registrarErro('Aviso Matinal', err.message);
        }
        agendarAvisoMatinal(sock, grupoAvisoId);
    }, ms);
}

let botRodando = false;

async function iniciarBot() {
    if (botRodando) return;
    botRodando = true;
    const { state, saveCreds } = await useMultiFileAuthState('sessao');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            ultimoQR = qr;
            stats.status = 'aguardando_qr';
            console.log('\n📱 Acesse a URL do serviço no Render para escanear o QR Code!\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            ultimoQR = null;
            stats.status = 'conectado';
            console.log('\n✅ Bot conectado!\n');
        }
        if (connection === 'close') {
            stats.status = 'desconectado';
            botRodando = false;
            const reiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão encerrada. Reiniciando:', reiniciar);
            if (reiniciar) {
                stats.reconexoes++;
                registrarErro('Conexão', `Desconectado. Reconectando (tentativa ${stats.reconexoes})...`);
                setTimeout(iniciarBot, 8000);
            }
        }
    });

    let grupoOrigemId  = null;
    let grupoDestinoId = null;
    let grupoAvisoId   = null;

    async function buscarGrupos() {
        try {
            const grupos = await sock.groupFetchAllParticipating();
            for (const [id, info] of Object.entries(grupos)) {
                const nome = info.subject.toLowerCase();
                if (nome.includes(GRUPO_ORIGEM_NOME.toLowerCase()))  { grupoOrigemId  = id; registrarSucesso('Grupos', 'Origem:  ' + info.subject); }
                if (nome.includes(GRUPO_DESTINO_NOME.toLowerCase())) { grupoDestinoId = id; registrarSucesso('Grupos', 'Destino: ' + info.subject); }
                if (nome.includes(GRUPO_AVISO_NOME.toLowerCase()))   { grupoAvisoId   = id; registrarSucesso('Grupos', 'Aviso:   ' + info.subject); }
            }
            if (!grupoOrigemId)  registrarErro('Grupos', 'ORIGEM não encontrado: '  + GRUPO_ORIGEM_NOME);
            if (!grupoDestinoId) registrarErro('Grupos', 'DESTINO não encontrado: ' + GRUPO_DESTINO_NOME);
            if (!grupoAvisoId)   registrarErro('Grupos', 'AVISO não encontrado: '   + GRUPO_AVISO_NOME);

            if (grupoAvisoId) agendarAvisoMatinal(sock, grupoAvisoId);
        } catch (err) {
            registrarErro('buscarGrupos', err.message);
            setTimeout(buscarGrupos, 10000);
        }
    }

    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection === 'open') setTimeout(buscarGrupos, 3000);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid !== grupoOrigemId) continue;

                stats.mensagensRecebidas++;

                const texto = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || msg.message?.videoMessage?.caption
                    || '';

                stats.ultimaMensagem = new Date().toLocaleTimeString('pt-BR') + ' — ' + texto.slice(0, 50);

                const textoLower  = texto.toLowerCase();
                const isVendido   = textoLower.includes('vendido');
                const isReservado = textoLower.includes('reservado');

                // ── VENDIDO / RESERVADO ──────────────────────────────────────
                if (isVendido || isReservado) {
                    const status = isVendido ? '🚫 *VENDIDO*' : '⏳ *RESERVADO*';
                    const temMidia = msg.message?.imageMessage || msg.message?.videoMessage;
                    const msgCitada = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const temMidiaCitada = msgCitada?.imageMessage || msgCitada?.videoMessage;
                    const stanzaIdCitado = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;

                    if (temMidia) {
                        const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                        const tipoMidia = msg.message.imageMessage ? 'image' : 'video';
                        const mimetype  = msg.message[tipoMidia + 'Message']?.mimetype || 'image/jpeg';
                        const caption   = msg.message[tipoMidia + 'Message']?.caption || '';
                        await sock.sendMessage(grupoDestinoId, { [tipoMidia]: buffer, mimetype, caption: `${status}\n${caption}` });
                    } else if (temMidiaCitada) {
                        const tipoMidia = msgCitada.imageMessage ? 'image' : 'video';
                        const mimetype  = msgCitada[tipoMidia + 'Message']?.mimetype || 'image/jpeg';
                        const caption   = msgCitada[tipoMidia + 'Message']?.caption || '';
                        const chaveMsg  = {
                            id: stanzaIdCitado,
                            remoteJid: msg.key.remoteJid,
                            fromMe: false,
                        };
                        const buffer    = await downloadMediaMessage(
                            { message: msgCitada, key: chaveMsg }, 'buffer', {},
                            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        );
                        await sock.sendMessage(grupoDestinoId, { [tipoMidia]: buffer, mimetype, caption: `${status}\n${caption}` });
                    } else {
                        await sock.sendMessage(grupoDestinoId, { text: `${status}\n${texto}` });
                    }

                    // Marca VENDIDO no Instagram se tiver o postId mapeado
                    if (isVendido && stanzaIdCitado) {
                        await marcarVendidoNoInstagram(stanzaIdCitado);
                    }

                    stats.mensagensReencaminhadas++;
                    stats.diaReencaminhadas++;
                    console.log(`📢 Status reencaminhado: ${status}`);
                    continue;
                }

                // ── ANÚNCIO NORMAL ───────────────────────────────────────────
                const textoAjustado = ajustarPrecos(texto);
                const temMidia = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage;

                if (temMidia) {
                    const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    const tipoMidia = msg.message.imageMessage ? 'image' : msg.message.videoMessage ? 'video' : 'document';
                    const mimetype  = msg.message[tipoMidia + 'Message']?.mimetype || 'image/jpeg';

                    await sock.sendMessage(grupoDestinoId, { [tipoMidia]: buffer, mimetype, caption: textoAjustado });
                    stats.mensagensReencaminhadas++;
                    stats.diaReencaminhadas++;

                    // Posta no Instagram SOMENTE se NÃO for redução de preço
                    if (tipoMidia === 'image' || tipoMidia === 'video') {
                        if (isAnuncioAbaixouPreco(textoAjustado)) {
                            console.log('💲 Redução de preço detectada — NÃO postando no Instagram');
                        } else {
                            const stanzaId = msg.key.id;
                            const legendaIG = formatarLegendaInstagram(textoAjustado);
                            if (tipoMidia === 'image') {
                                const bufferIG = await prepararImagemInstagram(buffer);
                                enviarMidiaParaMake(bufferIG, legendaIG, stanzaId, 'image');
                            } else {
                                enviarMidiaParaMake(buffer, legendaIG, stanzaId, 'video');
                            }
                        }
                    }
                } else if (textoAjustado.trim()) {
                    await sock.sendMessage(grupoDestinoId, { text: textoAjustado });
                    stats.mensagensReencaminhadas++;
                    stats.diaReencaminhadas++;
                }

                console.log(`📨 Reencaminhado: "${texto.slice(0, 60)}"`);
            } catch (err) {
                registrarErro('Mensagem', err.message);
            }
        }
    });
}

iniciarBot();
