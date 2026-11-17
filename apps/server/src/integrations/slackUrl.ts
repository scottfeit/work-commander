/** A link that opens a Slack message in the app or browser: `<workspace>/archives/<channel>/p<ts without the dot>`. */
export const slackMessageUrl = (base: string, channel: string, ts: string) => `${base.replace(/\/+$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;

/** The workspace address (`https://team.slack.com`) a Slack link belongs to, or null if it isn't one. */
export function slackBaseOf(url?: string | null): string | null {
  try {
    const u = new URL(url ?? '');
    return /(^|\.)slack\.com$/i.test(u.hostname) ? u.origin : null;
  } catch {
    return null;
  }
}
