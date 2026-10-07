/** Pure command quoting shared by config conversion and browser JSON import. */
export function quoteCommandArg(value: string): string {
  if (!/[\s"]/.test(value)) return value
  const bs = String.fromCharCode(92)
  return '"' + value.replaceAll(bs, bs.repeat(2)).replaceAll('"', bs + '"') + '"'
}

export function commandLine(command: string, args: unknown[] = [], executable = true): string {
  return [executable ? quoteCommandArg(command) : command, ...args.map((arg) => quoteCommandArg(String(arg)))].join(' ')
}
