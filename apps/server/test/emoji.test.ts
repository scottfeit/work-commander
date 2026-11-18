import { describe, expect, it } from 'vitest';
import { emojiChar, standardEmoji } from '../src/core/emoji.js';
import { reactionsOf } from '../src/integrations/slack.js';

describe('Slack emoji', () => {
  it('the standard set uses Slack\'s names, with aliases, in picker order, without skin-tone swatches', () => {
    const all = standardEmoji();
    expect(all.length).toBeGreaterThan(1500);
    const up = all.find((e) => e.n === '+1')!;
    expect(up).toMatchObject({ c: '👍', a: ['thumbsup'], cat: 'People & Body' });
    expect(all[0].cat).toBe('Smileys & Emotion');
    expect(all.some((e) => e.cat === 'Component')).toBe(false);
    expect(emojiChar('thumbsup')).toBe('👍');
    expect(emojiChar('white_check_mark')).toBe('✅');
    expect(emojiChar('+1::skin-tone-3')).toBe('👍');
    expect(emojiChar('partyparrot')).toBeNull();
  });

  it('reactions on a message: count, and whether one is the PU\'s', () => {
    expect(reactionsOf({ reactions: [{ name: 'eyes', count: 2, users: ['U1', 'UME'] }, { name: 'tada', users: ['U2'] }] }, 'UME')).toEqual({
      reactions: [
        { name: 'eyes', count: 2, mine: true },
        { name: 'tada', count: 1, mine: false },
      ],
    });
    expect(reactionsOf({}, 'UME')).toEqual({});
  });
});
