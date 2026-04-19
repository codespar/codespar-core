# {{name}}

Multi-tenant SaaS commerce agent scaffolded by `codespar init`.

## Setup

```bash
cp .env.example .env
# Fill in CODESPAR_API_KEY and OPENAI_API_KEY

npm install
npm run dev
# → http://localhost:3000
```

## What it does

One codespar API key, N tenants. Each tenant has its own session, servers, and credentials. Every tool call is tagged with `metadata.tenant_id` for per-tenant billing.

Try it:

```bash
curl -X POST http://localhost:3000/api/commerce/tenant_acme \
  -H "Content-Type: application/json" \
  -d '{"message":"Create a Pix charge of R$50"}'
```

## Learn more

- [Multi-Tenant Agent cookbook](https://codespar.dev/docs/cookbooks/multi-tenant)
- [Sessions reference](https://codespar.dev/docs/concepts/sessions)
