# SYSTEM BREACH — Deployment Guide

## Requisitos do Servidor
- Node.js 18+ (instale via: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash - && sudo apt-get install -y nodejs`)
- CyberPanel com OpenLiteSpeed ou Nginx com suporte a WebSocket

---

## 1. Upload dos Arquivos

Faça upload de toda a pasta `system-breach/` para seu servidor.
Sugestão de caminho: `/home/system-breach/`

```bash
# Via SSH, suba os arquivos e depois:
cd /home/system-breach
npm install
```

---

## 2. Rodar o Servidor

### Opção A: Simples (para testar)
```bash
node server.js
```

### Opção B: Com PM2 (recomendado — mantém rodando)
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

O servidor roda na **porta 3000** por padrão.
Para mudar: `PORT=8080 node server.js`

---

## 3. Configurar CyberPanel (Proxy Reverso)

Você precisa de um Virtual Host no CyberPanel apontando para o Node.js.

### No CyberPanel:
1. Vá em **Websites → List Websites**
2. Clique em **Manage** no seu domínio
3. Vá em **vHost Conf** (configuração do OpenLiteSpeed)

Adicione no arquivo de configuração do vHost:

```nginx
# Para OpenLiteSpeed (CyberPanel padrão)
extprocessor nodejs {
  type                    proxy
  address                 127.0.0.1:3000
  maxConns                100
  pcKeepAliveTimeout      60
  initTimeout             60
  retryTimeout            0
  respBuffer              0
}

context / {
  type                    proxy
  handler                 nodejs
  addDefaultCharset       off
}
```

### Ou se usar Nginx (alternativa):
```nginx
server {
    listen 80;
    server_name SEU_DOMINIO.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

> ⚠️ O suporte a **WebSocket** é ESSENCIAL. O header `Upgrade` deve ser passado!

---

## 4. HTTPS/SSL (recomendado)

No CyberPanel, use **SSL → Issue SSL** para emitir um certificado Let's Encrypt gratuito.

Com HTTPS, o jogo automaticamente usará `wss://` (WebSocket seguro).

---

## 5. Verificar se está funcionando

```bash
# Checar se o servidor está rodando
pm2 status

# Ver logs em tempo real
pm2 logs system-breach

# Testar a porta
curl http://localhost:3000
```

---

## 6. Estrutura de Arquivos

```
system-breach/
├── server.js          # Servidor principal (WebSocket + HTTP)
├── package.json       # Dependências
├── src/
│   ├── gameLogic.js   # Toda a lógica do jogo
│   └── db.js          # Banco de dados SQLite
├── public/
│   └── index.html     # Frontend completo
└── data/
    └── breach.db      # Banco SQLite (criado automaticamente)
```

---

## 7. Variáveis de Ambiente (opcional)

Crie um arquivo `.env` na raiz:
```
PORT=3000
```

---

## 8. O que fazer após copiar novos arquivos (atualização)

Sempre que fizer upload de novos arquivos ou fizer `git pull`, execute:

```bash
cd /home/jogar.aracn.games/public_html/system-breach
bash deploy.sh
```

**O script `deploy.sh` faz tudo automaticamente:**
1. `npm install` — instala/atualiza dependências
2. `pm2 restart system-breach` — reinicia o servidor (ou inicia se nunca foi iniciado)

> ⚠️ **IMPORTANTE:** Esquecer o `npm install` após uma atualização pode causar erros como `Cannot find module 'multer'` ou similares.

### Se o PM2 estiver em estado `stop`

```bash
cd /home/jogar.aracn.games/public_html/system-breach
bash deploy.sh
```

### Comandos individuais (caso o deploy.sh não funcione)

```bash
# 1. Instalar dependências
npm install

# 2. Reiniciar (se pm2 já conhece o processo)
pm2 restart system-breach

# OU iniciar do zero (primeira vez)
pm2 start ecosystem.config.js
pm2 save

# 3. Verificar se está rodando
pm2 status
pm2 logs system-breach --lines 30
```

---

## Problemas Comuns

**`Cannot find module 'X'` (ex: multer, bcryptjs, ws):**
```bash
cd /path/to/system-breach
bash deploy.sh
```

**WebSocket não conecta:**
- Certifique-se que o proxy reverso passa o header `Upgrade`
- Verifique se a porta 3000 não está bloqueada no firewall

**PM2 não inicia após reboot:**
```bash
pm2 startup
# Execute o comando que ele mostrar
pm2 save
```
