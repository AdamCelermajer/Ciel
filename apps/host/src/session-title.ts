const genericLine = /^(?:hi|hello|hey|thanks|thank you|my request|request|context|background|instructions?|task|please help|can you help)[.!: ]*$/i;
const actionWord = /\b(?:add|adding|build|change|create|debug|design|fix|implement|improve|make|move|need|remove|rename|replace|review|set up|show|simplify|update|want|write)\b/i;

export function titleFromPrompt(prompt: string): string {
  const lines = prompt.split(/\r?\n/).map(line => line
    .replace(/^\s*(?:#{1,6}\s*|[-*+]\s+|\d+[.)\\]\s*)/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ').trim())
    .filter(line => line && !genericLine.test(line) && !/^https?:\/\//i.test(line) && !/^<image\b/i.test(line));
  const line = lines.find(candidate => actionWord.test(candidate)) || lines[0] || 'Untitled session';
  const sentence = line.split(/(?<=[.!?])\s+(?=[A-Z])/u, 1)[0]!.replace(/^["'“”‘’\s]+|["'“”‘’:;,.!?\s]+$/g, '');
  const words = sentence.split(/\s+/).filter(Boolean);
  let title = words.slice(0, 11).join(' ');
  if (title.length > 64) title = title.slice(0, 65).replace(/\s+\S*$/, '');
  return title || 'Untitled session';
}
