// ============================================================================
//  ads-meta.js  —  MOTOR DE DISPARO DE ANUNCIOS (Marketing API do Meta)
//  ---------------------------------------------------------------------------
//  Impulsiona um post que JA EXISTE no Instagram (mantem curtidas/comentarios),
//  com TETO DE GASTO travado. Projetado pra rodar em DRY-RUN (simulacao) ate o
//  token do Meta existir — nesse modo NAO gasta nada, so mostra o que faria.
//
//  Objetivo: trazer gente nova pro perfil @repasseminasbrasil (visitas ao
//  perfil / engajamento). Douglas aprova cada anuncio por "SIM" no WhatsApp.
//
//  Config por variaveis de ambiente (todas com padrao seguro):
//    META_ADS_TOKEN        token do System User (SEM ele => dry-run automatico)
//    META_AD_ACCOUNT_ID    conta "Minas Brasil Repasse" (padrao 186603184330159)
//    META_PAGE_ID          Pagina "Minas brasil repasse de veiculos" (padrao 1131403096722935)
//    META_IG_ID            perfil @repasseminasbrasil (padrao 17841448189772049)
//    ADS_TETO_DIA          teto R$/dia por carro           (padrao 20)
//    ADS_TETO_MES          teto R$/mes somando tudo         (padrao 300)
//    ADS_DIAS_CAMPANHA     dias que cada anuncio roda       (padrao 5)
// ============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GRAPH = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------
//  Config — le do ambiente com padroes. Sem token => dryRun automatico.
// ---------------------------------------------------------------------------
function config() {
    const token = process.env.META_ADS_TOKEN || '';
    return {
        token,
        adAccount: String(process.env.META_AD_ACCOUNT_ID || '186603184330159').replace(/^act_/, ''), // Minas Brasil Repasse
        pageId:    process.env.META_PAGE_ID || '1131403096722935',   // Pagina "Minas brasil repasse de veiculos"
        igId:      process.env.META_IG_ID   || '17841448189772049',  // @repasseminasbrasil
        tetoDia:   Number(process.env.ADS_TETO_DIA || 20),
        tetoMes:   Number(process.env.ADS_TETO_MES || 300),
        dias:      Number(process.env.ADS_DIAS_CAMPANHA || 5),
        linkDestino: process.env.ADS_LINK_DESTINO || 'https://chat.whatsapp.com/FvC5c8fpgvg5tWYWS4r4vk', // grupo WhatsApp do repasse
        dryRun:    !token,                 // sem token = simulacao (nao gasta)
    };
}

// ---------------------------------------------------------------------------
//  TRAVA DE GASTO MENSAL  — arquivo persistente {"2026-08": 120, ...}
//  Guarda o total JA COMPROMETIDO no mes (orcamento das campanhas aprovadas).
//  E conservador: conta o orcamento cheio no ato da aprovacao, nao o gasto real.
// ---------------------------------------------------------------------------
function _arqGasto(dataDir) { return path.join(dataDir, 'gasto_ads.json'); }
function _mesAtual() { return new Date().toISOString().slice(0, 7); } // AAAA-MM

function lerGastos(dataDir) {
    try {
        const f = _arqGasto(dataDir);
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch (e) { /* arquivo corrompido: comeca zerado */ }
    return {};
}
function gastoDoMes(dataDir) {
    return Number(lerGastos(dataDir)[_mesAtual()] || 0);
}
function registrarGasto(dataDir, valor) {
    const g = lerGastos(dataDir);
    g[_mesAtual()] = Number((Number(g[_mesAtual()] || 0) + valor).toFixed(2));
    try { fs.writeFileSync(_arqGasto(dataDir), JSON.stringify(g, null, 2)); } catch (e) {}
    return g[_mesAtual()];
}
// Zera o comprometimento do mes (util quando testes criaram campanhas que foram excluidas).
function resetarGasto(dataDir) {
    try { fs.writeFileSync(_arqGasto(dataDir), JSON.stringify({}, null, 2)); } catch (e) {}
    return 0;
}

// Retorna { ok, motivo, orcamentoTotal, jaGastoMes, sobraMes } — a decisao da trava.
function checarTeto(dataDir, cfg, orcamentoDia, dias) {
    const orcamentoTotal = Number((orcamentoDia * dias).toFixed(2));
    const jaGastoMes = gastoDoMes(dataDir);
    const sobraMes = Number((cfg.tetoMes - jaGastoMes).toFixed(2));
    if (orcamentoDia > cfg.tetoDia)
        return { ok: false, motivo: `R$ ${orcamentoDia}/dia passa do teto diario (R$ ${cfg.tetoDia})`, orcamentoTotal, jaGastoMes, sobraMes };
    if (orcamentoTotal > sobraMes)
        return { ok: false, motivo: `R$ ${orcamentoTotal} passa do que sobra no mes (R$ ${sobraMes} de R$ ${cfg.tetoMes})`, orcamentoTotal, jaGastoMes, sobraMes };
    return { ok: true, motivo: 'dentro do teto', orcamentoTotal, jaGastoMes, sobraMes };
}

// ---------------------------------------------------------------------------
//  MONTAR O PLANO  — a estrutura da campanha/adset/ad, SEM enviar.
//  Publico: Belo Horizonte e regiao, 18-65, foco em quem tem interesse em carro.
//  Objetivo: engajamento/visitas ao perfil (trazer seguidores).
// ---------------------------------------------------------------------------
function montarPlano(cfg, { instagramMediaId, modelo, legenda }, orcamentoDia, dias) {
    const reais = orcamentoDia * dias;
    return {
        conta: `act_${cfg.adAccount}`,
        campanha: {
            name: `Repasse | ${modelo} | ${_mesAtual()}`,
            objective: 'OUTCOME_TRAFFIC',          // Trafego: comporta VISIT_INSTAGRAM_PROFILE (visitas ao perfil)
            special_ad_categories: [],
            status: 'PAUSED',                       // sobe pausado; ativa so apos conferir
            is_adset_budget_sharing_enabled: false, // orcamento fica no conjunto (nao CBO): a API v21 exige declarar
        },
        adset: {
            name: `Repasse | ${modelo}`,
            daily_budget: Math.round(orcamentoDia * 100),  // centavos (BRL)
            bid_strategy: 'LOWEST_COST_WITHOUT_CAP',  // menor custo automatico (nao exige lance manual)
            billing_event: 'IMPRESSIONS',
            optimization_goal: 'VISIT_INSTAGRAM_PROFILE',  // otimiza pra VISITAS AO PERFIL do Instagram (define o destino)
            end_time_dias: dias,
            targeting: {
                geo_locations: { cities: [{ key: '2430536', radius: 40, distance_unit: 'kilometer' }], location_types: ['home', 'recent'] }, // Belo Horizonte
                age_min: 18, age_max: 65,
                publisher_platforms: ['instagram'],
            },
        },
        criativo: { instagram_media_id: instagramMediaId || '(id do post)' },
        resumo: { orcamentoDia, dias, gastoPrevisto: reais, modelo },
    };
}

// ---------------------------------------------------------------------------
//  CHAMADA HTTP a Marketing API (so usada quando NAO e dry-run)
// ---------------------------------------------------------------------------
async function _post(nodePath, cfg, body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body))
        form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    form.append('access_token', cfg.token);
    const res = await fetch(`${GRAPH}/${nodePath}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error?.error_user_msg || json.error?.message || `HTTP ${res.status} em ${nodePath}`);
    return json;
}

// GET na Graph API (so quando NAO e dry-run).
async function _get(nodePath, cfg) {
    const sep = nodePath.includes('?') ? '&' : '?';
    const res = await fetch(`${GRAPH}/${nodePath}${sep}access_token=${encodeURIComponent(cfg.token)}`, { signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status} em ${nodePath}`);
    return json;
}

// Resultado das campanhas de anuncio (nivel campanha, ultimos 30 dias) — so as que tiveram entrega.
// Retorna { dryRun, campanhas:[{ nome, alcance, impressoes, gasto, cliques, custoPorClique }] }.
async function resultadoCampanhas() {
    const cfg = config();
    if (cfg.dryRun) return { dryRun: true, campanhas: [] };
    const acct = `act_${cfg.adAccount}`;
    const fields = 'campaign_name,reach,impressions,spend,actions,cost_per_action_type';
    const json = await _get(`${acct}/insights?level=campaign&date_preset=last_7d&fields=${fields}&limit=50`, cfg);
    const ehClique = a => /link_click|profile_visit|instagram_profile/i.test(a.action_type || '');
    const campanhas = (json.data || []).map(c => {
        const cl = (c.actions || []).find(ehClique);
        const cpc = (c.cost_per_action_type || []).find(ehClique);
        return {
            nome: c.campaign_name,
            alcance: Number(c.reach || 0),
            impressoes: Number(c.impressions || 0),
            gasto: Number(c.spend || 0),
            cliques: cl ? Number(cl.value) : 0,
            custoPorClique: cpc ? Number(cpc.value) : null,
            acoes: (c.actions || []).map(a => `${a.action_type}=${a.value}`),  // cruas, pra diagnostico
        };
    }).filter(c => c.impressoes > 0);
    return { dryRun: false, campanhas };
}

// Status de cada anuncio (em analise / ativo / rejeitado) + motivo se recusado.
async function statusAnuncios() {
    const cfg = config();
    if (cfg.dryRun) return { dryRun: true, anuncios: [] };
    const acct = `act_${cfg.adAccount}`;
    const json = await _get(`${acct}/ads?fields=name,effective_status,ad_review_feedback&limit=50`, cfg);
    const traduz = s => ({
        ACTIVE: 'veiculando ✅', PENDING_REVIEW: 'em análise ⏳', IN_PROCESS: 'em análise ⏳',
        PENDING_BILLING_INFO: 'falta dado de pagamento ⚠️', DISAPPROVED: 'REJEITADO ❌',
        PAUSED: 'pausado', ADSET_PAUSED: 'conjunto pausado', CAMPAIGN_PAUSED: 'campanha pausada',
        WITH_ISSUES: 'com problema ⚠️', PREAPPROVED: 'pré-aprovado',
    }[s] || s);
    const anuncios = (json.data || []).map(a => ({
        nome: a.name, status: traduz(a.effective_status), bruto: a.effective_status,
        motivo: a.ad_review_feedback ? JSON.stringify(a.ad_review_feedback) : null,
    }));
    return { dryRun: false, anuncios };
}

// ---------------------------------------------------------------------------
//  SUBIR O ANUNCIO  — orquestra tudo, com a trava de teto na frente.
//  Em dry-run: retorna { dryRun:true, plano } sem tocar na API nem no gasto.
//  Com token: cria campanha -> adset -> creative -> ad (pausado) e registra o gasto.
//  Retorna sempre um objeto com { ok, dryRun, plano, ids?, teto }.
// ---------------------------------------------------------------------------
async function subirAnuncio({ dataDir, post, orcamentoDia, dias, ativar }) {
    const cfg = config();
    orcamentoDia = orcamentoDia || cfg.tetoDia;
    dias = dias || cfg.dias;
    const st = ativar ? 'ACTIVE' : 'PAUSED';   // ativar=true sobe rodando (o Meta ainda analisa antes de gastar)

    const teto = checarTeto(dataDir, cfg, orcamentoDia, dias);
    const plano = montarPlano(cfg, post, orcamentoDia, dias);
    plano.campanha.status = st;
    if (!teto.ok) return { ok: false, dryRun: cfg.dryRun, motivo: teto.motivo, plano, teto };

    if (cfg.dryRun) return { ok: true, dryRun: true, motivo: 'simulacao (sem token) — nada gasto', plano, teto };

    // --- disparo real (Marketing API) ---
    const acct = `act_${cfg.adAccount}`;
    const camp = await _post(`${acct}/campaigns`, cfg, plano.campanha);
    const endTime = new Date(Date.now() + dias * 864e5).toISOString();
    const adset = await _post(`${acct}/adsets`, cfg, {
        ...plano.adset, campaign_id: camp.id, end_time: endTime, status: st,
        targeting: plano.adset.targeting,
    });
    const creative = await _post(`${acct}/adcreatives`, cfg, {
        name: `Repasse | ${post.modelo}`,
        instagram_user_id: cfg.igId,
        source_instagram_media_id: post.instagramMediaId,
    });
    const ad = await _post(`${acct}/ads`, cfg, {
        name: `Repasse | ${post.modelo}`, adset_id: adset.id,
        creative: { creative_id: creative.id }, status: st,
    });

    const totalMes = registrarGasto(dataDir, teto.orcamentoTotal);
    return { ok: true, dryRun: false, motivo: 'anuncio criado (pausado p/ conferencia)', plano,
             ids: { campanha: camp.id, adset: adset.id, criativo: creative.id, anuncio: ad.id }, teto: { ...teto, totalMes } };
}

module.exports = { config, checarTeto, gastoDoMes, registrarGasto, resetarGasto, montarPlano, subirAnuncio, resultadoCampanhas, statusAnuncios };
