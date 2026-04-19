# {{name}}

End-to-end e-commerce checkout agent scaffolded by `codespar init`.

## Setup

```bash
cp .env.example .env
# Fill in CODESPAR_API_KEY and ANTHROPIC_API_KEY

npm install
npm run dev
```

## What it does

Handles the full Complete Loop: product discovery → checkout → invoice (NF-e) → shipping → WhatsApp notification. Uses Claude as the reasoning engine.

## Learn more

- [E-Commerce Checkout cookbook](https://codespar.dev/docs/cookbooks/ecommerce-checkout)
- [Claude provider reference](https://codespar.dev/docs/providers/claude)
