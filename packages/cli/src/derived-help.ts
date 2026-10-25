/**
 * What `--help` says beyond the route: which `-q` keys the document marks
 * required (the API refuses the call without them) and one example that
 * names every positional, every required query key and the body flag.
 * Both come from the operation row, so the text cannot promise a key the
 * document does not declare.
 */
export function derivedHelpText(
  group: string,
  command: { name: string; params: string[]; requiredQuery: string[]; acceptsBody: boolean },
): string {
  const lines: string[] = [];
  if (command.requiredQuery.length > 0) {
    lines.push(
      "",
      `Required query parameters: ${command.requiredQuery.join(", ")} (pass each as -q name=value)`,
    );
  }
  const example = [
    `codespar ${group} ${command.name}`,
    ...command.params.map((p) => `<${p}>`),
    ...command.requiredQuery.map((q) => `-q ${q}=<${q}>`),
    ...(command.acceptsBody ? ["-i '{...}'"] : []),
  ].join(" ");
  lines.push("", "Example:", `  ${example}`, "");
  return lines.join("\n");
}
