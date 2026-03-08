# 🔴 System Breach — Documento de Regras e Lógica (Game Design Document Técnico)

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Estrutura do Projeto](#2-estrutura-do-projeto)
3. [Mecânicas de Jogo](#3-mecânicas-de-jogo)
4. [Fluxo de Dados (Client ↔ Server)](#4-fluxo-de-dados-client--server)
5. [Regras de Negócio](#5-regras-de-negócio)
6. [Tratamento de Erros](#6-tratamento-de-erros)
7. [Referência de Funções](#7-referência-de-funções)

---

## 1. Visão Geral

**System Breach** é um jogo multiplayer de blefe com cartas, inspirado em Coup, com temática de hacking/cybersecurity. Os jogadores usam cartas de identidade (Admin, Trojan, Firewall, Phisher, Sniffer) para realizar ações, bloquear adversários e contestar blefes. O último jogador conectado à "rede" vence.

**Stack Tecnológica:**
- **Backend:** Node.js, Express, WebSocket (`ws`), SQLite (`sql.js`)
- **Autenticação:** JWT (`jsonwebtoken`), bcryptjs
- **Frontend:** HTML/CSS/JS monolítico (`public/index.html`)
- **Bot AI:** Módulo dedicado (`src/botLogic.js`)

---

## 2. Estrutura do Projeto

| Arquivo | Responsabilidade |
|---|---|
| `server.js` | Servidor HTTP/WebSocket, rotas REST, gerenciamento de salas, timers, lógica de bots em partidas |
| `src/gameLogic.js` | Estado do jogo, ações, contestações, resolução de turnos, sanitização de estado |
| `src/botLogic.js` | IA dos bots (3 dificuldades: easy, normal, hard) |
| `src/db.js` | Camada de banco de dados SQLite (jogadores, salas, histórico) |
| `public/index.html` | Frontend completo (UI, WebSocket client, renderização) |
| `public/admin/index.html` | Painel administrativo |

---

## 3. Mecânicas de Jogo

### 3.1 Cartas

O deck contém **15 cartas** (3 de cada tipo):

| Carta | Ação Associada | Bloqueio |
|---|---|---|
| **Admin** | Mineração (₵+3) | Bloqueia Ajuda Externa |
| **Trojan** | Injeção (custo ₵3, alvo perde 1 vida) | — |
| **Firewall** | — | Bloqueia Injeção |
| **Phisher** | Interceptação (rouba ₵2 do alvo) | Bloqueia Interceptação |
| **Sniffer** | Análise (vê 2 cartas do deck, pode trocar) | Bloqueia Interceptação |

### 3.2 Setup Inicial

- Cada jogador recebe **2 cartas de mão** (hand) + **2 cartas de vida** (lives), todas do deck embaralhado.
- Cada jogador começa com **₵2** (crypto).
- O deck é embaralhado com Fisher-Yates, rejeitando distribuições com muitos pares adjacentes (máx. 2 pares).
- O primeiro jogador é selecionado aleatoriamente.

### 3.3 Ações Disponíveis

#### 3.3.1 Renda (income)
- **Efeito:** +₵1
- **Requer carta:** Não
- **Bloqueável:** Não
- **Contestável:** Não
- **Resolução:** Imediata, avança turno

#### 3.3.2 Ajuda Externa (foreign_aid)
- **Efeito:** +₵2
- **Requer carta:** Não (mas pode ser bloqueada)
- **Bloqueável:** Sim (Admin)
- **Contestável:** Não (nenhuma carta é declarada)
- **Fase:** `block` → espera resposta de todos os outros jogadores

#### 3.3.3 Mineração (mining)
- **Carta declarada:** Admin
- **Efeito:** +₵3
- **Bloqueável:** Não
- **Contestável:** Sim
- **Fase:** `block_or_contest` → espera resposta de todos

#### 3.3.4 Injeção (injection)
- **Carta declarada:** Trojan
- **Custo:** ₵3 (deduzido na resolução, não na declaração)
- **Efeito:** Alvo perde 1 vida
- **Bloqueável:** Sim (Firewall)
- **Contestável:** Sim
- **Fase:** `block_or_contest`

#### 3.3.5 Interceptação (intercept)
- **Carta declarada:** Phisher
- **Efeito:** Rouba até ₵2 do alvo
- **Bloqueável:** Sim (Sniffer, Phisher)
- **Contestável:** Sim
- **Fase:** `block_or_contest`

#### 3.3.6 Análise (analysis)
- **Carta declarada:** Sniffer
- **Efeito:** Vê as 2 cartas do topo do deck, pode trocar 1 carta da mão por 1 do deck. Se não trocar, recebe +₵1.
- **Bloqueável:** Não
- **Contestável:** Sim
- **Fase:** `block_or_contest` → após resolução: `sniffer_choice`

#### 3.3.7 Global Breach
- **Custo:** ₵7
- **Efeito:** Alvo perde 1 vida. Não pode ser bloqueado nem contestado.
- **Resolução:** Imediata
- **Regra Rastro Digital:** Se um jogador tem ₵10+, é **obrigado** a executar Global Breach (fase `forced_global_breach`).

### 3.4 Sistema de Contestação (Contest)

Quando um jogador declara uma ação com carta (ex: "Eu tenho Admin"), qualquer outro jogador pode **contestar** (duvidar).

**Resolução:**
1. Se o alvo da contestação **tem** a carta declarada:
   - O contestador perde 1 vida e ₵1 (penalidade).
   - O alvo embaralha a carta provada de volta no deck e compra uma nova.
2. Se o alvo **não tem** a carta:
   - O alvo perde 1 vida e ₵1.

**Contestação de Bloqueio:**
- Quando alguém bloqueia uma ação, o ator original pode contestar o bloqueio.
- Se o bloqueador prova a carta → bloqueio confirmado, ação cancelada.
- Se o bloqueador mentia → bloqueador perde vida, ação resolve normalmente.

### 3.5 Sistema DDoS (Núcleo / Core)

- O Núcleo é habilitado em partidas com **3+ jogadores**.
- Cada vida perdida no jogo adiciona **1 carga** ao Núcleo (máx. 3 para 3-4 jogadores, máx. 4 para 5-6 jogadores).
- Cada carga também adiciona ₵1 ao pot do Núcleo.
- Quando o Núcleo atinge carga máxima, o **DDoS** fica disponível.

**Ativação DDoS:**
- Não é uma ação independente. É um **modificador de contestação**.
- Ao contestar (ou contestar um bloqueio), o jogador pode ativar DDoS junto.
- Cada jogador só pode usar DDoS **1 vez por partida**.

**Efeito DDoS:**
- O **perdedor** da contestação é **completamente eliminado** (todas as vidas reveladas, crypto zerado).
- O **vencedor** coleta todo o crypto do pot do Núcleo.
- Após resolução, o Núcleo reseta (cargas e crypto voltam a 0).

### 3.6 Sistema de Vidas

- Cada jogador tem **2 vidas** (cartas face-down).
- Perder 1 vida: a carta é revelada (face-up) e adicionada à lista de cartas eliminadas.
- Perder ambas as vidas: jogador é **eliminado** (desconectado da rede).
- Jogadores eliminados não participam mais do jogo.

### 3.7 Turno de Tempo Limitado

- **Fase de ação:** 45 segundos para jogar.
- **Fase de resposta (bloqueio/contestação):** 15 segundos.
- **Timeout:** Auto-passa (income na fase de ação; pass nas fases de resposta).
- **Extensão:** O jogador atual pode pagar ₵1 para ganhar +30 segundos. O ₵1 vai para o Núcleo.

### 3.8 Pausa

- Jogadores vivos podem votar para pausar.
- Necessário: maioria simples (⌊alive/2⌋ + 1).
- Pausa dura 30 segundos.
- Timer do turno é congelado e retomado após a pausa.

---

## 4. Fluxo de Dados (Client ↔ Server)

### 4.1 Conexão e Autenticação

```
Client                          Server
  │                                │
  │── POST /api/register ──────►  │  → Cria jogador no DB, retorna JWT
  │── POST /api/login ─────────►  │  → Valida credenciais, retorna JWT
  │                                │
  │══ WebSocket CONNECT ════════► │
  │── {type:'auth', token} ─────► │  → Verifica JWT, associa ws↔playerId
  │◄── {type:'authenticated'} ──  │
```

### 4.2 Fluxo de Sala

```
Client                          Server
  │── {type:'create_room'} ────► │  → Cria sala no DB, associa host
  │◄── {type:'room_joined'} ───  │
  │                                │
  │── {type:'join_room', code} ─► │  → Valida código/senha, entra na sala
  │◄── {type:'room_joined'} ───  │
  │   (broadcast room_update)      │
  │                                │
  │── {type:'start_game'} ──────► │  → Valida host, mín. 2 jogadores
  │   (broadcast game_started)     │  → Cria game state, inicia timer
  │   (broadcast game_state)       │
```

### 4.3 Fluxo de Jogo

```
Jogador Ativo                    Server                     Outros Jogadores
  │                                │                              │
  │── game_action ──────────────► │                              │
  │                                │── notification ────────────► │
  │                                │── game_state ──────────────► │
  │◄── game_state ───────────────  │                              │
  │                                │                              │
  │                                │◄── game_respond ────────────  │ (pass/block/contest)
  │                                │── notification ────────────► │ (se block)
  │                                │── game_state ──────────────► │
  │                                │                              │
  │── game_respond_block ────────► │  (se bloqueado: pass/contest) │
  │                                │── game_state ──────────────► │
```

### 4.4 Mensagens WebSocket (Client → Server)

| Tipo | Payload | Descrição |
|---|---|---|
| `auth` | `{token}` | Autenticação via JWT |
| `create_room` | `{maxPlayers, password?}` | Criar sala |
| `join_room` | `{code, password?}` | Entrar em sala por código |
| `leave_room` | — | Sair da sala |
| `start_game` | — | Iniciar partida (host) |
| `play_vs_bots` | `{botCount, difficulty}` | Jogar contra bots |
| `game_action` | `{type, targetId?, card?}` | Executar ação |
| `game_respond` | `{type, card?, useDDoS?}` | Responder a ação (pass/block/contest) |
| `game_respond_block` | `{type, useDDoS?}` | Ator responde a bloqueio (pass/contest) |
| `sniffer_choice` | `{swap, deckCardIndex?, handCardIndex?}` | Escolha da Análise |
| `extend_turn` | — | Pagar ₵1 para +30s |
| `vote_pause` | — | Votar para pausar |
| `chat` | `{text}` | Mensagem no chat |
| `spectate_sim` | `{simId}` | Assistir simulação (admin) |

### 4.5 Mensagens WebSocket (Server → Client)

| Tipo | Descrição |
|---|---|
| `authenticated` | Confirmação de auth com dados do jogador |
| `error` | Mensagem de erro |
| `banned` | Jogador banido |
| `account_deleted` | Conta deletada pelo admin |
| `room_joined` | Entrou na sala (dados da sala) |
| `room_update` | Atualização de jogadores na sala |
| `left_room` | Saiu da sala |
| `game_started` | Partida iniciou |
| `game_state` | Estado completo do jogo (sanitizado por jogador) |
| `notification` | Notificação de ação/bloqueio/timeout |
| `game_paused` | Jogo pausado |
| `game_resumed` | Jogo retomado |
| `pause_vote_update` | Progresso dos votos de pausa |
| `chat` | Mensagem de chat |
| `sim_state` | Estado de simulação (admin) |
| `room_closed` | Sala encerrada |

---

## 5. Regras de Negócio

### 5.1 Condições de Vitória

- **Último sobrevivente:** O último jogador não-eliminado vence.
- Verificado automaticamente após cada perda de vida, eliminação ou resolução de contestação.
- O vencedor recebe +₵1 bônus (prestige coin).

### 5.2 Condições de Derrota

- Perder ambas as vidas → Eliminado.
- Eliminação por DDoS → Todas as vidas reveladas, crypto zerado.

### 5.3 Pontuação e Estatísticas

- **games_played:** Incrementado para todos os jogadores humanos ao final.
- **games_won:** Incrementado apenas para o vencedor humano.
- Bots não são registrados no banco de dados.
- Se um bot vence, nenhuma vitória é creditada; apenas `games_played` dos humanos é incrementado.
- Leaderboard: Top 20 jogadores por vitórias (excluindo admin).

### 5.4 Limites do Jogo

| Parâmetro | Valor |
|---|---|
| Jogadores por sala | 2–6 |
| Cartas no deck | 15 (3×5 tipos) |
| Cartas de mão | 2 por jogador |
| Vidas | 2 por jogador |
| Crypto inicial | ₵2 |
| Custo Global Breach | ₵7 |
| Rastro Digital (Global Breach obrigatório) | ₵10+ |
| Custo Injeção | ₵3 |
| Timer de ação | 45s |
| Timer de resposta | 15s |
| Extensão de turno | ₵1 para +30s |
| Pausa | 30s |
| DDoS por jogador | 1 uso por partida |
| Cargas do Núcleo (3-4 jogadores) | 3 |
| Cargas do Núcleo (5-6 jogadores) | 4 |
| Núcleo (2 jogadores) | Desabilitado |

### 5.5 Fases do Jogo

| Fase | Descrição |
|---|---|
| `action` | Jogador ativo escolhe uma ação |
| `forced_global_breach` | Jogador com ₵10+ deve executar Global Breach |
| `block` | Outros jogadores podem bloquear (apenas Ajuda Externa) |
| `block_or_contest` | Outros podem bloquear OU contestar (ações com carta) |
| `contest_block` | Ator decide se contesta o bloqueio |
| `resolving_contest` | Contestação sendo resolvida |
| `sniffer_choice` | Jogador decide se troca carta com o deck |
| `ended` | Jogo finalizado |

---

## 6. Tratamento de Erros

### 6.1 Validações no `gameLogic.js`

| Validação | Localização | Ação |
|---|---|---|
| Jogador não encontrado | `performAction()` | Retorna `{error}` |
| Não é o turno do jogador | `performAction()` | Retorna `{error}` |
| Fase incorreta para ação | `performAction()` | Retorna `{error}` |
| Crypto insuficiente (Global Breach, Injeção) | `performAction()` | Retorna `{error}` |
| Alvo inválido ou eliminado | `performAction()` | Retorna `{error}` |
| Jogador não está na lista de espera | `respondToAction()` | Retorna `{error}` |
| Contestação de Ajuda Externa bloqueada | `respondToAction()` | Retorna `{error}` |
| DDoS não disponível/já usado | `respondToAction()`, `respondToBlock()` | Retorna `{error}` |
| Null safety: ator/alvo não encontrado na resolução | `resolveAction()`, `startContest()` | Avança turno sem crash |
| Fase incorreta | `resolveSnifferChoice()`, `respondToBlock()` | Retorna `{error}` |

### 6.2 Validações no `server.js`

| Validação | Localização | Ação |
|---|---|---|
| JSON malformado no WebSocket | `ws.on('message')` | Ignora (return) |
| Token JWT inválido/expirado | `auth` handler | Envia erro ao client |
| Conta não encontrada | `auth` handler | Envia erro ao client |
| Conta banida | `auth` handler | Envia `{type:'banned'}` |
| Jogador não autenticado no WS | Cada handler | Return silencioso |
| Sala não encontrada | `join_room` | Envia erro |
| Não é host | `start_game` | Envia erro |
| Mínimo de jogadores | `start_game` | Envia erro |
| Erro de bot na tick | `botRoomTick()` | try/catch, log no console |
| Timer expirado | `autoPassTurn()` | Auto-income ou auto-pass |

### 6.3 Validações no `db.js`

| Validação | Localização | Ação |
|---|---|---|
| Nick: 2-20 caracteres, alfanumérico | `registerPlayer()` | Retorna `{error}` |
| Senha: mínimo 4 caracteres | `registerPlayer()`, `changePassword()` | Retorna `{error}` |
| Nick duplicado (case-insensitive) | `registerPlayer()` | Retorna `{error}` |
| Senha incorreta | `loginPlayer()`, `changePassword()` | Retorna `{error}` |
| Conta banida | `loginPlayer()` | Retorna `{error}` |
| Sala cheia | `joinRoom()` | Retorna `{error}` |
| Partida já iniciada | `joinRoom()` | Retorna `{error}` |
| Já está na sala | `joinRoom()` | Retorna `{error}` |
| Senha da sala incorreta | `joinRoom()` | Retorna `{error}` |

### 6.4 Proteção contra Travamentos

- **Deck vazio:** `drawCard()` recria o deck se estiver vazio.
- **Sniffer com deck vazio:** Concede +₵1 ao invés de travar.
- **Bot com ação inválida:** Fallback automático para `income`.
- **Simulação travada:** Após 8 ticks sem progresso, força `income` e reinicia contagem.
- **Jogador desconectado:** Marcado como `connected: false`, bot rooms são limpos, timer continua normalmente.
- **Null guards em contestação:** Se jogador não encontrado, loga erro e avança turno.
- **Null guards em resolução de ação:** Se ator ou alvo não encontrado, pula a resolução e avança turno.

---

## 7. Referência de Funções

### 7.1 `src/gameLogic.js`

| Função | Descrição |
|---|---|
| `createDeck()` | Cria deck de 15 cartas embaralhado (Fisher-Yates com rejeição de clustering) |
| `createPlayer(id, nick)` | Cria objeto jogador com estado inicial |
| `dealInitialCards(game)` | Distribui 2 cartas de mão + 2 vidas para cada jogador |
| `drawCard(game)` | Compra 1 carta do topo do deck (recria se vazio) |
| `createGame(roomId, players)` | Inicializa estado completo do jogo |
| `advanceTurn(game)` | Reseta fases, verifica DDoS, loga turno |
| `currentPlayer(game)` | Retorna jogador do turno atual |
| `nextTurn(game)` | Avança para o próximo jogador não-eliminado |
| `checkWin(game)` | Verifica se restou apenas 1 jogador vivo |
| `getActivePlayers(game)` | Retorna array de jogadores não-eliminados |
| `performAction(game, playerId, action)` | Valida e executa ação do jogador |
| `respondToAction(game, playerId, response)` | Processa resposta (pass/block/contest) a uma ação |
| `respondToBlock(game, playerId, response)` | Processa resposta do ator a um bloqueio |
| `startContest(game, contesterId, targetId, claimedCard, contestType, isDDoS)` | Resolve uma contestação (com ou sem DDoS) |
| `loseLife(game, player)` | Remove 1 vida do jogador, carrega Núcleo |
| `eliminatePlayerDDoS(game, player)` | Eliminação total por DDoS |
| `eliminatePlayer(game, player)` | Eliminação padrão (ambas vidas perdidas) |
| `resetCore(game)` | Reseta cargas e crypto do Núcleo |
| `checkDDoS(game)` | Atualiza flag `ddosAvailable` |
| `resolveAction(game)` | Aplica efeito da ação após aprovação |
| `resolveSnifferChoice(game, playerId, choice)` | Resolve troca de carta do Sniffer |
| `triggerDDoS(game, triggererId)` | *(Desabilitado)* Retorna erro — DDoS agora é via contestação |
| `getStateForPlayer(game, playerId)` | Sanitiza estado para envio ao client (oculta mãos inimigas) |
| `autoPassWaiting(game, playerId)` | Auto-pass para jogador em espera |

### 7.2 `src/botLogic.js`

| Função | Descrição |
|---|---|
| `weightedPick(opts)` | Seleção aleatória com pesos |
| `weakestTarget(players)` | Retorna jogador com mais vidas reveladas |
| `richestTarget(players)` | Retorna jogador com mais crypto |
| `globalBreachAt(others)` | Escolhe alvo para Global Breach (prioriza fracos) |
| `pickAction(game, player, difficulty)` | Escolhe ação do bot (easy/normal/hard) |
| `pickResponse(game, playerId, difficulty)` | Decide pass/block/contest para resposta |
| `pickBlockResponse(difficulty, game, playerId)` | Decide se contesta bloqueio |
| `pickSnifferChoice(game, playerId, difficulty)` | Decide troca de carta do Sniffer |

### 7.3 `src/db.js`

| Função | Descrição |
|---|---|
| `init()` | Inicializa banco SQLite, cria tabelas, roda migrações |
| `registerPlayer(nick, password)` | Registra novo jogador com validação |
| `loginPlayer(nick, password)` | Autentica jogador |
| `changePassword(playerId, old, new)` | Altera senha com verificação |
| `adminResetPassword(targetId, newPassword)` | Reset de senha pelo admin |
| `getPlayer(id)` | Busca jogador por ID |
| `getAllPlayers()` | Lista todos os jogadores |
| `banPlayer(id, banned)` | Bane/desbane jogador |
| `deletePlayer(id)` | Remove jogador e dados associados |
| `getLeaderboard()` | Top 20 jogadores por vitórias |
| `recordWin(pid)` | Incrementa vitórias + jogos do vencedor |
| `recordGamePlayed(pids)` | Incrementa jogos para lista de IDs |
| `getPlayerHistory(playerId, limit)` | Histórico de partidas do jogador |
| `getStats()` | Estatísticas gerais (total jogadores, jogos, etc.) |
| `createRoom(hostId, maxPlayers, password)` | Cria sala com código único |
| `getRoom(roomId)` | Busca sala com lista de jogadores |
| `joinRoom(roomId, playerId, password)` | Entra na sala com validações |
| `leaveRoom(roomId, playerId)` | Sai da sala (transfere host se necessário) |
| `closeRoom(roomId)` | Fecha sala e remove jogadores |
| `saveGameResult(...)` | Salva resultado no histórico |

### 7.4 `server.js` — Funções Principais

| Função | Descrição |
|---|---|
| `broadcast(roomId, type, data, excludeId)` | Envia mensagem a todos os ws de uma sala |
| `broadcastGameState(roomId)` | Envia estado sanitizado a cada jogador da sala |
| `broadcastReveal(roomId, g)` | Envia notificação de carta revelada |
| `startTurnTimer(roomId, playerId, ms)` | Inicia timer do turno |
| `clearTurnTimer(roomId)` | Cancela timer do turno |
| `autoPassTurn(roomId, playerId)` | Executa ação automática ao expirar timer |
| `scheduleBotTick(roomId)` | Agenda próxima ação do bot (900ms delay) |
| `botRoomTick(roomId)` | Executa lógica do bot para todas as fases |
| `simTick(simId)` | Tick de simulação (todos bots) |
| `checkGameEnd(roomId, g)` | Verifica fim do jogo, salva estatísticas, limpa estado |
| `getActionLabel(type, targetId, g)` | Retorna label legível para notificação |
| `computePauseNeeded(g)` | Calcula votos necessários para pausa |
| `getGameCurrentPlayerId(g)` | Retorna ID do jogador do turno atual |

---

*Documento gerado automaticamente com base na análise do código-fonte do System Breach v4.*
