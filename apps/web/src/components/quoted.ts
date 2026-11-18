/**
 * Where the earlier, quoted part of an email starts ("On Wed, Nov 11, 2026, at 1:22 AM, Scott Feit wrote:", Outlook's
 * "From: … Sent: …" header, "-----Original Message-----", or a closing run of "> " lines). Returns the text before it and
 * the quoted part, or no quoted part when there's none (or nothing would be left above it).
 */
export function splitQuoted(text: string): { visible: string; quoted: string | null } {
  const marks = [
    /^[ \t]*On\b[^\n]{0,300}?(?:\n[^\n]{0,200}?)?\bwrote:[ \t]*$/m, // Gmail / Apple Mail (may wrap onto a second line)
    /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
    /^[ \t]*-{2,}[ \t]*Forwarded message[ \t]*-{2,}/im,
    /^[ \t]*_{8,}[ \t]*\n[ \t]*From:/m, // Outlook rule then header
    /^[ \t]*From:[^\n]+\n[ \t]*(?:Sent|Date):[^\n]+\n/m, // Outlook header
    /^[ \t]*Le [^\n]{0,200}a écrit[ \t]*:[ \t]*$/m,
    /^[ \t]*Am [^\n]{0,200}schrieb[^\n]*:[ \t]*$/m,
  ];
  let at = -1;
  for (const re of marks) {
    const m = re.exec(text);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  // a trailing block of "> " lines (with blank lines between) with nothing after it
  const tail = /(?:^|\n)((?:>[^\n]*\n?|[ \t]*\n)*>[^\n]*\s*)$/.exec(text);
  if (tail) {
    const i = tail.index + (tail[0].startsWith('\n') ? 1 : 0);
    if (at < 0 || i < at) at = i;
  }
  if (at <= 0) return { visible: text, quoted: null };
  const visible = text.slice(0, at).replace(/\s+$/, '');
  if (!visible.trim()) return { visible: text, quoted: null }; // a bare forward: show it all
  return { visible, quoted: text.slice(at).replace(/^\s+/, '') };
}

/** Elements mail programs wrap the quoted, earlier messages in. For the Outlook ones, everything after them is quoted too. */
const BLOCKS = ['.gmail_quote_container', '.gmail_quote', 'blockquote[type="cite"]', '.yahoo_quoted', '#mail-editor-reference-message-container'];
const FROM_HERE = ['#divRplyFwdMsg', 'div[id^="appendonsend"]', 'div[id*="divRplyFwdMsg"]'];

/** The email's HTML with its quoted part folded into a closed <details> ("▸ Earlier messages"). Works without scripts. */
export function collapseQuotedHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const wrap = (nodes: Node[]) => {
    const d = doc.createElement('details');
    d.className = 'wc-quoted';
    const s = doc.createElement('summary');
    s.textContent = 'Earlier messages';
    d.appendChild(s);
    nodes[0].parentNode!.insertBefore(d, nodes[0]);
    for (const n of nodes) d.appendChild(n);
  };
  const block = doc.body.querySelector(BLOCKS.join(','));
  const from = doc.body.querySelector(FROM_HERE.join(','));
  const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const pick = block && from ? (before(block, from) ? 'block' : 'from') : block ? 'block' : from ? 'from' : null;
  if (!pick) return html;
  if (pick === 'block') wrap([block!]);
  else {
    const nodes: Node[] = [];
    for (let n: Node | null = from; n; n = n.nextSibling) nodes.push(n);
    // an Outlook <hr> just before the header belongs with it
    const prev = from!.previousElementSibling;
    if (prev?.tagName === 'HR') nodes.unshift(prev);
    wrap(nodes);
  }
  // nothing left to read above it: leave the email as it was
  const visibleText = [...doc.body.childNodes].filter((n) => !(n instanceof Element && n.classList.contains('wc-quoted'))).map((n) => n.textContent ?? '').join('').trim();
  if (!visibleText) return html;
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
