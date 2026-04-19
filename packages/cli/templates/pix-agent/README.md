# {{name}}

Pix payment agent scaffolded by `codespar init`.

## Setup

```bash
cp .env.example .env
# Fill in CODESPAR_API_KEY and OPENAI_API_KEY

npm install
npm run dev
```

## What it does

Creates a Pix charge on Asaas and sends the QR code to a customer's WhatsApp via Twilio. See `src/index.ts` for the agent loop.

## Learn more

- [Pix Payment Agent cookbook](https://codespar.dev/docs/cookbooks/pix-payment-agent)
- [OpenAI provider reference](https://codespar.dev/docs/providers/openai)
