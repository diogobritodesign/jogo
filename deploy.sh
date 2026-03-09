#!/bin/bash
# Script de deploy/atualização do System Breach
# Uso: bash deploy.sh
set -e
trap 'echo "❌ Erro na linha $LINENO. Verifique o log acima."' ERR

APP_NAME="system-breach"

echo "==> Instalando/atualizando dependências..."
npm install

echo "==> Reiniciando servidor com PM2..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  pm2 restart "$APP_NAME"
else
  pm2 start ecosystem.config.js
  pm2 save
fi

echo "==> Pronto! Status:"
pm2 status
