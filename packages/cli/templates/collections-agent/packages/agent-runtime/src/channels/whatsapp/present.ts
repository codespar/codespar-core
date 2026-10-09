/**
 * How a payable receivable is put into a conversation.
 *
 * It is here, and not inside the run loop, because two commands now present
 * one: the run that issues the charge, and the poll that comes back to it
 * later. A payer told how to pay by a poll must be told the same way as a
 * payer told by a run, and the only way to guarantee that is for both to
 * build the same messages from the same place.
 *
 * The shape is the point. The QR goes as an IMAGE and the copy-and-paste as
 * its OWN message underneath, because a code inside a picture cannot be
 * copied and a code inside a paragraph cannot be tapped.
 */
import { CORE_STRINGS, formatDay, type ChargeInstrument, type Execution, type Locale } from "@codespar/agent-core";
import type { OutboundBody } from "../types.js";

export function instrumentBodies(execution: Execution, instalment: number, chargeId: string, instrument: ChargeInstrument, currency: string, locale: Locale = "pt-BR"): OutboundBody[] {
  const text = CORE_STRINGS[locale];
  const money = new Intl.NumberFormat(locale === "en" ? "en-US" : "pt-BR", { style: "currency", currency });
  const item = execution.items[instalment - 1];
  const count = execution.items.length;
  const bodies: OutboundBody[] = [
    {
      kind: "text",
      text: [
        count > 1 ? text.instalmentOf(instalment, count) : "",
        item ? money.format(item.amount / 100) : "",
        instrument.due_date ? text.dueOn(formatDay(instrument.due_date, locale)) : "",
        text.chargeRef(chargeId),
      ].join(""),
    },
  ];
  if (instrument.pix_copy_paste) {
    bodies.push({ kind: "media", media: "qr", data: instrument.pix_copy_paste });
    bodies.push({ kind: "instrument", instrument: "pix_copy_paste", value: instrument.pix_copy_paste });
  }
  if (instrument.boleto_bank_line) {
    bodies.push({ kind: "text", text: text.boletoLine });
    bodies.push({ kind: "instrument", instrument: "boleto_bank_line", value: instrument.boleto_bank_line });
  }
  return bodies;
}

