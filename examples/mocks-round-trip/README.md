# mocks-round-trip

Standalone demo of the hosted test-mode `mocks` field on `cs.create`. Runs a small Asaas flow against `api.codespar.dev` (or a self-hosted OSS runtime via `CODESPAR_BASE_URL`) using mock fixtures instead of calling the real provider — no network egress to Asaas, no test customer left behind in their sandbox.

## What it shows

- A **static mock** (`asaas/create_customer`) that returns the same object on every call.
- A **stateful mock** (`asaas/create_payment`) — an array of objects consumed in order. The third call drains the list and returns `mocks_exhausted`; the example uses the `isMocksExhausted` guard to branch on it.
- The error path when an API key isn't authorized for mocks (`mocks_not_authorized`).

A matching Python version is at [`packages/python/examples/mocks_round_trip.py`](../../packages/python/examples/mocks_round_trip.py).

## Run

```bash
cd examples/mocks-round-trip
npm install

export CODESPAR_API_KEY=csk_test_xxxxxxxxxxxxx  # test-environment key
# Optional: target a local OSS runtime
# export CODESPAR_BASE_URL=http://localhost:8000

npm run demo
```

## Expected output

```
customer: { id: 'cus_test', name: 'Demo Buyer', cpfCnpj: '11144477735' }
payment 1: { id: 'pay_1', status: 'PENDING', value: 100 }
payment 2: { id: 'pay_1', status: 'RECEIVED', value: 100 }
payment 3 drained the list: stateful mock list exhausted
```

(The exact `mocks_exhausted` message comes from the backend.)
