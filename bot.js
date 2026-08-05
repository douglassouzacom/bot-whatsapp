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

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
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

// URL base para servir imagens ao Make.com — precisa ser acessível externamente.
// Render.com define RENDER_EXTERNAL_URL automaticamente.
// Outros hosts: defina EXTERNAL_BASE_URL nas variáveis de ambiente.
const _BASE_URL_EXTERNA = (
    process.env.RENDER_EXTERNAL_URL ||
    process.env.EXTERNAL_BASE_URL ||
    null
);
if (!_BASE_URL_EXTERNA) {
    console.warn(
        '⚠️  RENDER_EXTERNAL_URL e EXTERNAL_BASE_URL não definidos — ' +
        'URLs de imagem usarão localhost e Make.com NÃO conseguirá baixar as imagens. ' +
        'Configure EXTERNAL_BASE_URL com a URL pública deste serviço.'
    );
}

function gerarUrlImagem(buffer) {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    imagensCache.set(token, { buffer, criadoEm: Date.now() });
    const baseUrl = (_BASE_URL_EXTERNA || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    return { token, url: `${baseUrl}/img/${token}.jpg` };
}

// Helpers de diagnóstico de disco (usados na rota /disco)
function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}

function tamanhoPasta(dir) {
    let bytes = 0, arquivos = 0;
    try {
        for (const nome of fs.readdirSync(dir)) {
            const p = path.join(dir, nome);
            let st;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.isDirectory()) {
                const sub = tamanhoPasta(p);
                bytes += sub.bytes; arquivos += sub.arquivos;
            } else {
                bytes += st.size; arquivos += 1;
            }
        }
    } catch {}
    return { bytes, arquivos };
}

// Limpa arquivos regeneráveis e volumosos da pasta de sessão do Baileys.
// Estes tipos se acumulam às dezenas de milhares e esgotam os inodes do disco → ENOSPC:
//   • lid-mapping-* → mapeamento LID↔número (o WhatsApp reenvia conforme as mensagens)
//   • pre-key-*     → chaves pré-geradas (o WhatsApp gera novas continuamente)
//   • device-list-* → cache de aparelhos por número (reconsultado quando preciso)
// Mantém os `manter` mais recentes de cada tipo. NUNCA toca em creds.json, session-*,
// sender-key-*, identity-key-* ou app-state-* — então NÃO desconecta o WhatsApp.
function limparSessaoAntiga(manter = 500) {
    const sessaoDir = path.join(DATA_DIR, 'sessao');
    const resultado = {};
    if (!fs.existsSync(sessaoDir)) return resultado;
    let nomes;
    try { nomes = fs.readdirSync(sessaoDir); } catch { return resultado; }
    for (const prefixo of ['lid-mapping-', 'pre-key-', 'device-list-']) {
        const doTipo = nomes.filter(n => n.startsWith(prefixo));
        const ordenadas = doTipo.map(n => {
            let mt = 0; try { mt = fs.statSync(path.join(sessaoDir, n)).mtimeMs; } catch {}
            return { n, mt };
        }).sort((a, b) => b.mt - a.mt); // mais recentes primeiro
        let apagados = 0;
        for (const { n } of ordenadas.slice(manter)) {
            try { fs.unlinkSync(path.join(sessaoDir, n)); apagados++; } catch {}
        }
        resultado[prefixo] = { total: doTipo.length, mantidas: Math.min(manter, doTipo.length), apagados };
    }
    return resultado;
}

// A rotina de faxina (boot + preventiva por limiar + piso de 6h + alerta) fica logo
// abaixo, depois que DATA_DIR é definido — ver "PROTEÇÃO CONTRA DISCO ENTUPIDO".

// =============================================
//  MAPA DE POSTS DO INSTAGRAM (para marcar VENDIDO)
// =============================================
// Diretório persistente: DATA_DIR aponta para o disco do Render; fallback = pasta do projeto
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// =============================================
//  PROTEÇÃO CONTRA DISCO ENTUPIDO (inodes) — defesa em camadas
// =============================================
// O disco do Render tem teto de ~65.536 arquivos (inodes). A pasta sessao/ do
// Baileys acumula lid-mapping/pre-key/device-list às dezenas de milhares e, ao
// estourar, o bot para de gravar (ENOSPC) e trava TUDO (nem GRUPO 8, nem IG).
// Não confiar num único timer — camadas independentes:
//   1) Faxina no BOOT: roda toda vez que o processo sobe. Cobre o pior caso —
//      reinícios frequentes (justamente quando o disco enche), quando o timer de
//      6h reiniciava do zero e nunca chegava a disparar.
//   2) Verificação a cada 30 min: conta os arquivos (barato) e, se passar do
//      limiar, faxina na hora — pega crescimento rápido bem antes do teto.
//   3) Faxina de piso a cada 6h: garante limpeza mesmo com crescimento lento.
//   4) Alerta no WhatsApp se, mesmo após faxina, a pasta seguir crítica (sinal de
//      que algo não-limpável cresceu — merece olho humano).
const SESSAO_DIR    = path.join(DATA_DIR, 'sessao');
const LIMIAR_FAXINA = parseInt(process.env.LIMIAR_FAXINA, 10) || 20000; // dispara faxina preventiva
const LIMIAR_ALERTA = parseInt(process.env.LIMIAR_ALERTA, 10) || 45000; // avisa no WhatsApp (perigo)
let ultimoAlertaDisco = 0;

function contarArquivosSessao() {
    try { return fs.readdirSync(SESSAO_DIR).length; } catch { return 0; }
}

function faxinaSessao(motivo) {
    const antes = contarArquivosSessao();
    const r = limparSessaoAntiga(500);
    const apagados = Object.values(r).reduce((s, x) => s + (x.apagados || 0), 0);
    const depois = contarArquivosSessao();
    if (apagados > 0) console.log(`🧹 sessao/ (${motivo}): ${apagados} arquivos removidos (${antes}→${depois})`, r);
    if (depois >= LIMIAR_ALERTA) alertarDiscoCritico(depois); // defesa em profundidade
    return { antes, depois, apagados };
}

async function alertarDiscoCritico(qtd) {
    if (!sockAtual || !sockAtual.user) return; // sem socket (ex.: boot) — só limpa, não avisa
    const agora = Date.now();
    if (agora - ultimoAlertaDisco < 6 * 60 * 60 * 1000) return; // no máx. 1 aviso a cada 6h
    ultimoAlertaDisco = agora;
    try {
        await enviarAlerta(
            `🚨 *ALERTA — disco do bot enchendo*\n\n` +
            `A pasta da sessão está com *${qtd}* arquivos mesmo após a limpeza automática ` +
            `(teto ~65.000). Se bater no teto, o bot para de postar (grupo e Instagram).\n\n` +
            `Confira em /disco e /sessao-info. Limpeza manual, se precisar:\n` +
            `/sessao-info?limpar=sessao&confirmar=sim`);
        registrarSucesso('Disco/Alerta', `Aviso de disco enviado (${qtd} arquivos)`);
    } catch (err) {
        registrarErro('Disco/Alerta', err.message);
    }
}

// Camada 1 — faxina no boot (antes de conectar; unlink libera inode mesmo com disco cheio).
faxinaSessao('boot');
// Camada 2 — verificação preventiva por limiar a cada 30 min.
setInterval(() => {
    const total = contarArquivosSessao();
    if (total > LIMIAR_FAXINA) faxinaSessao(`preventiva ${total}>${LIMIAR_FAXINA}`);
}, 30 * 60 * 1000);
// Camada 3 — faxina de piso a cada 6h.
setInterval(() => faxinaSessao('rotina 6h'), 6 * 60 * 60 * 1000);

// Armazena: stanzaId da mensagem WhatsApp → instagramPostId
const INSTAGRAM_POSTS_FILE = path.join(DATA_DIR, 'instagram_posts.json');

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

// =============================================
//  MAPA DOS ANÚNCIOS REENCAMINHADOS AO GRUPO 8 (para marcar VENDIDO em cima)
// =============================================
// Armazena: stanzaId do anúncio original (grupo Ronei) → referência da mensagem
// que o bot postou no GRUPO 8. Permite responder ("marcar em cima") o anúncio
// do veículo sem reenviar a foto novamente.
const POSTS_GRUPO8_FILE = path.join(DATA_DIR, 'posts_grupo8.json');

function carregarPostsGrupo8() {
    try {
        if (fs.existsSync(POSTS_GRUPO8_FILE)) {
            const dados = JSON.parse(fs.readFileSync(POSTS_GRUPO8_FILE, 'utf8'));
            const mapa = new Map(Object.entries(dados));
            console.log(`📂 posts_grupo8.json carregado: ${mapa.size} entradas`);
            return mapa;
        }
    } catch (err) {
        console.error('Erro ao carregar posts_grupo8.json:', err.message);
    }
    return new Map();
}

function salvarPostsGrupo8() {
    try {
        fs.writeFileSync(POSTS_GRUPO8_FILE, JSON.stringify(Object.fromEntries(postsGrupo8), null, 2));
    } catch (err) {
        console.error('Erro ao salvar posts_grupo8.json:', err.message);
    }
}

const postsGrupo8 = carregarPostsGrupo8(); // stanzaId original → { quoted, hora }

// =============================================
//  PERSISTÊNCIA DOS IDs DE GRUPOS
// =============================================
const GRUPOS_FILE = path.join(DATA_DIR, 'grupos.json');

function carregarGrupos() {
    try {
        if (fs.existsSync(GRUPOS_FILE)) {
            return JSON.parse(fs.readFileSync(GRUPOS_FILE, 'utf8'));
        }
    } catch {}
    return {};
}

function salvarGrupos(ids) {
    try {
        fs.writeFileSync(GRUPOS_FILE, JSON.stringify(ids, null, 2));
    } catch (err) {
        console.error('Erro ao salvar grupos.json:', err.message);
    }
}

let _cachedGrupos = carregarGrupos();
if (_cachedGrupos.origemId) {
    console.log(`📂 grupos.json carregado: IDs de grupos restaurados do disco (conecta sem aguardar busca)`);
}

// Guarda a referência (key + legenda) do anúncio postado no GRUPO 8.
// Só salva o texto (sem a imagem) para serializar com segurança e sobreviver a restart.
function registrarPostGrupo8(stanzaIdOriginal, enviada, legenda) {
    if (!stanzaIdOriginal || !enviada?.key) return;
    postsGrupo8.set(stanzaIdOriginal, {
        quoted: { key: enviada.key, message: { conversation: (legenda || '🚗').slice(0, 700) } },
        hora: new Date().toISOString(),
    });
    salvarPostsGrupo8();
}

// Limpa postsGrupo8 com mais de 7 dias (carro já vendido não precisa ficar em memória)
setInterval(() => {
    const limite = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let removidos = 0;
    for (const [id, dado] of postsGrupo8.entries()) {
        if (new Date(dado.hora).getTime() < limite) {
            postsGrupo8.delete(id);
            removidos++;
        }
    }
    if (removidos > 0) {
        console.log(`🧹 postsGrupo8: ${removidos} entradas antigas removidas`);
        salvarPostsGrupo8();
    }
}, 24 * 60 * 60 * 1000);

// Persiste e restaura filaRetry para dar visibilidade de retries perdidos em restart
const FILA_RETRY_FILE = path.join(DATA_DIR, 'fila_retry.json');

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

if (!MAKE_WEBHOOK) {
    console.warn('⚠️  MAKE_WEBHOOK não definido — posts no Instagram NÃO funcionarão. Configure nas variáveis de ambiente.');
}

// Alerta de falha do Instagram:
// O Make.com chama /webhook-instagram-id com o postId quando publica com sucesso.
// Se esse retorno NAO chegar dentro do tempo abaixo, a postagem falhou (cenario
// desligado, token do Instagram expirado, etc.) e o bot avisa no WhatsApp.
const CONFIRMACAO_TIMEOUT_MS = 5 * 60 * 1000;   // espera 5 min pela confirmacao
const ALERTA_COOLDOWN_MS     = 30 * 60 * 1000;  // no maximo 1 alerta a cada 30 min
// So alerta sobre carros ainda "recentes". Se o bot ficou fora do ar por dias e
// volta com um monte de posts nao confirmados, nao adianta gritar sobre carro velho.
const JANELA_ALERTA_MAX_MS   = 6 * 60 * 60 * 1000; // 6h
// Numero (so digitos, com DDI) que recebe os alertas. Vazio = manda pro proprio
// numero do bot (aparece como "mensagem para voce mesmo" no WhatsApp).
const WHATSAPP_ALERTA        = (process.env.WHATSAPP_ALERTA || '').replace(/\D/g, '');
let   ultimoAlertaInstagram  = 0;

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

// Palavras que indicam REDUÇÃO DE PREÇO — NÃO postar no Instagram.
// ATENÇÃO: NÃO adicionar 'desconto' aqui. Vendedores usam "aceita desconto"
// como argumento de venda (negociação), não como aviso de preço reduzido.
// Adicionar 'desconto' bloqueia anúncios normais e impede postagem no Instagram.
// Só incluir palavras que indiquem que o preço EFETIVAMENTE BAIXOU em relação ao original.
const PALAVRAS_ABAIXOU = ['abaixou', 'abaixei', 'baixou', 'baixei', 'baixamos', 'reduzi', 'reduzido', 'nova oferta', 'novo valor', 'preço novo', 'valor novo'];

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
            registrarPostAds(stanzaId, legenda); // aprendizado: marca o carro como postado
            console.log(`🔖 Aguardando postId do Make.com para msg ${stanzaId}`);

            // Vigia a confirmacao: se o Make.com nao devolver o postId no prazo,
            // a publicacao falhou silenciosamente -> avisa no WhatsApp.
            // (A rede principal e o verificador periodico abaixo, que sobrevive a
            //  reinicio; este setTimeout so adianta o aviso no caminho feliz.)
            setTimeout(() => {
                const d = instagramPosts.get(stanzaId);
                if (d && !d.postId && !d.alertado) {
                    d.alertado = true;
                    salvarInstagramPosts();
                    console.warn(`⚠️ Instagram NAO confirmou msg ${stanzaId} em ${CONFIRMACAO_TIMEOUT_MS / 60000}min — alertando`);
                    alertarFalhaInstagram(legenda);
                }
            }, CONFIRMACAO_TIMEOUT_MS);
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

        if (!dado || !dado.postId) {
            console.log(
                '⚠️ VENDIDO: ' +
                (!dado ? 'mensagem não mapeada (post feito antes desta sessão).'
                       : 'postId ainda não chegou do Make.com — callback /webhook-instagram-id pendente.')
            );
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

// Resolve o numero de alerta para o JID que o WhatsApp REALMENTE reconhece.
// Corrige a pegadinha do "nono digito" no Brasil: onWhatsApp devolve o JID
// canonico (com ou sem o 9), evitando a mensagem que "envia" mas nunca chega.
// Cacheia o resultado por numero pra nao consultar a cada envio.
let _destinoAlertaCache = null;
async function resolverDestinoAlerta() {
    if (!sockAtual || !sockAtual.user) return { erro: 'sem-socket' };
    const numeroBot = sockAtual.user.id.split(':')[0].split('@')[0];
    const numero = (WHATSAPP_ALERTA || numeroBot).replace(/\D/g, '');
    if (!numero) return { erro: 'sem-numero' };
    if (_destinoAlertaCache && _destinoAlertaCache.numero === numero) return _destinoAlertaCache;
    const d = { numero, jid: `${numero}@s.whatsapp.net`, exists: null, usouProprioBot: !WHATSAPP_ALERTA };
    try {
        const r = await sockAtual.onWhatsApp(numero);
        if (r && r[0]) {
            d.exists = !!r[0].exists;
            if (r[0].exists && r[0].jid) d.jid = r[0].jid; // JID canonico (resolve o 9)
        }
    } catch (e) { d.erroConsulta = e.message; }
    _destinoAlertaCache = d;
    return d;
}
// Envia um texto pro WhatsApp de alerta, resolvendo o JID certo antes.
// Lanca erro com motivo claro se nao der (pra rota de teste reportar).
async function enviarAlerta(texto) {
    const d = await resolverDestinoAlerta();
    if (d.erro === 'sem-socket')  throw new Error('bot sem conexão com o WhatsApp');
    if (d.erro === 'sem-numero')  throw new Error('WHATSAPP_ALERTA vazio');
    if (d.exists === false)       throw new Error(`o número ${d.numero} não tem WhatsApp`);
    await sockAtual.sendMessage(d.jid, { text: texto });
    return d;
}

// Avisa o Douglas no WhatsApp quando o Instagram NAO confirma a publicacao.
// Com cooldown para nao floodar quando varios carros falham em sequencia.
async function alertarFalhaInstagram(legenda) {
    const agora = Date.now();
    if (agora - ultimoAlertaInstagram < ALERTA_COOLDOWN_MS) return; // ja alertou ha pouco
    ultimoAlertaInstagram = agora;

    try {
        if (!sockAtual || !sockAtual.user) {
            registrarErro('Instagram/Alerta', 'Sem socket ativo para enviar alerta');
            return;
        }
        const texto =
            `🚨 *ALERTA — Instagram não publicou*\n\n` +
            `Um carro foi enviado pro Make.com mas o Instagram NÃO confirmou a publicação em ` +
            `${CONFIRMACAO_TIMEOUT_MS / 60000} min.\n\n` +
            `Provável causa: cenário do Make.com desligado ou conexão do Instagram expirada ` +
            `(precisa reconectar o Instagram no Make.com).\n\n` +
            `🚗 Último carro afetado:\n${legenda.replace(/\n+/g, ' ').slice(0, 90)}…`;

        await enviarAlerta(texto);
        registrarSucesso('Instagram/Alerta', 'Falha de confirmação avisada no WhatsApp');
    } catch (err) {
        registrarErro('Instagram/Alerta', `Não conseguiu avisar: ${err.message}`);
    }
}

// Rede de seguranca robusta a reinicio: o setTimeout de vigilancia vive so na
// memoria e se perde quando o bot reconecta (acontece varias vezes por dia). Este
// verificador rele o disco e alerta sobre qualquer carro que passou do prazo sem o
// postId do Make.com — assim uma quebra do Instagram nunca passa batida por dias.
function verificarInstagramPendente() {
    const agora = Date.now();
    let mudou = false;
    for (const [, d] of instagramPosts) {
        if (d.postId || d.alertado) continue;
        const idade = agora - new Date(d.hora).getTime();
        if (idade <= CONFIRMACAO_TIMEOUT_MS) continue;   // ainda dentro do prazo, espera
        d.alertado = true;                               // marca pra nao repetir o aviso
        mudou = true;
        if (idade <= JANELA_ALERTA_MAX_MS) alertarFalhaInstagram(d.caption || '(sem legenda)');
    }
    if (mudou) salvarInstagramPosts();
}
setInterval(verificarInstagramPendente, CONFIRMACAO_TIMEOUT_MS);

// ============================================================================
//  IMPULSIONADOR DE ADS — 1x/semana manda no Zap os carros pra impulsionar.
//  (mesmo cerebro do projeto impulsionador-repasse, rodando aqui 24h). Nao gasta
//  nada: so sugere os carros + legendas dentro das regras do Meta pra o Douglas.
// ============================================================================
const ADS_DIA_SEMANA  = 1;   // 0=dom, 1=seg
const ADS_HORA        = 9;   // 9h (horario de BH)
const ADS_TOP_N       = 3;
const ADS_JANELA_DIAS = 10;
const ARQ_ULTIMO_ADS  = path.join(DATA_DIR, 'ultimo_pacote_ads.txt');

function adsParseCarro(caption = '') {
    const linhas = caption.split('\n').map(l => l.trim()).filter(Boolean);
    let modelo = '';
    const iCab = linhas.findIndex(l => /minas brasil repasse/i.test(l));
    for (let i = iCab + 1; i < linhas.length; i++) {
        if (!/^[\d.]+$/.test(linhas[i]) && !/mil km|^\d{4}$/i.test(linhas[i])) { modelo = linhas[i]; break; }
    }
    const ano    = (caption.match(/\b(20\d{2}|19\d{2})\b/) || [])[0] || '';
    const mVal   = caption.match(/valor:?\s*R?\$?\s*([\d.]+)/i);
    const precoN = mVal ? Number(mVal[1].replace(/\./g, '')) : 0;
    modelo = modelo.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    return { modelo, ano, precoN, preco: precoN ? precoN.toLocaleString('pt-BR') : '' };
}
const adsFaixa = p => p < 60000 ? 'popular' : p < 120000 ? 'medio' : 'premium';
const adsModeloBase = m => (String(m).split(' ')[0] || '').toLowerCase();

// ── APRENDIZADO POR VENDA ────────────────────────────────────────────────
// O agente aprende com o que ACONTECE de verdade: registra cada carro postado
// e, quando e marcado VENDIDO, quanto tempo levou pra vender. Tipo que vende
// rapido = mais procura => sobe na fila do que vale impulsionar. So usa dado
// que o bot ja tem (sem API do Meta). Degrada gracioso: sem historico (< 3
// vendas), nao influencia nada e o pacote segue por recencia + variedade.
const HISTORICO_ADS_FILE = path.join(DATA_DIR, 'historico_ads.json');
function carregarHistoricoAds() {
    try { if (fs.existsSync(HISTORICO_ADS_FILE)) return JSON.parse(fs.readFileSync(HISTORICO_ADS_FILE, 'utf8')); }
    catch (e) { console.error('historico_ads load:', e.message); }
    return [];
}
let historicoAds = carregarHistoricoAds();
function salvarHistoricoAds() {
    try { fs.writeFileSync(HISTORICO_ADS_FILE, JSON.stringify(historicoAds.slice(-500), null, 2)); }
    catch (e) { console.error('historico_ads save:', e.message); }
}
function registrarPostAds(stanzaId, caption) {
    try {
        const c = adsParseCarro(caption || '');
        if (!c.modelo || !c.precoN) return;
        historicoAds.push({
            stanzaId, modelo: c.modelo, modeloBase: adsModeloBase(c.modelo),
            ano: c.ano, precoN: c.precoN, faixa: adsFaixa(c.precoN),
            postadoEm: new Date().toISOString(), vendidoEm: null, diasAteVenda: null,
        });
        salvarHistoricoAds();
    } catch (e) { console.error('registrarPostAds:', e.message); }
}
function registrarVendaAds(stanzaId) {
    try {
        const reg = [...historicoAds].reverse().find(r => r.stanzaId === stanzaId && !r.vendidoEm);
        if (!reg) return;
        reg.vendidoEm = new Date().toISOString();
        const dias = (Date.now() - new Date(reg.postadoEm).getTime()) / 864e5;
        reg.diasAteVenda = Math.max(0, Math.round(dias * 10) / 10);
        salvarHistoricoAds();
    } catch (e) { console.error('registrarVendaAds:', e.message); }
}
// Agrega o historico em placar por faixa e por modelo (so vendas confirmadas).
function adsAprendizado() {
    const vendidos = historicoAds.filter(r => r.vendidoEm && typeof r.diasAteVenda === 'number');
    const agrupar = chave => {
        const g = {};
        for (const r of vendidos) {
            const k = r[chave]; if (!k) continue;
            g[k] = g[k] || { vendas: 0, somaDias: 0 };
            g[k].vendas++; g[k].somaDias += r.diasAteVenda;
        }
        for (const k in g) g[k].mediaDias = Math.round(g[k].somaDias / g[k].vendas * 10) / 10;
        return g;
    };
    return { amostra: vendidos.length, porFaixa: agrupar('faixa'), porModelo: agrupar('modeloBase') };
}
// Nota de um carro: quanto mais rapido o tipo dele vende, maior o score.
// Modelo pesa mais que faixa; volume de vendas da confianca (log).
function adsScore(carro, ap) {
    ap = ap || adsAprendizado();
    if (ap.amostra < 3) return 0;                        // poucos dados: nao mexe
    const gf = ap.porFaixa[adsFaixa(carro.precoN)];
    const gm = ap.porModelo[adsModeloBase(carro.modelo)];
    let s = 0;
    if (gf) s += Math.max(0, 15 - gf.mediaDias) * (1 + Math.log2(1 + gf.vendas));
    if (gm) s += Math.max(0, 15 - gm.mediaDias) * (1 + Math.log2(1 + gm.vendas)) * 1.5;
    return Math.round(s * 10) / 10;
}
// Frase curta explicando por que priorizou (vazia se ainda nao ha dados).
function adsPorque(carro, ap) {
    ap = ap || adsAprendizado();
    if (ap.amostra < 3) return '';
    const gm = ap.porModelo[adsModeloBase(carro.modelo)];
    const gf = ap.porFaixa[adsFaixa(carro.precoN)];
    if (gm && gm.vendas >= 2 && gm.mediaDias <= 7)
        return `🔥 ${carro.modelo.split(' ')[0]} vem vendendo rápido (${gm.vendas} em ~${gm.mediaDias}d)`;
    if (gf && gf.vendas >= 3 && gf.mediaDias <= 7)
        return `🔥 faixa ${adsFaixa(carro.precoN)} está saindo rápido (${gf.vendas} em ~${gf.mediaDias}d)`;
    return '';
}

const ADS_TEMPLATES = [
    c => `🚗 Repasse da semana em BH — ${c.modelo}${c.ano ? ' ' + c.ano : ''}${c.preco ? ', R$ ' + c.preco : ''}.\nCarro conferido, pagamento à vista via PIX/TED.\nToda semana entram novos: siga o @repasseminasbrasil e veja antes de todo mundo 👇`,
    c => `${c.modelo}${c.ano ? ' ' + c.ano : ''} com preço de repasse 🚗\nAbaixo da tabela, à vista, carro conferido.\nEsse e outros estão no nosso perfil — segue o @repasseminasbrasil.`,
    c => `Tá de olho em ${c.modelo} em Belo Horizonte? 👀\n${c.preco ? 'R$ ' + c.preco + ', à vista.\n' : 'À vista.\n'}Todo dia entram repasses novos: segue pra ver em primeira mão 🚗`,
];
function adsSelecionar(itens, n) {
    const out = [], fx = new Set(), md = new Set();
    const mb = it => (it.carro.modelo.split(' ')[0] || '').toLowerCase();
    for (const it of itens) { if (out.length >= n) break; const f = adsFaixa(it.carro.precoN), m = mb(it); if (!fx.has(f) && !md.has(m)) { out.push(it); fx.add(f); md.add(m); } }
    for (const it of itens) { if (out.length >= n) break; const m = mb(it); if (!out.includes(it) && !md.has(m)) { out.push(it); md.add(m); } }
    for (const it of itens) { if (out.length >= n) break; if (!out.includes(it)) out.push(it); }
    return out;
}
function adsMontarTexto() {
    const corte = Date.now() - ADS_JANELA_DIAS * 864e5;
    const ap = adsAprendizado();
    const itens = [...instagramPosts.values()]
        .filter(d => d && d.caption)
        .map(d => ({ hora: d.hora, carro: adsParseCarro(d.caption) }))
        .filter(it => it.carro.modelo && it.carro.precoN > 0)
        .filter(it => !it.hora || new Date(it.hora).getTime() >= corte)
        .sort((a, b) => {
            const sa = adsScore(a.carro, ap), sb = adsScore(b.carro, ap);
            if (sb !== sa) return sb - sa;                        // aprendizado manda
            return new Date(b.hora || 0) - new Date(a.hora || 0); // recencia desempata
        });
    const pacote = adsSelecionar(itens, ADS_TOP_N);
    if (!pacote.length) return null;
    let txt = `🚀 *IMPULSIONAR ESTA SEMANA*\n${pacote.length} carros pra trazer gente nova pro perfil. Impulsione o post no Instagram (objetivo "mais visitas ao perfil", R$ 15–25/dia) e cole a legenda abaixo.\n`;
    if (ap.amostra >= 3) txt += `_Escolha baseada em ${ap.amostra} vendas: priorizei o que vende mais rápido._\n`;
    pacote.forEach((it, i) => {
        const c = it.carro;
        const porque = adsPorque(c, ap);
        txt += `\n*${i + 1}. ${c.modelo} ${c.ano}* — R$ ${c.preco} [${adsFaixa(c.precoN)}]\n`;
        if (porque) txt += `${porque}\n`;
        txt += `${ADS_TEMPLATES[i % ADS_TEMPLATES.length](c)}\n`;
    });
    return txt;
}
async function adsEnviarPacote() {
    const texto = adsMontarTexto();
    if (!texto) return;
    try {
        await enviarAlerta(texto);
        registrarSucesso('Ads', 'Pacote semanal de impulsionamento enviado no WhatsApp');
    } catch (err) { registrarErro('Ads', err.message); }
}
// Agenda 1x/semana (segunda 9h BH). Verifica a cada 30min + dedup por arquivo,
// pra sobreviver a reinicio sem duplicar nem perder. Fuso fixo em Sao Paulo.
setInterval(() => {
    const spStr = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour12: false });
    const sp = new Date(spStr);
    if (sp.getDay() !== ADS_DIA_SEMANA || sp.getHours() < ADS_HORA) return;
    const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    try { if (fs.existsSync(ARQ_ULTIMO_ADS) && fs.readFileSync(ARQ_ULTIMO_ADS, 'utf8').trim() === hoje) return; } catch {}
    try { fs.writeFileSync(ARQ_ULTIMO_ADS, hoje); } catch {}
    adsEnviarPacote();
}, 30 * 60 * 1000);

// Último post do Instagram (para /vendido-teste) — restaurado do disco se disponível
let ultimoPostInstagram = restaurarUltimoPost();

// Referência ao socket ativo — necessária para fechar corretamente no /reset-sessao
let sockAtual = null;

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
        : stats.erros.map(e => `<li><b>${escapeHtml(e.hora)}</b> [${escapeHtml(e.contexto)}] ${escapeHtml(e.mensagem)}</li>`).join('');

    const filaHtml = stats.filaRetry.length === 0
        ? '<li style="color:#00ff88">Fila vazia ✅</li>'
        : stats.filaRetry.map(f => `<li>${escapeHtml(f.tipo)} — tentativa ${f.tentativas}</li>`).join('');

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
      <li>💬 Última mensagem: ${escapeHtml(stats.ultimaMensagem || 'nenhuma ainda')}</li>
      <li>📸 Último Instagram: ${escapeHtml(stats.ultimoInstagram || 'nenhum ainda')}</li>
      <li>🔔 Alarme aponta para: ${WHATSAPP_ALERTA
          ? '<b style="color:#00ff88">' + escapeHtml(WHATSAPP_ALERTA) + '</b>'
          : '<b style="color:#ffaa00">⚠️ próprio bot — configure WHATSAPP_ALERTA no Render</b>'} &nbsp;<a href="/testar-alerta" style="color:#00d4ff">testar</a></li>
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
            const sessaoDir = path.join(DATA_DIR, 'sessao');
            if (fs.existsSync(sessaoDir)) {
                fs.readdirSync(sessaoDir).forEach(f => fs.unlinkSync(path.join(sessaoDir, f)));
            }
            if (sockAtual) { try { sockAtual.end(new Error('reset')); } catch {} sockAtual = null; }
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
                    const dado = instagramPosts.get(stanzaId) || { caption: '', hora: new Date().toISOString() };
                    dado.postId = postId;
                    if (!dado.hora) dado.hora = new Date().toISOString();
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

    // Rota de teste do alarme: /testar-alerta — dispara um aviso na hora e mostra
    // pra qual numero ele foi, pra confirmar que o alarme aponta pro WhatsApp certo.
    if (req.url === '/testar-alerta') {
        (async () => {
            try {
                if (!sockAtual || !sockAtual.user) {
                    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: false, erro: 'Bot sem conexão com o WhatsApp agora — tente de novo em instantes' }));
                    return;
                }
                const d = await enviarAlerta('🧪 *Teste de alarme do bot Repasse*\n\nSe você recebeu esta mensagem, o alarme do Instagram está apontado para este WhatsApp. Pode ignorar. ✅');
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    ok: true,
                    numeroConfigurado: d.numero,
                    jidUsado: d.jid,
                    jidDiferenteDoNumeroCru: (d.numero + '@s.whatsapp.net' !== d.jid),
                    numeroTemWhatsapp: d.exists,
                    whatsappAlertaConfigurado: !!WHATSAPP_ALERTA,
                    aviso: WHATSAPP_ALERTA
                        ? 'Alarme configurado. Confira se a mensagem chegou nesse número.'
                        : 'ATENÇÃO: WHATSAPP_ALERTA está vazio → o alarme vai pro PRÓPRIO número do bot (você não vê). Configure WHATSAPP_ALERTA no Render com o seu número (DDI+DDD+número, só dígitos, ex: 5531999998888).',
                }, null, 2));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, erro: err.message }));
            }
        })();
        return;
    }

    // Rota de imagens: /img/:token ou /img/:token.jpg
    if (req.url && req.url.startsWith('/img/')) {
        const token = req.url.slice(5).replace(/\.jpg$/i, '');
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

    // Carros recentes (fonte do agente Impulsionador) — só leitura, sem nada sensível.
    // Retorna as legendas dos carros ja postados, mais recentes primeiro.
    if (req.url === '/carros') {
        const carros = [...instagramPosts.values()]
            .filter(d => d && d.caption)
            .sort((a, b) => new Date(b.hora || 0) - new Date(a.hora || 0))
            .map(d => ({ caption: d.caption, hora: d.hora || null, postId: d.postId || null }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ total: carros.length, carros }, null, 2));
        return;
    }

    // Pacote de ads da semana (ver/testar na hora): /pacote-ads
    if (req.url === '/pacote-ads') {
        const texto = adsMontarTexto();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(texto || 'Nenhum carro com preço válido na janela ainda.');
        return;
    }

    // Placar do aprendizado (o que o agente aprendeu com as vendas): /aprendizado
    if (req.url === '/aprendizado') {
        const ap = adsAprendizado();
        const totalRegistrados = historicoAds.length;
        const aguardando = historicoAds.filter(r => !r.vendidoEm).length;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        if (ap.amostra === 0) {
            res.end(
                `Ainda não há vendas registradas pra aprender.\n` +
                `Carros postados sendo acompanhados: ${totalRegistrados}.\n` +
                `Assim que os primeiros forem marcados VENDIDO, o placar aparece aqui.`);
            return;
        }
        const linha = (nome, g) => `  ${nome}: ${g.vendas} venda(s), média ${g.mediaDias} dia(s)`;
        const ordena = obj => Object.entries(obj).sort((a, b) => a[1].mediaDias - b[1].mediaDias);
        let txt = `📊 APRENDIZADO — o que o agente aprendeu com ${ap.amostra} venda(s)\n`;
        txt += `(quanto MENOS dias pra vender, mais procurado → mais prioridade no impulsionamento)\n\n`;
        txt += `Por faixa de preço (mais rápido primeiro):\n`;
        txt += (ordena(ap.porFaixa).map(([k, g]) => linha(k, g)).join('\n') || '  —');
        txt += `\n\nPor modelo (mais rápido primeiro):\n`;
        txt += (ordena(ap.porModelo).map(([k, g]) => linha(k, g)).join('\n') || '  —');
        txt += `\n\nCarros postados aguardando venda: ${aguardando}`;
        res.end(txt);
        return;
    }

    // Dispara o pacote de ads AGORA no WhatsApp (sem esperar segunda): /testar-pacote
    if (req.url === '/testar-pacote') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        const texto = adsMontarTexto();
        if (!texto) {
            res.end('Nenhum carro com preço válido na janela ainda — nada pra enviar.');
            return;
        }
        try {
            const d = await enviarAlerta(texto);
            registrarSucesso('Ads', 'Pacote de teste enviado no WhatsApp (/testar-pacote)');
            res.end(
                `Pacote enviado.\n` +
                `Número configurado: ${d.numero}\n` +
                `JID que o WhatsApp reconhece: ${d.jid}\n` +
                (d.numero + '@s.whatsapp.net' !== d.jid
                    ? `⚠️ O JID é DIFERENTE do número cru — era esse o motivo de não chegar antes. Agora vai pro JID certo.\n`
                    : `JID igual ao número (sem pegadinha do 9).\n`) +
                (d.exists === false ? `⚠️ ATENÇÃO: esse número não consta no WhatsApp — confira o WHATSAPP_ALERTA no Render.\n` : ``) +
                `Confere o seu Zap agora.`);
        } catch (err) {
            res.end('Falhou ao enviar: ' + err.message);
        }
        return;
    }

    // Health check: /health — retorna JSON para monitoramento externo e keep-alive
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: stats.status,
            uptime: Math.floor((Date.now() - new Date(stats.iniciadoEm)) / 1000),
            reconexoes: stats.reconexoes,
            mensagensRecebidas: stats.mensagensRecebidas,
            mensagensReencaminhadas: stats.mensagensReencaminhadas,
            instagramPostado: stats.instagramPostado,
            instagramFalha: stats.instagramFalha,
            filaRetry: stats.filaRetry.length,
        }));
        return;
    }

    // Diagnóstico de disco: /disco — mostra o que ocupa espaço em DATA_DIR (só leitura)
    if (req.url === '/disco') {
        const itens = [];
        try {
            for (const nome of fs.readdirSync(DATA_DIR)) {
                const p = path.join(DATA_DIR, nome);
                let st;
                try { st = fs.statSync(p); } catch { continue; }
                if (st.isDirectory()) {
                    const t = tamanhoPasta(p);
                    itens.push({ nome: nome + '/', tamanho: fmtBytes(t.bytes), bytes: t.bytes, arquivos: t.arquivos });
                } else {
                    itens.push({ nome, tamanho: fmtBytes(st.size), bytes: st.size, arquivos: 1 });
                }
            }
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ erro: err.message, dataDir: DATA_DIR }));
            return;
        }
        itens.sort((a, b) => b.bytes - a.bytes);
        const totalBytes = itens.reduce((s, i) => s + i.bytes, 0);

        let disco;
        try {
            const s = fs.statfsSync(DATA_DIR);
            const total = s.blocks * s.bsize;
            const livre = s.bavail * s.bsize;
            disco = {
                total: fmtBytes(total),
                usado: fmtBytes(total - livre),
                livre: fmtBytes(livre),
                percentualUsado: ((1 - livre / total) * 100).toFixed(1) + '%',
            };
        } catch (e) {
            disco = { erro: e.message };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dataDir: DATA_DIR, disco, totalDataDir: fmtBytes(totalBytes), itens }, null, 2));
        return;
    }

    // Sessão do WhatsApp: /sessao-info — composição dos arquivos e limpeza de pre-keys.
    // Limpeza só roda com ?limpar=prekeys&confirmar=sim (evita acionamento acidental).
    if (req.url && req.url.startsWith('/sessao-info')) {
        const u = new URL(req.url, 'http://x');
        const sessaoDir = path.join(DATA_DIR, 'sessao');
        const out = { sessaoDir, existe: fs.existsSync(sessaoDir) };
        if (out.existe) {
            let nomes = [];
            try { nomes = fs.readdirSync(sessaoDir); } catch {}
            const comp = {};
            for (const n of nomes) {
                const chave = n === 'creds.json'
                    ? 'creds'
                    : (n.match(/^(pre-key|session|sender-key|app-state-sync-key|app-state-sync-version)/)?.[1] || 'outros');
                comp[chave] = (comp[chave] || 0) + 1;
            }
            out.totalArquivos = nomes.length;
            out.composicao = comp;
            // Agrupa os arquivos "outros" pelo prefixo (parte antes do 1º dígito) para
            // descobrir o tipo real que está inflando a pasta.
            const prefixosOutros = {};
            for (const n of nomes) {
                const eOutro = n !== 'creds.json'
                    && !/^(pre-key|session|sender-key|app-state-sync-key|app-state-sync-version)/.test(n);
                if (eOutro) {
                    let pref = n.split(/\d/)[0];
                    if (!pref) pref = '(começa-com-dígito)';
                    prefixosOutros[pref] = (prefixosOutros[pref] || 0) + 1;
                }
            }
            out.prefixosOutros = prefixosOutros;
            if (u.searchParams.get('limpar') === 'sessao' && u.searchParams.get('confirmar') === 'sim') {
                const manter = parseInt(u.searchParams.get('manter') || '500', 10);
                out.limpeza = limparSessaoAntiga(manter);
                const totalApagado = Object.values(out.limpeza).reduce((s, x) => s + (x.apagados || 0), 0);
                registrarSucesso('Sessao', `Limpeza da sessão: ${totalApagado} arquivos apagados`);
            }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, null, 2));
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

// Keep-alive: pinga o próprio /health a cada 14 minutos para não adormecer no Render.com
setInterval(async () => {
    const url = _BASE_URL_EXTERNA;
    if (!url) return;
    try {
        const axios = require('axios');
        await axios.get(`${url.replace(/\/$/, '')}/health`, { timeout: 10000 });
    } catch (err) {
        console.warn(`⚠️  Keep-alive falhou: ${err.message}`);
    }
}, 14 * 60 * 1000);

// =============================================
//  CONFIGURAÇÃO
// =============================================
// Tudo configurável por variável de ambiente, com fallback para o valor atual:
// trocar de grupo/acréscimo/horário não exige mais mexer no código.
const _envInt = (v, def) => { const n = parseInt(v, 10); return Number.isNaN(n) ? def : n; };
const GRUPO_ORIGEM_NOME   = process.env.GRUPO_ORIGEM_NOME  || 'Ronei repasse';
const GRUPO_DESTINO_NOME  = process.env.GRUPO_DESTINO_NOME || 'MINAS BRASIL REPASSE GRUPO 8';
const GRUPO_AVISO_NOME    = process.env.GRUPO_AVISO_NOME   || 'MINAS BRASIL REPASSE GRUPO 8';
const ACRESCIMO           = _envInt(process.env.ACRESCIMO, 1000);
const HORA_AVISO          = _envInt(process.env.HORA_AVISO, 9);   // 9 UTC = 06:30 BRT
const MINUTO_AVISO        = _envInt(process.env.MINUTO_AVISO, 30);
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

// Auto-recuperacao (bug da Falha #3, 30/07): quando a sessao morre, o WhatsApp
// fecha a conexao em loop SEM disparar "loggedOut", e o bot reconectava pra
// sempre (7.573x) sem nunca pedir um QR novo. Contamos as falhas SEGUIDAS (sem
// chegar a conectar): passando do limite, a sessao e' dada como morta -> apaga
// e gera QR sozinho. Uma conexao bem-sucedida zera o contador.
let falhasConsecutivas = 0;
const MAX_FALHAS_ANTES_RESET = 15;
// "Geracao" do socket: cada iniciarBot cria uma nova. Timers de sockets antigos
// (ex: buscarGrupos) comparam com ela e param, em vez de virar zumbis eternos.
let geracaoBot = 0;

// Sessao dada como morta: apaga os arquivos e reinicia limpo -> gera novo QR.
function apagarSessaoEReiniciar() {
    try {
        const sessaoDir = path.join(DATA_DIR, 'sessao');
        if (fs.existsSync(sessaoDir)) {
            for (const f of fs.readdirSync(sessaoDir)) {
                try { fs.unlinkSync(path.join(sessaoDir, f)); } catch {}
            }
        }
        registrarErro('Conexão', 'Sessão apagada automaticamente — escaneie o novo QR em /qr');
    } catch (err) {
        registrarErro('AutoReset', err.message);
    }
    ultimoQR = null;
    botRodando = false;
    setTimeout(iniciarBot, 2000);
}

async function iniciarBot() {
    if (botRodando) return;
    botRodando = true;
    const minhaGeracao = ++geracaoBot;
    const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'sessao'));

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        keepAliveIntervalMs: 10000,   // ping a cada 10s p/ segurar a conexao (reduz quedas por inatividade)
    });
    sockAtual = sock;

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
            falhasConsecutivas = 0;            // reconectou: zera o contador de falhas
            console.log('\n✅ Bot conectado!\n');
            setTimeout(buscarGrupos, 3000);
        }
        if (connection === 'close') {
            stats.status = 'desconectado';
            botRodando = false;
            const codigoSaida = lastDisconnect?.error?.output?.statusCode;
            const reiniciar = codigoSaida !== DisconnectReason.loggedOut;
            console.log(`Conexão encerrada (código ${codigoSaida}). Reiniciando: ${reiniciar}`);
            if (reiniciar) {
                stats.reconexoes++;
                falhasConsecutivas++;
                if (falhasConsecutivas >= MAX_FALHAS_ANTES_RESET) {
                    // Muitas falhas seguidas sem conectar = sessao morta.
                    // Apaga e gera QR sozinho, em vez de remar pra sempre.
                    registrarErro('Conexão', `${falhasConsecutivas} falhas seguidas — sessão parece morta. Apagando p/ gerar novo QR.`);
                    falhasConsecutivas = 0;
                    apagarSessaoEReiniciar();
                } else {
                    // Backoff: espera cresce com as falhas (ate 60s) p/ nao martelar.
                    const espera = Math.min(8000 * falhasConsecutivas, 60000);
                    registrarErro('Conexão', `Desconectado (cód ${codigoSaida}). Reconectando (tentativa ${stats.reconexoes}, ${falhasConsecutivas}ª seguida em ${espera / 1000}s)...`);
                    setTimeout(iniciarBot, espera);
                }
            }
        }
    });

    let grupoOrigemId  = _cachedGrupos.origemId  || null;
    let grupoDestinoId = _cachedGrupos.destinoId || null;
    let grupoAvisoId   = _cachedGrupos.avisoId   || null;

    async function buscarGrupos() {
        if (minhaGeracao !== geracaoBot) return;   // socket obsoleto — nao vira zumbi
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

            if (grupoOrigemId && grupoDestinoId) {
                _cachedGrupos = { origemId: grupoOrigemId, destinoId: grupoDestinoId, avisoId: grupoAvisoId };
                salvarGrupos(_cachedGrupos);
            }

            if (grupoAvisoId) agendarAvisoMatinal(sock, grupoAvisoId);
        } catch (err) {
            registrarErro('buscarGrupos', err.message);
            if (minhaGeracao === geracaoBot) setTimeout(buscarGrupos, 10000);
        }
    }

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
                    const stanzaIdCitado = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
                    const descricao = texto.replace(/vendido|reservado/gi, '').trim();
                    const legendaStatus = descricao ? `${status}\n${descricao}` : status;

                    // PRINCIPAL: marca "em cima" do anúncio do veículo já postado no GRUPO 8
                    // (responde a mensagem do carro com o status, SEM reenviar a foto).
                    let marcou = false;
                    if (stanzaIdCitado) {
                        const ref = postsGrupo8.get(stanzaIdCitado);
                        if (ref?.quoted) {
                            try {
                                await sock.sendMessage(grupoDestinoId, { text: legendaStatus }, { quoted: ref.quoted });
                                marcou = true;
                                console.log(`🏷️  ${status} marcado em cima do anúncio (sem reenviar foto)`);
                            } catch (err) {
                                registrarErro('Vendido/Reply', err.message);
                            }
                        }
                    }

                    // FALLBACK: anúncio original não encontrado (carro antigo, ou bot reiniciado).
                    // Mantém o comportamento antigo de reenviar a foto, para nunca deixar sem marcação.
                    if (!marcou) {
                        const temMidia = msg.message?.imageMessage || msg.message?.videoMessage;
                        const msgCitada = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                        const temMidiaCitada = msgCitada?.imageMessage || msgCitada?.videoMessage;

                        if (temMidia) {
                            const buffer    = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
                            const tipoMidia = msg.message.imageMessage ? 'image' : 'video';
                            const mimetype  = msg.message[tipoMidia + 'Message']?.mimetype || 'image/jpeg';
                            await sock.sendMessage(grupoDestinoId, { [tipoMidia]: buffer, mimetype, caption: legendaStatus });
                        } else if (temMidiaCitada) {
                            const tipoMidia = msgCitada.imageMessage ? 'image' : 'video';
                            const mimetype  = msgCitada[tipoMidia + 'Message']?.mimetype || 'image/jpeg';
                            const chaveMsg  = { id: stanzaIdCitado, remoteJid: msg.key.remoteJid, fromMe: false };
                            const buffer    = await downloadMediaMessage(
                                { message: msgCitada, key: chaveMsg }, 'buffer', {},
                                { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                            );
                            await sock.sendMessage(grupoDestinoId, { [tipoMidia]: buffer, mimetype, caption: legendaStatus });
                        } else {
                            await sock.sendMessage(grupoDestinoId, { text: legendaStatus });
                        }
                    }

                    // Marca VENDIDO no Instagram se tiver o postId mapeado
                    if (isVendido && stanzaIdCitado) {
                        registrarVendaAds(stanzaIdCitado); // aprendizado: registra tempo ate a venda
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

                    const enviada = await sock.sendMessage(grupoDestinoId, { [tipoMidia]: buffer, mimetype, caption: textoAjustado });
                    registrarPostGrupo8(msg.key.id, enviada, textoAjustado);
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
                    const enviada = await sock.sendMessage(grupoDestinoId, { text: textoAjustado });
                    registrarPostGrupo8(msg.key.id, enviada, textoAjustado);
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
