import { describe, expect, it } from 'vitest';
import { AtlassianCloud, textToAdf, textToWiki } from '../src/integrations/atlassian.js';

describe('backticks in Jira/JSM comments', () => {
  it('Jira: `word` is monospace, ```lines``` a code block, mentions still work', () => {
    const doc = textToAdf('Run `kubectl get pods` as @Dana\n\n```\nnpm ci\nnpm test\n```\nThen tell me.', [{ text: '@Dana', accountId: 'acc-d' }]);
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Run ' }, { type: 'text', text: 'kubectl get pods', marks: [{ type: 'code' }] }, { type: 'text', text: ' as ' }, { type: 'mention', attrs: { id: 'acc-d', text: '@Dana' } }] },
      { type: 'codeBlock', attrs: {}, content: [{ type: 'text', text: 'npm ci\nnpm test' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Then tell me.' }] },
    ]);
  });

  it('one-line ```fences```, lone backticks and plain text', () => {
    expect(textToAdf('see ```ls -la```').content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'see ' }] },
      { type: 'codeBlock', attrs: {}, content: [{ type: 'text', text: 'ls -la' }] },
    ]);
    expect(textToAdf("it's a ` alone").content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: "it's a ` alone" }] }]);
    expect(textToAdf('a\nb').content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }]);
  });

  it('JSM: `word` becomes {{word}}, ```lines``` a {code} block', () => {
    expect(textToWiki('Restart `nginx` please:\n```\nsudo systemctl restart nginx\n```\nThanks')).toBe('Restart {{nginx}} please:\n{code}\nsudo systemctl restart nginx\n{code}\nThanks');
    expect(textToWiki('no code here')).toBe('no code here');
  });

  it('comments are sent formatted (Jira as ADF, JSM as wiki text)', async () => {
    const bodies: any[] = [];
    const f = (async (url: string, init: any) => {
      if (url.includes('/myself')) return new Response(JSON.stringify({ accountId: 'me' }));
      bodies.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: '1' }));
    }) as any;
    const at = new AtlassianCloud('https://acme.atlassian.net', 'me@x.com', 't', f);
    await at.comment({ key: 'HR-1', body: 'Use `vpn-2`', public: true, flavor: 'jsm' });
    await at.comment({ key: 'IT-1', body: 'Use `vpn-2`', public: true, flavor: 'jira' });
    expect(bodies[0].body.body).toBe('Use {{vpn-2}}');
    expect(bodies[1].body.body.content[0].content[1]).toEqual({ type: 'text', text: 'vpn-2', marks: [{ type: 'code' }] });
  });
});
