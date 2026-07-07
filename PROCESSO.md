# Processo do Bot Repasse — Como tudo funciona na nuvem

> Documento de referência do **bot-repasse** (Minas Brasil Repasse).
> Última atualização: 06/07/2026.
> ⚠️ Este repositório é **público** — nunca escreva senhas, tokens ou URLs de webhook aqui. Tudo que é secreto fica nas **variáveis de ambiente** do Render (ver seção 10).

---

## 1. Resumo em uma frase

O bot é um número de WhatsApp que fica ligado 24h na nuvem. Ele **escuta** o grupo do Ronei, **reencaminha** os carros pro **GRUPO 8** com +R$1.000 no preço, **posta as fotos no Instagram** e, quando um carro é vendido, **marca como VENDIDO**.

---

## 2. Onde roda (infraestrutura na nuvem)

| Peça | Serviço | Função |
|------|---------|--------|
| **Bot (código)** | **Render.com** (Web Service) | Roda o `bot.js` 24h, conectado ao WhatsApp via Baileys |
| **Código-fonte** | **GitHub** `douglassouzacom/bot-whatsapp` (branch `master`, público) | Guarda o código. Todo `push` no `master` faz o Render **re-deployar sozinho** |
| **Instagram** | **Make.com** (cenário ID 5259453) | Recebe as fotos do bot e publica no perfil `@repasseminasbrasil` |
| **Disco persistente** | Disco do Render (`DATA_DIR`) | Guarda a sessão do WhatsApp e os arquivos de memória (seção 9) para sobreviver a reinícios |
| **Painel** | `https://bot-whatsapp-7xeo.onrender.com` | Mostra status, contadores, erros e QR code de conexão |

---

## 3. Os grupos e como o bot se conecta

- **Grupo de ORIGEM:** "Ronei repasse" — o bot **só escuta**, nunca posta nada lá. (Douglas não é admin.)
- **Grupo de DESTINO:** "MINAS BRASIL REPASSE GRUPO 8" — é onde o bot **posta tudo**.

Ao conectar, o bot procura os grupos pelo nome (variáveis `GRUPO_ORIGEM_NOME` e `GRUPO_DESTINO_NOME`). Se algum grupo for **renomeado**, o bot não acha e para de funcionar — nesse caso é preciso ajustar o nome na variável de ambiente.

Conexão do WhatsApp: primeira vez lê um **QR code** no painel. A sessão fica salva no disco persistente, então o bot **não** pede QR de novo a cada reinício.

---

## 4. Fluxo A — Anúncio normal (Ronei → GRUPO 8)

1. Ronei posta um carro no grupo dele (foto + descrição com preço).
2. O bot pega a mensagem e **soma R$1.000** em cada preço encontrado (`ACRESCIMO`).
3. O bot reencaminha a foto + descrição ajustada pro **GRUPO 8**.
4. O bot **guarda a referência** dessa mensagem (ver seção 6 e 9) para conseguir marcar VENDIDO depois.
5. Em seguida, dispara o fluxo do Instagram (Fluxo B), **exceto** se o texto for redução de preço — aí NÃO posta no Instagram, só reencaminha pro grupo. As palavras que indicam redução são: *abaixou, abaixei, baixou, baixei, baixamos, reduzi, reduzido, nova oferta, novo valor, preço novo, valor novo* (lista `PALAVRAS_ABAIXOU` no código).

---

## 5. Fluxo B — Postagem no Instagram (via Make.com)

1. O bot envia pro Make.com: `{ action: "post", caption, imageUrl, stanzaId }`.
2. Make.com publica a foto no Instagram e recebe o `postId`.
3. Make.com faz um **POST de volta** pro bot (`/webhook-instagram-id`) com `{ stanzaId, postId }`.
4. O bot guarda o par **stanzaId → postId** (arquivo `instagram_posts.json`).
5. Esse `postId` é o que permite comentar "VENDIDO" no post certo depois.

Cenário no Make.com (ID 5259453):
```
Webhook → Router → [action=post]    → Instagram: Create a photo post → HTTP (devolve postId ao bot)
                 → [action=vendido] → Instagram: Create a comment (✅ VENDIDO)
```

---

## 6. Fluxo C — VENDIDO / RESERVADO

Quando o Ronei responde um carro escrevendo "vendido" (ou "reservado"):

**No GRUPO 8 (comportamento atual, desde 06/07/2026 — commit b892c75):**
- O bot **responde ("marca em cima") o anúncio do carro que já está no GRUPO 8**, escrevendo `🚫 VENDIDO`, **sem reenviar a foto**.
- Para isso ele usa a referência guardada no Fluxo A (arquivo `posts_grupo8.json`).
- **Rede de segurança (fallback):** se ele NÃO achar o anúncio original (carro anunciado antes dessa atualização, ou bot reiniciado sem o histórico), ele volta a **reenviar a foto** com o selo VENDIDO — pra nunca deixar um carro sem marcação.

**No Instagram:**
- Se aquele carro tinha um post mapeado, o bot comenta **✅ VENDIDO** no post (via Make.com).
- Auto-retry: até 3 tentativas (espera 30s e 60s entre elas).

> Importante: essa marcação acontece **somente no GRUPO 8**. O bot nunca escreve no grupo do Ronei.

---

## 7. Aviso matinal (todo dia 06:30 BRT)

O bot manda automaticamente no GRUPO 8 o texto padrão de condições de venda (sem garantia, só PIX/TED, sem financiamento/consórcio/trocas, frete por conta do comprador, prazo 7–10 dias, assinado Douglas Souza / Minas Brasil Repasse).

Horário controlado por `HORA_AVISO` (9 UTC = 06:30 BRT) e `MINUTO_AVISO`.

---

## 8. Rede de proteção do Instagram (alerta no WhatsApp)

Problema histórico: às vezes o Instagram parava de receber posts e ninguém percebia (só olhando o perfil).

Proteção atual: se o Make.com **não confirmar** a publicação (callback do `postId`) em **5 minutos**, o bot **manda um alerta no WhatsApp** avisando a falha. Tem cooldown de 30 min (pra não floodar). O destino do alerta é a variável `WHATSAPP_ALERTA` (se vazia, o bot manda pra si mesmo).

---

## 9. Arquivos que o bot guarda no disco (persistentes)

Ficam em `DATA_DIR` (disco persistente do Render). Sobrevivem a reinícios e deploys.

| Arquivo | O que guarda |
|---------|--------------|
| `sessao/` | Sessão do WhatsApp (evita pedir QR toda vez) |
| `grupos.json` | IDs dos grupos de origem/destino (reconecta sem precisar buscar os grupos de novo) |
| `instagram_posts.json` | stanzaId → postId do Instagram (pra comentar VENDIDO no post certo) |
| `posts_grupo8.json` | stanzaId do anúncio → referência da mensagem no GRUPO 8 (pra marcar VENDIDO em cima, sem foto) |
| `fila_retry.json` | Retries do Instagram pendentes (visibilidade em caso de reinício) |

Limpeza automática: entradas com mais de **7 dias** são removidas (carro já vendido não precisa ficar na memória).

### 9.1. Faxina da sessão (proteção contra disco entupido)

O disco do Render tem um **teto de ~65.536 arquivos** (inodes). A pasta `sessao/` do Baileys acumula arquivos de cache (`lid-mapping`, `pre-key`, `device-list`) às dezenas de milhares. Se estourar o teto, o bot dá **`ENOSPC`** e **trava tudo** — nem GRUPO 8, nem Instagram (é a "Falha #2", diferente do token do Make).

Proteção em **4 camadas** (não depende de um único timer):
1. **No boot** — toda vez que o bot sobe, ele faxina antes de conectar (cobre reinícios frequentes, que é justamente quando o disco enche).
2. **A cada 30 min** — conta os arquivos; se passar de `LIMIAR_FAXINA` (padrão 20.000), faxina na hora.
3. **A cada 6 h** — faxina de piso, para o crescimento lento.
4. **Alerta no WhatsApp** — se mesmo após a faxina a pasta seguir acima de `LIMIAR_ALERTA` (padrão 45.000), avisa o número de `WHATSAPP_ALERTA`.

A faxina mantém os **500 mais recentes** de cada tipo de cache e **nunca** toca em `creds`, `session`, `sender-key`, `identity-key` ou `app-state` → **não desloga o WhatsApp**.

Diagnóstico manual: `GET /disco` (espaço e nº de arquivos) e `GET /sessao-info` (composição da sessão; `?limpar=sessao&confirmar=sim&manter=500` roda a faxina na mão).

---

## 10. Variáveis de ambiente (configuradas no Render)

Todos os segredos e ajustes ficam aqui, **não no código**:

| Variável | Para que serve |
|----------|----------------|
| `MAKE_WEBHOOK` | URL do webhook do Make.com (postar foto) |
| `MAKE_WEBHOOK_VENDIDO` | (opcional) webhook separado pro comentário VENDIDO; se vazio, usa o mesmo acima |
| `WHATSAPP_ALERTA` | Número que recebe os alertas de falha (só dígitos com DDI) |
| `GRUPO_ORIGEM_NOME` | Nome do grupo do Ronei (padrão: "Ronei repasse") |
| `GRUPO_DESTINO_NOME` | Nome do GRUPO 8 (padrão: "MINAS BRASIL REPASSE GRUPO 8") |
| `ACRESCIMO` | Quanto somar no preço (padrão: 1000) |
| `HORA_AVISO` / `MINUTO_AVISO` | Horário do aviso matinal (padrão: 9 UTC / 30 = 06:30 BRT) |
| `DATA_DIR` | Caminho do disco persistente do Render |
| `RENDER_EXTERNAL_URL` | URL pública (o Render preenche sozinho) — usada pra servir as imagens ao Make.com |
| `LIMIAR_FAXINA` | (opcional) nº de arquivos da sessão que dispara a faxina preventiva (padrão: 20000) |
| `LIMIAR_ALERTA` | (opcional) nº de arquivos que, mesmo após faxina, aciona alerta no WhatsApp (padrão: 45000) |

---

## 11. Como atualizar o bot (deploy)

1. Alterar o código (`bot.js`) localmente.
2. `git add` → `git commit` → `git push origin master`.
3. O Render detecta o push e **re-deploya sozinho** em ~2 minutos.
4. Conferir no painel `https://bot-whatsapp-7xeo.onrender.com` se voltou "online".

---

## 12. Painel de monitoramento e teste

- Painel: `https://bot-whatsapp-7xeo.onrender.com` — uptime, contadores, últimos erros, fila de retry e QR code.
- Teste de VENDIDO no Instagram: botão vermelho "Marcar último post como VENDIDO" (ou rota `/vendido-teste`).

---

## 13. Problema recorrente conhecido — token do Instagram expira

**Sintoma:** os carros continuam chegando normal no GRUPO 8, mas param de aparecer no Instagram por dias.

**Causa:** a conexão do Instagram no Make.com expira (~a cada 60 dias). No histórico do Make aparece o erro **"Media ID is not available (9007, OAuthException)"** e o Make **desativa o cenário sozinho** (fica "Inactive"), empilhando tudo na fila.

**Como consertar:**
1. No Make.com, editar os módulos de Instagram ("Create a photo post" e "Create a comment") e **reconectar** a Connection (re-login no Facebook).
2. **LIMPAR a fila** ("Show queue" → apagar). **Nunca reprocessar** — as imagens antigas já morreram (o cache do bot expira em 30 min); reprocessar floda o perfil com carros velhos/vendidos e dá erro 404.
3. Virar o cenário de **Inactive → Active**.
