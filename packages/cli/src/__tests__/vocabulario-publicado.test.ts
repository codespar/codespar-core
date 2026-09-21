/**
 * O que a CLI aceita tem de ser o que a meta-tool PUBLICA.
 *
 * ## O que aconteceu
 *
 * `ledger.ts` trazia `["entry", "balance", "account"]` escrito à mão. O
 * `codespar_ledger` publica cinco ações (`meta-tool-definitions.ts`), e as
 * duas de fora, `receipt` e `receipts`, eram recusadas pela CLI antes de
 * qualquer requisição sair. A mesma ferramenta respondia por
 * `codespar tool codespar_ledger --action receipt`, porque esse caminho lê o
 * vocabulário publicado em vez de uma cópia. `charge.ts` tem a irmã mais
 * silenciosa do defeito: não valida `method` contra lista nenhuma, mas a
 * mensagem de recusa nomeia três dos quatro métodos publicados, então quem
 * lê a mensagem conclui que `wallet` não existe.
 *
 * ## A regra que estes testes fixam
 *
 * A lista vive num lugar só, o pacote `@codespar/types`, e a CLI a LÊ. Um
 * `enum` que cresce lá passa a valer aqui sem ninguém editar a CLI, que é o
 * desenho que `meta-tool.ts` já usava.
 *
 * ⚠️ CONTROLE POSITIVO. Aceitar tudo também faria os casos de aceitação
 * passarem, então cada metade tem o seu par: uma ação FORA do vocabulário
 * continua recusada, e a recusa nomeia a lista publicada.
 */

import { describe, expect, it } from "vitest";
import { validateLedgerArgs } from "../commands/ledger.js";
import { validateChargeArgs } from "../commands/charge.js";
import { metaToolActions, metaToolEnum } from "../surface.js";

describe("o vocabulário vem do pacote publicado", () => {
  it("`ledger` aceita toda ação que o codespar_ledger publica", () => {
    const publicadas = metaToolActions("codespar_ledger");
    expect(publicadas.length).toBeGreaterThan(3);

    // Ações como `balance` e `account` exigem campos próprios, e isso é
    // legítimo. O defeito era outro: a ação ser recusada por ser
    // DESCONHECIDA. Nenhuma publicada pode cair nessa recusa.
    const desconhecidas = publicadas.filter((action) => {
      try {
        validateLedgerArgs({ action });
        return false;
      } catch (err) {
        return /must be one of/.test((err as Error).message);
      }
    });

    expect(desconhecidas).toEqual([]);
  });

  it("`ledger` continua recusando ação que ninguém publicou", () => {
    expect(() => validateLedgerArgs({ action: "apagar-tudo" })).toThrow(/apagar-tudo|one of/);
  });

  it("a recusa do `ledger` nomeia a lista publicada, não uma cópia", () => {
    const publicadas = metaToolActions("codespar_ledger");
    let mensagem = "";
    try {
      validateLedgerArgs({ action: "" });
    } catch (err) {
      mensagem = (err as Error).message;
    }
    for (const action of publicadas) expect(mensagem).toContain(action);
  });

  it("a recusa do `charge` nomeia todos os métodos publicados", () => {
    const metodos = metaToolEnum("codespar_charge", "method");
    expect(metodos.length).toBeGreaterThan(3);

    let mensagem = "";
    try {
      validateChargeArgs({ amount: 1, currency: "BRL", buyer: { name: "x" }, description: "x" });
    } catch (err) {
      mensagem = (err as Error).message;
    }
    for (const metodo of metodos) expect(mensagem).toContain(metodo);
  });
});
