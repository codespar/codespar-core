import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compositionHash, GuardrailsSchema, itemsHash, type ExecutionItem } from "@codespar/agent-core";
import { checkOrder, EnvelopeSchema, loadEnvelope, priceCart, type PricedCart } from "../src/pricing.js";

const AGENT_DIR = resolve(import.meta.dirname, "..");
const guardrails = GuardrailsSchema.parse(JSON.parse(readFileSync(resolve(AGENT_DIR, "guardrails.json"), "utf8")));
const envelope = loadEnvelope(guardrails);
const TODAY = "2026-09-23";
const AFTERNOON = new Date("2026-09-23T18:00:00Z"); // 15:00 in Sao Paulo
const TZ = "America/Sao_Paulo";

const codes = (cart: PricedCart) => cart.validation_issues.map((i) => i.code);
const order = (cart: PricedCart, over: Partial<ExecutionItem> = {}) => {
  const items: ExecutionItem[] = [{ beneficiary: "Marina Costa", payee: "27548613008", amount: cart.total, currency: "BRL", due_date: TODAY, ...over }];
  return { items, total: items.reduce((s, i) => s + i.amount, 0), composition: { ref: "run/cart-1", composition_hash: cart.cart_hash, line_count: cart.composition.length } };
};

describe("checkout §2: the cart the code prices", () => {
  it("the totals are the catalog's: lines priced, subtotal, discount and total computed, not taken", () => {
    const cart = priceCart({ lines: [{ sku: "pacote-10-aulas", quantity: 1 }, { sku: "avaliacao-inicial", quantity: 1 }] }, envelope, TODAY);
    expect(cart.validation_issues).toEqual([]);
    expect(cart.total).toBe(47990);
    expect(cart.line_items.map((l) => [l.sku, l.quantity, l.unit_amount])).toEqual([["pacote-10-aulas", 1, 39000], ["avaliacao-inicial", 1, 8990]]);
    expect(cart.totals.find((t) => t.type === "total")?.amount).toBe(47990);
  });

  it("a line that carries a price is refused whole (price_not_caller_input), whatever the field is called", () => {
    for (const field of ["price", "unit_price", "amount_minor", "total", "preco"]) {
      const cart = priceCart({ lines: [{ sku: "avaliacao-inicial", quantity: 1, [field]: 1000 }] }, envelope, TODAY);
      expect(codes(cart)).toEqual(["price_not_caller_input"]);
      expect(cart.line_items).toEqual([]);
      expect(cart.total).toBe(0);
    }
  });

  it("the closed vocabulary: each code for its case, and a bad line is left out rather than guessed", () => {
    expect(codes(priceCart({ lines: [{ sku: "guitarra", quantity: 1 }] }, envelope, TODAY))).toEqual(["sku_unknown"]);
    expect(codes(priceCart({ lines: [{ sku: "masterclass-producao", quantity: 1 }] }, envelope, TODAY))).toEqual(["item_unavailable"]);
    for (const q of [0, -1, 1.5, 11, "2"]) expect(codes(priceCart({ lines: [{ sku: "aula-avulsa", quantity: q }] }, envelope, TODAY))).toEqual(["quantity_invalid"]);
    expect(codes(priceCart({ lines: [{ sku: "ingresso-recital", quantity: 5 }] }, envelope, TODAY))).toEqual(["quantity_above_stock"]);
    expect(codes(priceCart({ lines: [{ sku: "aula-avulsa", quantity: 1 }], coupon: "PRIMEIRACOMPRA30" }, envelope, TODAY))).toEqual(["coupon_unknown"]);
    expect(codes(priceCart({ lines: [{ sku: "aula-avulsa", quantity: 1 }], coupon: "BEMVINDO10" }, envelope, TODAY))).toEqual(["coupon_not_applicable"]);
    expect(codes(priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }], coupon: "BEMVINDO10" }, envelope, "2027-01-01"))).toEqual(["coupon_not_applicable"]);
    const mixed = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }, { sku: "guitarra", quantity: 1 }] }, envelope, TODAY);
    expect(codes(mixed)).toEqual(["sku_unknown"]);
    expect(mixed.total).toBe(20000);
  });

  it("an unknown coupon prices the cart with NO discount, never an equivalent one", () => {
    const cart = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }], coupon: "PRIMEIRACOMPRA30" }, envelope, TODAY);
    expect(cart.coupon).toBeNull();
    expect(cart.order_discounts).toEqual([]);
    expect(cart.total).toBe(20000);
  });

  it("a coupon in the table applies its own percentage and becomes a line of the composition", () => {
    const cart = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }], coupon: "bemvindo10" }, envelope, TODAY);
    expect(cart.coupon).toBe("BEMVINDO10");
    expect(cart.total).toBe(18000);
    expect(cart.composition.at(-1)).toMatchObject({ ref: "coupon:BEMVINDO10", amount: -2000 });
  });

  it("cart_hash is compositionHash over the resolved lines: it moves with quantity, SKU and order, and the same total can hash differently", () => {
    const two = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }] }, envelope, TODAY);
    const one = priceCart({ lines: [{ sku: "consultoria-1h", quantity: 1 }] }, envelope, TODAY);
    expect(two.total).toBe(one.total);
    expect(two.cart_hash).not.toBe(one.cart_hash);
    expect(two.cart_hash).toBe(compositionHash(two.composition));
    // The order's single item is the same in both: this is the case items_hash cannot see.
    const item = (c: PricedCart): ExecutionItem => ({ beneficiary: "Marina Costa", payee: "27548613008", amount: c.total, currency: "BRL", due_date: TODAY });
    expect(itemsHash([item(two)])).toBe(itemsHash([item(one)]));
    const ab = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 1 }, { sku: "avaliacao-inicial", quantity: 1 }] }, envelope, TODAY);
    const ba = priceCart({ lines: [{ sku: "avaliacao-inicial", quantity: 1 }, { sku: "aula-avulsa", quantity: 1 }] }, envelope, TODAY);
    expect(ab.cart_hash).not.toBe(ba.cart_hash);
  });

  it("the envelope schema is strict: an extra key is a load error, not a key ignored", () => {
    expect(() => EnvelopeSchema.parse({ ...envelope, free_shipping: true })).toThrow();
  });
});

describe("checkout §3.3, §5: the gate the core runs at every gate", () => {
  const ok = priceCart({ lines: [{ sku: "pacote-10-aulas", quantity: 1 }, { sku: "avaliacao-inicial", quantity: 1 }] }, envelope, TODAY);

  it("passes an order that is the cart, at list price, inside the hours, due today", () => {
    expect(checkOrder(order(ok), ok, envelope, AFTERNOON, TZ)).toBeUndefined();
  });

  it("refuses the discount that would reach an injected price (checkout §5.1), and never names the ceiling", () => {
    const injected = priceCart({ lines: [{ sku: "avaliacao-inicial", quantity: 1, discount_pct: 88.88 }] }, envelope, TODAY);
    expect(injected.total).toBe(1000);
    const verdict = checkOrder(order(injected), injected, envelope, AFTERNOON, TZ);
    expect(verdict?.reason).toBe("outside_envelope");
    expect(verdict?.detail).not.toMatch(/12|%/);
  });

  it("refuses a line under the margin floor even inside the discount ceiling, without quoting a cost", () => {
    // The package costs 300,00 to deliver: 5% off (370,50) is inside the 12% ceiling and below the 20% margin floor.
    const thin = priceCart({ lines: [{ sku: "pacote-10-aulas", quantity: 1, discount_pct: 5 }] }, envelope, TODAY);
    const verdict = checkOrder(order(thin), thin, envelope, AFTERNOON, TZ);
    expect(verdict?.detail).toContain("piso de margem");
    expect(verdict?.detail).not.toMatch(/300|3\.000|30000/);
    const fine = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2, discount_pct: 10 }] }, envelope, TODAY);
    expect(checkOrder(order(fine), fine, envelope, AFTERNOON, TZ)).toBeUndefined();
  });

  it("refuses a negotiated order discount above its ceiling, and a coupon stacked on a negotiated one", () => {
    const over = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }], order_discount_pct: 9 }, envelope, TODAY);
    expect(checkOrder(order(over), over, envelope, AFTERNOON, TZ)?.reason).toBe("outside_envelope");
    const stacked = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }], coupon: "BEMVINDO10", order_discount_pct: 2 }, envelope, TODAY);
    expect(checkOrder(order(stacked), stacked, envelope, AFTERNOON, TZ)?.detail).toContain("nao se somam");
    const coupon = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 2 }], coupon: "BEMVINDO10" }, envelope, TODAY);
    expect(checkOrder(order(coupon), coupon, envelope, AFTERNOON, TZ)).toBeUndefined();
  });

  it("refuses an order that is not the current cart, a total that is not the cart's, and a missing cart", () => {
    const changed = priceCart({ lines: [{ sku: "aula-avulsa", quantity: 5 }] }, envelope, TODAY);
    expect(checkOrder(order(ok), changed, envelope, AFTERNOON, TZ)?.detail).toContain("carrinho mudou");
    expect(checkOrder({ ...order(ok), total: 100, items: [{ ...order(ok).items[0]!, amount: 100 }] }, ok, envelope, AFTERNOON, TZ)?.reason).toBe("outside_envelope");
    expect(checkOrder(order(ok), undefined, envelope, AFTERNOON, TZ)?.reason).toBe("outside_envelope");
    const { composition: _c, ...bare } = order(ok);
    expect(checkOrder(bare, ok, envelope, AFTERNOON, TZ)?.detail).toContain("nasce de um carrinho");
  });

  it("refuses outside the service hours in either mode (outside_hours), and a due date outside the window", () => {
    expect(checkOrder(order(ok), ok, envelope, new Date("2026-09-23T23:30:00Z"), TZ)?.reason).toBe("outside_hours");
    expect(checkOrder(order(ok, { due_date: "2026-09-22" }), ok, envelope, AFTERNOON, TZ)?.reason).toBe("outside_envelope");
    expect(checkOrder(order(ok, { due_date: "2026-09-27" }), ok, envelope, AFTERNOON, TZ)?.reason).toBe("outside_envelope");
    expect(checkOrder(order(ok, { due_date: "2026-09-26" }), ok, envelope, AFTERNOON, TZ)).toBeUndefined();
  });

  it("refuses an order above the ticket ceiling", () => {
    const big = priceCart({ lines: [{ sku: "pacote-10-aulas", quantity: 6 }] }, envelope, TODAY);
    expect(checkOrder(order(big), big, envelope, AFTERNOON, TZ)?.detail).toContain("ticket maximo");
  });
});
