# codespar Python SDK — examples

Runnable scripts demonstrating the CodeSpar Python SDK end-to-end.
Each file is standalone — just `pip install codespar`, set
`CODESPAR_API_KEY`, and run.

## Setup

```bash
pip install codespar
export CODESPAR_API_KEY="csk_live_..."  # get one at dashboard.codespar.dev
```

Optionally pin a specific project (staging, prod, etc.):

```bash
export CODESPAR_PROJECT_ID="prj_a1b2c3d4e5f6g7h8"
```

## Examples

| File | What it does | SDK surface |
|------|--------------|-------------|
| [`ecommerce_checkout.py`](./ecommerce_checkout.py) | Full Complete Loop: checkout → NF-e → ship → notify via WhatsApp | `send_stream`, typed events |
| [`pix_payment.py`](./pix_payment.py) | Create a Pix charge and notify the customer | `send`, `tool_calls` |
| [`proxy_execute.py`](./proxy_execute.py) | Raw HTTP proxy to a provider API with server-side auth injection | `proxy_execute` |
| [`connect_link.py`](./connect_link.py) | Generate an OAuth Connect Link for an end user | `authorize` |
| [`async_basic.py`](./async_basic.py) | Same flow using `AsyncCodeSpar` for FastAPI / asyncio stacks | `AsyncCodeSpar` |

## Running

```bash
python examples/ecommerce_checkout.py
```

All examples use `preset="brazilian"` by default. Change to
`mexican` / `argentinian` / `colombian` to run the LatAm-wide stack.
