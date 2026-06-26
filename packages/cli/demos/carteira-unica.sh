#!/usr/bin/env bash
#
# Carteira única — terminal demo (vibe payments).
#
# One agent. One signed mandate. A wallet that speaks BRL and USDC at the same
# time, with per-currency caps and NO FX. Drives the published @codespar/cli
# through the story so it records cleanly for a screen capture.
#
# Usage:
#   CODESPAR_API_KEY=csk_test_... CONSUMER=demo-carteira ./carteira-unica.sh
#
# Optional:
#   CLI="node ../dist/index.js"   # use a local build instead of npx
#   AGENT=ag_demo                 # agent id stamped on the mandate
#
set -euo pipefail

CLI="${CLI:-npx -y @codespar/cli@latest}"
KEY="${CODESPAR_API_KEY:?set CODESPAR_API_KEY (a csk_test_ key)}"
CONSUMER="${CONSUMER:-demo-carteira}"
AGENT="${AGENT:-ag_carteira_demo}"
PAYEES="https://x402.codespar.dev/api/market-data,11144477735"

run() { echo; echo "\$ $*"; eval "$*"; }
say() { echo; echo "# $*"; }
pause() { sleep "${PAUSE:-2}"; }

CLI_AUTH="$CLI --api-key $KEY"

say "Um agente. Um mandato assinado. Uma carteira multi-moeda — BRL e USDC — sem FX."
pause

say "1) Crio UM mandato com dois slots: Pix em BRL e USDC on-chain."
say "   Uma assinatura governa as duas moedas, cada uma com seu teto."
run "$CLI_AUTH mandate create \
  --consumer $CONSUMER --agent $AGENT --purpose 'carteira:demo' \
  --payee '$PAYEES' \
  --slot BRL:pix:50000:1500 \
  --slot USDC:usdc:100:100 \
  --pin-kind pix-key"
pause

say "2) A carteira, agregada por moeda. Saldos lado a lado, cada um na sua moeda."
run "$CLI_AUTH wallet $CONSUMER"
pause

say "3) Mover saldo entre os slots. BRL -> USDC NÃO é PTAX no teto:"
say "   é uma troca real no ramp da CodeSpar, no rate cotado de verdade."
run "$CLI_AUTH transfer $CONSUMER --from BRL --to USDC --amount 15000"
pause

say "É isso: a MESMA assinatura paga x402 em USDC e Pix em BRL, e rebalanceia"
say "entre os slots no rate real. Cap por moeda. Zero FX sintético. Vibe payments."
