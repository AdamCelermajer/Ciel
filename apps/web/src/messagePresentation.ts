const standaloneImage = /^!\[[^\]]*\]\((?:<[^>]+>|[^)]+)\)\s*$/;
const heading = /^\s{0,3}#{1,6}\s+\S/;

export function presentAssistantText(text: string, hasStoredImages: boolean): string {
  let result = text;
  if (hasStoredImages) {
    const output: string[] = [];
    for (const line of result.split('\n')) {
      if (standaloneImage.test(line.trim())) {
        while (output.length && !output.at(-1)?.trim()) output.pop();
        if (output.length && heading.test(output.at(-1)!)) output.pop();
      } else output.push(line);
    }
    result = output.join('\n').trim();
  }
  const trimmed = result.trim();
  for (let index = trimmed.indexOf('\n\n'); index !== -1; index = trimmed.indexOf('\n\n', index + 2)) {
    if (trimmed.slice(0, index) === trimmed.slice(index + 2)) return trimmed.slice(0, index);
  }
  return result;
}
