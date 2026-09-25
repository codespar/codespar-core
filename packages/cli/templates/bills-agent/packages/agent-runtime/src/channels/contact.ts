/**
 * How a contact is written down.
 *
 * A conversation log travels: it goes in the proof bundle, and the bundle is
 * the thing somebody sends to somebody else. The person's number is not part
 * of what a bundle has to prove, so it never reaches one in the clear.
 */

/** `+5511987654321` -> `+55 11 ****4321`. What the console and the bundle see. */
export function maskContact(contact: string): string {
  if (!contact.startsWith("+") || contact.length < 8) return "***";
  return `${contact.slice(0, 5)} ****${contact.slice(-4)}`;
}
