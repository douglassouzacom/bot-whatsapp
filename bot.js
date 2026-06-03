const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const http = require('http');
const sharp = require('sharp');

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
const instagramPosts = new Map(); // stanzaId → { postId, caption, hora }

// =============================================
//  MAKE WEBHOOK (Instagram)
// =============================================
const MAKE_WEBHOOK         = 'https://hook.us2.make.com/r6cbsk7od1ediwz5glih8657khcpzmd0';
const MAKE_WEBHOOK_VENDIDO = 'https://hook.us2.make.com/r6cbsk7od1ediwz5glih8657khcpzmd0'; // mesmo webhook, roteado por action

// redimensiona imagem para 1:1 sem cortar (fundo preto)
async function prepararImagemInstagram(buffer) {
    try {
        return await sharp(buffer)
            .resize(1080, 1080, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
            .jpeg({ quality: 100 })
            .toBuffer();
    } catch (err) {
        registrarErro('Sharp', err.message);
        return buffer;
    }
}

// Palavras que indicam REDUÇÃO DE PREÇO — NÃO postar no Instagram
const PALAVRAS_ABAIXOU = ['abaixou', 'abaixei', 'baixou', 'baixei', 'baixamos', 'desconto', 'reduzi', 'reduzido', 'nova oferta', 'novo valor', 'preço novo', 'valor novo'];

function isAnuncioAbaixouPreco(texto) {
    const lower = texto.toLowerCase();
    return PALAVRAS_ABAIXOU.some(p => lower.includes(p));
}

// Envia nova foto para Make (posta no Instagram) e guarda o postId retornado
async function enviarNovaFotoParaMake(buffer, legenda, stanzaId, tentativa = 1) {
    try {
        const axios = require('axios');
        const { url } = gerarUrlImagem(buffer);

        const res = await axios.post(MAKE_WEBHOOK, {
            action: 'post',
            caption: legenda,
            imageUrl: url,
        }, { timeout: 30000 });

        stats.instagramPostado++;
        stats.ultimoInstagram = new Date().toLocaleString('pt-BR') + ' — ' + legenda.slice(0, 40);
        registrarSucesso('Instagram', `Postado! Status ${res.status}`);

        // Guarda postId se Make retornar (necessário para VENDIDO)
        const postId = res.data?.postId || res.data?.id || null;
        if (postId && stanzaId) {
            instagramPosts.set(stanzaId, { postId, caption: legenda, hora: new Date().toISOString() });
            console.log(`🔖 Instagram postId armazenado: ${postId} (msg: ${stanzaId})`);
        }

        stats.filaRetry = stats.filaRetry.filter(f => f.stanzaId !== stanzaId);

    } catch (err) {
        stats.instagramFalha++;
        registrarErro('Make/Post', `Tentativa ${tentativa}: ${err.message}`);

        if (tentativa < 3) {
            const espera = tentativa * 30000;
            console.log(`🔁 Retentando em ${espera / 1000}s... (tentativa ${tentativa + 1}/3)`);
            const jaExiste = stats.filaRetry.find(f => f.stanzaId === stanzaId);
            if (!jaExiste) stats.filaRetry.push({ tipo: 'Post Instagram', stanzaId, tentativas: tentativa });
            else jaExiste.tentativas = tentativa;
            setTimeout(() => enviarNovaFotoParaMake(buffer, legenda, stanzaId, tentativa + 1), espera);
        } else {
            registrarErro('Make/Post', `FALHOU 3x: ${legenda.slice(0, 40)}`);
            stats.filaRetry = stats.filaRetry.filter(f => f.stanzaId !== stanzaId);
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
        instagramPosts.delete(stanzaIdCitado); // remove do mapa após marcar

    } catch (err) {
        registrarErro('Make/Vendido', err.message);
    }
}

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
    </body></html>`;
}

let ultimoQR = null;

// Servidor web — painel + QR Code + serviço de imagens
http.createServer(async (req, res) => {
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
const HORA_AVISO          = 6;
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

function agendarAvisoMatinal(sock, grupoAvisoId) {
    const agora   = new Date();
    const disparo = new Date();
    disparo.setHours(HORA_AVISO, MINUTO_AVISO, 0, 0);
    if (disparo <= agora) disparo.setDate(disparo.getDate() + 1);

    const ms      = disparo - agora;
    const horas   = Math.floor(ms / 3600000);
    const minutos = Math.floor((ms % 3600000) / 60000);
    console.log(`⏰ Aviso matinal agendado para ${disparo.toLocaleTimeString('pt-BR')} (em ${horas}h ${minutos}min)`);

    setTimeout(async () => {
        try {
            await sock.sendMessage(grupoAvisoId, { text: TEXTO_AVISO });
            registrarSucesso('Aviso Matinal', 'Enviado com sucesso!');
        } catch (err) {
            registrarErro('Aviso Matinal', err.message);
        }
        agendarAvisoMatinal(sock, grupoAvisoId);
    }, ms);
}

async function iniciarBot() {
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
            const reiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão encerrada. Reiniciando:', reiniciar);
            if (reiniciar) {
                stats.reconexoes++;
                registrarErro('Conexão', `Desconectado. Reconectando (tentativa ${stats.reconexoes})...`);
                setTimeout(iniciarBot, 3000);
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
                if (nome === GRUPO_DESTINO_NOME.toLowerCase())        { grupoDestinoId = id; registrarSucesso('Grupos', 'Destino: ' + info.subject); }
                if (nome === GRUPO_AVISO_NOME.toLowerCase())          { grupoAvisoId   = id; registrarSucesso('Grupos', 'Aviso:   ' + info.subject); }
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
                        const buffer    = await downloadMediaMessage(
                            { message: msgCitada, key: msg.key }, 'buffer', {},
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

                    // Posta no Instagram SOMENTE se NÃO for redução de preço
                    if (tipoMidia === 'image') {
                        if (isAnuncioAbaixouPreco(textoAjustado)) {
                            console.log('💲 Redução de preço detectada — NÃO postando no Instagram');
                        } else {
                            const stanzaId = msg.key.id;
                            const legendaIG = textoAjustado + '\n\n#repasse #repasseminasbrasil #carros #bh #veiculos #seminovo';
                            const bufferIG = await prepararImagemInstagram(buffer);
                            enviarNovaFotoParaMake(bufferIG, legendaIG, stanzaId); // assíncrono
                        }
                    }
                } else if (textoAjustado.trim()) {
                    await sock.sendMessage(grupoDestinoId, { text: textoAjustado });
                    stats.mensagensReencaminhadas++;
                }

                console.log(`📨 Reencaminhado: "${texto.slice(0, 60)}"`);
            } catch (err) {
                registrarErro('Mensagem', err.message);
            }
        }
    });
}

iniciarBot();
