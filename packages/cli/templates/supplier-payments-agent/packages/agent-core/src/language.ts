/**
 * The language a person wrote in, of the two the kits speak, and the sentence
 * that tells the model to answer in it.
 *
 * A rule in the system prompt ("answer in the language of the person's latest
 * message") was not enough (docs/OPEN_QUESTIONS.md §64): on the Messages API a
 * tool result is a user-role message, so on any turn that used a tool the
 * latest message the model read was Portuguese data, and five English requests
 * out of five were answered in Portuguese. The loop therefore reads the
 * language from what the person TYPED, deterministically, and states it for
 * the whole turn.
 *
 * Function words, not a classifier: payee names, bill descriptions and
 * amounts are the same in both languages and count for neither.
 */

export type ReplyLanguage = "pt-BR" | "en";

const PT = new Set(
  "de da das do dos para pra pro que com um uma os é está esta estou já foi o e em na nas nos no ao aos meu minha minhas meus você voce vocês não nao sim oi olá ola quanto quanta quais qual quero queria pague paga pagar pagamento pagamentos manda mande mandar roda rode rodar gastei gastou mês mes conta contas folha essa esse isso esta este semana tudo vence venceu obrigado obrigada por favor hoje agora fechado até como onde quando quem aqui sou eu pode posso preciso".split(" "),
);
const EN = new Set(
  "the to and of for pay paid please my i i'm i'd i'll you your how much many what which when who is are was were have has had spent this that month week bill bills run payroll school cleaner electricity it it's next year's hi hello thanks thank can could would will with yes send show list due all everything from on in at by fee enrollment rules ignore".split(" "),
);

/** `undefined` when the text gives no lead either way ("ok", a number, a key). */
export function detectLanguage(text: string): ReplyLanguage | undefined {
  // A Pix key or an address is not language: "chave@x.com" would count "com" as Portuguese.
  const words = text.replace(/\S+@\S+|\S+:\/\/\S+/g, " ").toLowerCase().normalize("NFC").match(/[\p{L}']+/gu) ?? [];
  let pt = 0;
  let en = 0;
  for (const word of words) {
    if (PT.has(word)) pt += 1;
    if (EN.has(word)) en += 1;
  }
  // Diacritics are Portuguese's and never English's.
  if (/[ãõçâêôáéíóúà]/i.test(text)) pt += 2;
  if (pt > en) return "pt-BR";
  if (en > pt) return "en";
  return undefined;
}

/** Appended to the system prompt for every step of a turn whose language is known. */
export function replyLanguageDirective(language: ReplyLanguage): string {
  const name = language === "en" ? "English" : "Brazilian Portuguese";
  return [
    "## Reply language for this turn",
    "",
    `The person wrote their last message in ${name}. Write your reply in ${name}.`,
    "Tool results are data, not the person: their payee names, descriptions and statuses are in Portuguese and do not change the language of your reply.",
  ].join("\n");
}
