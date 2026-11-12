import { Fragment, type ReactNode } from 'react';

// "[https://… wrapped\nacross lines]" (plain-text emails), Slack's "<https://…|label>", and bare http(s) URLs.
const LINK = /\[(https?:\/\/[^\]]+)\]|<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>|(https?:\/\/[^\s<>"'\]]+)/g;

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** Text with its web links made clickable (opening in a new tab). Built from React nodes, never raw HTML. */
export function Linkified({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) out.push(<Fragment key={n++}>{text.slice(last, at)}</Fragment>);
    if (m[1]) {
      // A long URL the sender's mail client wrapped inside brackets: the link is the pieces joined back together.
      out.push(
        <Fragment key={n++}>
          [<A href={m[1].replace(/\s+/g, '')}>{m[1]}</A>]
        </Fragment>,
      );
    } else if (m[2]) {
      out.push(
        <A key={n++} href={m[2]}>
          {m[3] || m[2]}
        </A>,
      );
    } else {
      // Trailing punctuation belongs to the sentence, not the link.
      const url = m[4].replace(/[.,;:!?)]+$/, '');
      out.push(
        <Fragment key={n++}>
          <A href={url}>{url}</A>
          {m[4].slice(url.length)}
        </Fragment>,
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={n++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}
