import { describe, expect, it } from 'vitest';
import { splitQuoted } from '../../web/src/components/quoted.js';

describe('folding the quoted part of an email', () => {
  it('Gmail / Apple Mail "On … wrote:", including when it wraps onto two lines', () => {
    const t = 'Hi Chris,\n\nAttached are the reports.\n\nThanks,\nScott\n\nOn Wed, Nov 11, 2026, at 1:22 AM, Scott Feit wrote:\n> Need help with the IRS audit\n> thanks';
    expect(splitQuoted(t)).toEqual({ visible: 'Hi Chris,\n\nAttached are the reports.\n\nThanks,\nScott', quoted: 'On Wed, Nov 11, 2026, at 1:22 AM, Scott Feit wrote:\n> Need help with the IRS audit\n> thanks' });
    const wrapped = 'Sounds good.\n\nOn Wed, Nov 11, 2026 at 1:22 AM Scott Feit <\nscott@example.com> wrote:\n\n> earlier';
    expect(splitQuoted(wrapped).visible).toBe('Sounds good.');
  });

  it('Outlook headers and "Original Message"', () => {
    expect(splitQuoted('Done.\n\nFrom: Dana Lee <dana@x.com>\nSent: Monday, November 16, 2026 9:00 AM\nTo: Scott\nSubject: Q').visible).toBe('Done.');
    expect(splitQuoted('See below.\n-----Original Message-----\nFrom: x').visible).toBe('See below.');
    expect(splitQuoted('ok\n________________________________\nFrom: Pat\nSent: today').visible).toBe('ok');
  });

  it('a trailing run of "> " lines', () => {
    expect(splitQuoted('Yes, Friday works.\n\n> Can you do Friday?\n>\n> Dana')).toEqual({ visible: 'Yes, Friday works.', quoted: '> Can you do Friday?\n>\n> Dana' });
  });

  it('leaves alone: no quote, an inline "> " in the middle, a message that is only a forward, and "wrote" mid-sentence', () => {
    expect(splitQuoted('Plain message').quoted).toBeNull();
    expect(splitQuoted('Look:\n> a point\nMy answer is below the quote.').quoted).toBeNull();
    expect(splitQuoted('On Mon, Pat wrote:\n> hi').quoted).toBeNull(); // nothing would be left above it
    expect(splitQuoted('On Monday she wrote: the plan, which is fine.').quoted).toBeNull();
  });
});
