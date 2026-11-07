/** A journey name made safe for a file or folder name on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in file names
  const s = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return s || '_';
}

/** Paths of a journey's generated files, relative to the output folder (always with `/`). */
export function journeyFiles(journey: string): { dir: string; sh: string; runbook: string; viewer: string } {
  const n = safeFileName(journey);
  return { dir: n, sh: `${n}/${n}.sh`, runbook: `${n}/${n}.runbook.md`, viewer: `${n}/${n}.html` };
}
