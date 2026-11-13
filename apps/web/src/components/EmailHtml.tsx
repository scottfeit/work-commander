import { useRef, useState } from 'react';

/**
 * An email's original HTML in a locked-down frame: no scripts (sandbox + CSP), no forms, no remote content until the PU
 * asks for it (remote images double as tracking pixels). Links open in a new tab.
 */
export function buildEmailDoc(html: string, remoteImages: boolean) {
  const clean = html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(refresh|content-security-policy)[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const img = remoteImages ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src ${img}`;
  return (
    `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    `<style>html{background:#fff;color:#202124}body{margin:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>` +
    clean
  );
}

/** Whether the HTML refers to anything off the page, i.e. whether "Load images" would change what shows. */
export const hasRemoteContent = (html: string) => /(?:src|background)\s*=\s*["']?\s*https?:|url\(\s*["']?\s*https?:/i.test(html);

export function EmailHtml({ html }: { html: string }) {
  const [images, setImages] = useState(false);
  const ref = useRef<HTMLIFrameElement>(null);
  const fit = () => {
    const doc = ref.current?.contentDocument;
    if (doc?.documentElement) ref.current!.style.height = `${Math.min(doc.documentElement.scrollHeight + 2, 5000)}px`;
  };
  return (
    <div className="email-html">
      {!images && hasRemoteContent(html) && (
        <div className="email-html-bar muted small">
          Remote images are blocked.{' '}
          <button className="link" onClick={() => setImages(true)}>
            Load images
          </button>{' '}
          (the sender may see that you opened it)
        </div>
      )}
      <iframe
        ref={ref}
        title="Email"
        sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        srcDoc={buildEmailDoc(html, images)}
        onLoad={() => {
          fit();
          setTimeout(fit, 400);
        }}
      />
    </div>
  );
}
