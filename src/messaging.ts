const SAFE_CHUNK_SIZE = 4000;

export function splitText(text: string): string[] {
  if (text.length <= SAFE_CHUNK_SIZE) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= SAFE_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    const candidate = remaining.slice(0, SAFE_CHUNK_SIZE);
    const newlinePos = candidate.lastIndexOf("\n");
    const spacePos = candidate.lastIndexOf(" ");
    let cut = newlinePos > 0 ? newlinePos : spacePos > 0 ? spacePos : SAFE_CHUNK_SIZE;
    if (/[\uD800-\uDBFF]/.test(remaining[cut - 1]!)) cut -= 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  return chunks;
}

export function commandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  return text.slice(1).split(/[\s@]/, 1)[0]?.toLowerCase();
}
