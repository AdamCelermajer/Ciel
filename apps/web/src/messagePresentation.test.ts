import { describe, expect, it } from 'vitest';
import { presentAssistantText } from './messagePresentation';

describe('assistant message presentation', () => {
  it('collapses an exact repeated reply already saved in a session', () => {
    expect(presentAssistantText('Hi! What would you like to work on?\n\nHi! What would you like to work on?', false)).toBe('Hi! What would you like to work on?');
  });
  it('hides a local markdown image and its label when the image is already attached', () => {
    const text = 'A short story.\n\n### Couverture\n\n![Illustration](</home/user/generated image.png>)';
    expect(presentAssistantText(text, true)).toBe('A short story.');
  });
  it('keeps different paragraphs and ordinary text', () => {
    expect(presentAssistantText('First paragraph.\n\nSecond paragraph.', false)).toBe('First paragraph.\n\nSecond paragraph.');
  });
});
