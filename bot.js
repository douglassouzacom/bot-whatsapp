const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const pino = require('pino');
const http = require('http');

// =============================================
//  MAKE WEBHOOK (Instagram)
// =============================================
const MAKE_WEBHOOK = 'https://hook.us2.make.com/r6cbsk7od1ediwz5glih8657khcpzmd0';
const IMGUR_CLIENT_ID = '546c25a59c58ad7'; // client id Imgur

async function uploadImgur(buffer) {
    try {
        const axios = require('axios');
        const base64 = buffer.toString('base64');
        const res = await axios.post('https://api.imgur.com/3/image', { image: base64, type: 'base64' }, {
            headers: { Authorization: `Client-ID ${IMGUR_CLIENT_ID}` }
        });
        return res.data.data.link;
    } catch (err) {
        console.error('Erro ao fazer upload no Imgur:', err.message);
        return null;
    }
}

async function enviarParaMake(buffer, legenda) {
    try {
        const axios = require('axios');

        // tenta Imgur primeiro
        let imageUrl = await uploadImgur(buffer);

        // se falhar, envia base64 direto
        if (!imageUrl) {
            const base64 = buffer.toString('base64');
            imageUrl = `data:image/jpeg;base64,${base64}`;
            console.log('⚠️ Imgur falhou, enviando base64');
        }

        const res = await axios.post(MAKE_WEBHOOK, { caption: legenda, imageUrl });
        console.log('📤 Anúncio enviado para o Make! Status: ' + res.status);
    } catch (err) {
        console.error('Erro ao enviar para Make:', err.message);
    }
}


let ultimoQR = null;

// servidor web simples para exibir o QR Code via navegador
http.createServer(async (req, res) => {
    if (ultimoQR) {
        const qrImg = await QRCode.toDataURL(ultimoQR);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="text-align:center;padding:40px"><h2>Escaneie o QR Code com seu WhatsApp</h2><img src="${qrImg}"/><p>Atualize a página se o QR expirar</p></body></html>`);
    } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Bot ja conectado ou aguardando QR...</h2></body></html>');
    }
}).listen(process.env.PORT || 3000, () => {
    console.log('Servidor QR rodando na porta ' + (process.env.PORT || 3000));
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
            console.log('📢 Aviso matinal enviado!');
        } catch (err) {
            console.error('Erro ao enviar aviso matinal:', err.message);
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
            console.log('\n📱 Acesse a URL do servico no Render para escanear o QR Code!\n');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'open') {
            console.log('\n✅ Bot conectado!\n');
        }
        if (connection === 'close') {
            const reiniciar = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão encerrada. Reiniciando:', reiniciar);
            if (reiniciar) iniciarBot();
        }
    });

    let grupoOrigemId  = null;
    let grupoDestinoId = null;
    let grupoAvisoId   = null;

    async function buscarGrupos() {
        const grupos = await sock.groupFetchAllParticipating();
        for (const [id, info] of Object.entries(grupos)) {
            const nome = info.subject.toLowerCase();
            if (nome.includes(GRUPO_ORIGEM_NOME.toLowerCase()))       { grupoOrigemId  = id; console.log('✅ Grupo origem:  ' + info.subject); }
            if (nome === GRUPO_DESTINO_NOME.toLowerCase())               { grupoDestinoId = id; console.log('✅ Grupo destino: ' + info.subject); }
            if (nome === GRUPO_AVISO_NOME.toLowerCase())               { grupoAvisoId   = id; console.log('✅ Grupo aviso:   ' + info.subject); }
        }
        if (!grupoOrigemId)  console.warn('⚠️  Grupo de ORIGEM não encontrado: '  + GRUPO_ORIGEM_NOME);
        if (!grupoDestinoId) console.warn('⚠️  Grupo de DESTINO não encontrado: ' + GRUPO_DESTINO_NOME);
        if (!grupoAvisoId)   console.warn('⚠️  Grupo de AVISO não encontrado: '   + GRUPO_AVISO_NOME);

        if (grupoAvisoId) agendarAvisoMatinal(sock, grupoAvisoId);
    }

    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection === 'open') {
            setTimeout(buscarGrupos, 3000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid !== grupoOrigemId) continue;

                const texto = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || msg.message?.videoMessage?.caption
                    || '';

                const textoLower = texto.toLowerCase();
                const isVendido   = textoLower.includes('vendido');
                const isReservado = textoLower.includes('reservado');

                // mensagem de status (vendido/reservado) — reencaminha com destaque
                if (isVendido || isReservado) {
                    const status = isVendido ? '🚫 *VENDIDO*' : '⏳ *RESERVADO*';

                    // verifica se tem mídia na própria mensagem
                    const temMidia = msg.message?.imageMessage || msg.message?.videoMessage;

                    // verifica se é uma resposta a uma mensagem com foto (mensagem citada)
                    const msgCitada = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const temMidiaCitada = msgCitada?.imageMessage || msgCitada?.videoMessage;

                    if (temMidia) {
                        const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                        const tipoMidia = msg.message.imageMessage ? 'image' : 'video';
                        const mimetype  = msg.message[tipoMidia + 'Message']?.mimetype || 'image/jpeg';
                        const caption   = msg.message[tipoMidia + 'Message']?.caption || '';
                        await sock.sendMessage(grupoDestinoId, {
                            [tipoMidia]: buffer,
                            mimetype,
                            caption: `${status}\n${caption}`,
                        });
                    } else if (temMidiaCitada) {
                        // reencaminha a foto da mensagem original com o status
                        const tipoMidia = msgCitada.imageMessage ? 'image' : 'video';
                        const mimetype  = msgCitada[tipoMidia + 'Message']?.mimetype || 'image/jpeg';
                        const caption   = msgCitada[tipoMidia + 'Message']?.caption || '';
                        const buffer    = await downloadMediaMessage(
                            { message: msgCitada, key: msg.key },
                            'buffer', {},
                            { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                        );
                        await sock.sendMessage(grupoDestinoId, {
                            [tipoMidia]: buffer,
                            mimetype,
                            caption: `${status}\n${caption}`,
                        });
                    } else {
                        await sock.sendMessage(grupoDestinoId, { text: `${status}\n${texto}` });
                    }
                    console.log(`📢 Status reencaminhado: ${status}`);
                    continue;
                }

                const textoAjustado = ajustarPrecos(texto);
                const temMidia = msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage;

                if (temMidia) {
                    const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                    const tipoMidia = msg.message.imageMessage ? 'image' : msg.message.videoMessage ? 'video' : 'document';
                    const mimetype  = msg.message[tipoMidia + 'Message']?.mimetype || 'image/jpeg';

                    await sock.sendMessage(grupoDestinoId, {
                        [tipoMidia]: buffer,
                        mimetype,
                        caption: textoAjustado,
                    });

                    // enviar para Make para postar no Instagram
                    if (tipoMidia === 'image') {
                        const legendaIG = textoAjustado + '\n\n#repasse #repasseminasbrasil #carros #bh #veiculos #seminovo';
                        await enviarParaMake(buffer, legendaIG);
                    }
                } else if (textoAjustado.trim()) {
                    await sock.sendMessage(grupoDestinoId, { text: textoAjustado });
                }

                console.log(`📨 Reencaminhado: "${texto.slice(0, 60)}"`);
            } catch (err) {
                console.error('Erro:', err.message);
            }
        }
    });
}

iniciarBot();
