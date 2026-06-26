# Demo: a carteira única do agente (vibe payments)

Roteiro de ~40s pra screen capture / thread. Driver: [`carteira-unica.sh`](./carteira-unica.sh).

## A ideia em uma frase

Um agente segura **um mandato assinado** que é uma **carteira multi-moeda**:
paga **x402 em USDC** e **Pix em BRL** com a mesma assinatura, com **teto por
moeda** e **sem FX**. E pode **mover saldo entre os slots** no rate real do rail.

## O que mostrar (terminal)

1. **Um mandato, dois slots.** `codespar mandate create --slot BRL:pix:... --slot USDC:usdc:...`
   Uma assinatura governa as duas moedas. Não são dois mandatos, é um só. O agente
   fala `pix` / `usdc` (o método); o provider (BaaS) fica escondido por baixo.
2. **A carteira por moeda.** `codespar wallet <consumer>` mostra BRL e USDC lado a
   lado, cada saldo na sua moeda. Nada de "total convertido" que envelhece.
3. **Mover entre slots.** `codespar transfer <consumer> --from BRL --to USDC --amount 15000`
   O plano diz: `route: onramp`, `converts: yes — via unblockpay at the real rate
   (no FX)`. O ponto: BRL→USDC **não** é PTAX no teto — é uma troca real no rail,
   no rate cotado. O cap continua por moeda.

## A fala (3 beats)

- **Hook:** "Agente pagando API em dólar e Pix em real, com a mesma assinatura."
- **Too-small-to-be-real:** "Um mandato. Dois slots. Sem FX. Move entre eles no rate real."
- **Prova:** roda no terminal, ao vivo, contra a API de produção.

## Por que isso é diferente

- **Sem FX sintético:** cap e saldo são por moeda. Um gasto USDC bate no teto
  USDC; um Pix BRL bate no teto BRL. Conversão só acontece quando você move de
  propósito, e aí é o rate real do rail (não um PTAX que escorrega).
- **Uma assinatura, multi-rail:** x402/USDC + Pix/BRL, roteados pelo formato do
  payee. Uma trava governa tudo. O agente vê `pix` / `usdc` (o método); o
  provider (Celcoin, CDP, ou amanhã licença própria) é trocável por baixo e nunca
  aparece — a CodeSpar é a camada de Pix/USDC.
- **Roda de verdade:** `npx @codespar/cli@latest`. A transfer é provada em
  execução ponta-a-ponta (o débito Celcoin paga o copia-e-cola do onramp; o
  crédito USDC liquida async). Liquidação real fecha com rails no mesmo ambiente.

## Notas de gravação

- Use uma chave `csk_test_` e um consumer dedicado (`CONSUMER=demo-carteira`).
- `PAUSE=3 ./carteira-unica.sh` deixa a leitura mais confortável no vídeo.
- O passo 3 sem `--execute` é só o PLANO (não move dinheiro) — ideal pra gravar.
  Com `--execute` move dinheiro de sandbox; a liquidação Pix de fato pede prod.
