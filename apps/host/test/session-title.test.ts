import { describe, expect, it } from 'vitest';
import { titleFromPrompt } from '../src/session-title.js';

describe('automatic session titles', () => {
  it('uses the first actionable line after an intro', () => {
    expect(titleFromPrompt('Hi!\n\nMy request:\n- Fix the project picker so I can choose a folder\n- Improve session names')).toBe('Fix the project picker so I can choose a folder');
  });
  it('keeps a short prompt intact and caps long titles at a word boundary', () => {
    expect(titleFromPrompt('first')).toBe('first');
    expect(titleFromPrompt('Please build a dashboard that shows every active project and lets me inspect recent sessions without opening each project')).toBe('Please build a dashboard that shows every active project and');
  });
});
