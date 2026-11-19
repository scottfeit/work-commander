import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { realPath } from './handoff.js';

/**
 * What a built-in Claude Code session may bring along (Settings → Claude Code), without loading any Claude Code settings file:
 * - CLAUDE.md instructions, read here and added to its system prompt (settings.json, hooks and permissions are never read);
 * - the skills the PU picked, copied into a private plugin made for the session, with anything that could pre-approve a
 *   tool or run code without asking taken out.
 */

const MAX_CLAUDE_MD = 60_000;
/** SKILL.md frontmatter that's kept; everything else (allowed-tools, hooks, …) is dropped. */
const SAFE_KEYS = new Set(['name', 'description', 'license', 'version', 'metadata', 'when_to_use', 'argument-hint', 'user-invocable', 'disable-model-invocation']);

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

/** Is this path somewhere WC never lets Claude Code read? (Symlinks resolved on both sides.) */
export function forbidden(p: string, off: string[]) {
  const abs = realPath(p);
  return off.some((o) => inside(abs, realPath(o)) || inside(path.resolve(p), path.resolve(o)));
}

/**
 * The CLAUDE.md instructions Claude Code would read for `folder`: the PU's own (~/.claude/CLAUDE.md), then each folder from the
 * home directory down to `folder` (CLAUDE.md, .claude/CLAUDE.md), then CLAUDE.local.md in the folder. "@path" imports are
 * followed (up to 3 deep) unless they point somewhere forbidden. Returns "" when there are none.
 */
export function readClaudeMd(folder: string, off: string[], home = os.homedir()): string {
  const files: string[] = [path.join(home, '.claude', 'CLAUDE.md')];
  const rel = path.relative(home, folder);
  const dirs = [home, ...(rel && !rel.startsWith('..') ? rel.split(path.sep).map((_, i, a) => path.join(home, ...a.slice(0, i + 1))) : [])];
  for (const d of dirs) files.push(path.join(d, 'CLAUDE.md'), path.join(d, '.claude', 'CLAUDE.md'));
  files.push(path.join(folder, 'CLAUDE.local.md'));
  const seen = new Set<string>();
  let total = 0;
  const realHome = realPath(home);
  const read = (file: string, depth: number): string => {
    const abs = realPath(file); // a symlink can't lead outside the home folder or into a forbidden one
    if (seen.has(abs) || forbidden(abs, off) || !inside(abs, realHome)) return '';
    seen.add(abs);
    let text: string;
    try {
      if (!fs.statSync(abs).isFile()) return '';
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return '';
    }
    if (total + text.length > MAX_CLAUDE_MD) text = text.slice(0, Math.max(0, MAX_CLAUDE_MD - total)) + '\n…(truncated)';
    total += text.length;
    if (depth >= 3) return text;
    // "@path/to/file" on its own (not in an email address or code span) imports that file
    return text.replace(/(^|\s)@((?:~|\.{1,2})?\/?[\w.\-/]+\.\w+)/g, (all, pre, p) => {
      const target = p.startsWith('~') ? path.join(home, p.slice(1)) : path.resolve(path.dirname(abs), p);
      const body = read(target, depth + 1);
      return body ? `${pre}\n<!-- imported ${p} -->\n${body}\n` : all;
    });
  };
  const parts = files.map((f) => ({ f, t: read(f, 0).trim() })).filter((x) => x.t);
  return parts.map((x) => `## ${path.relative(home, x.f) ? `~/${path.relative(home, x.f)}` : x.f}\n\n${x.t}`).join('\n\n');
}

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
  /** Where it came from: your own skills, or the project's. */
  from: 'user' | 'project';
}

function frontmatter(md: string): { data: Record<string, string>; head: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { data: {}, head: '', body: md };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { data, head: m[1], body: md.slice(m[0].length) };
}

/** Skills in a skills folder (each a directory with SKILL.md; ~/.claude/skills/synced is looked into too). */
export function listSkills(dir: string, from: SkillInfo['from']): SkillInfo[] {
  const out: SkillInfo[] = [];
  const scan = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sd = path.join(d, e.name);
      const md = path.join(sd, 'SKILL.md');
      if (fs.existsSync(md)) {
        const { data } = frontmatter(fs.readFileSync(md, 'utf8'));
        out.push({ name: data.name || e.name, description: data.description || '', dir: sd, from });
      } else if (depth === 0) scan(sd, 1);
    }
  };
  scan(dir, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export const userSkills = (home = os.homedir()) => listSkills(path.join(home, '.claude', 'skills'), 'user');

/** A skill's SKILL.md made safe: only harmless frontmatter kept, and inline shell commands (!`…`) replaced. */
export function sanitizeSkill(md: string) {
  const { head, body } = frontmatter(md);
  const kept: string[] = [];
  let keep = false;
  for (const line of head.split(/\r?\n/)) {
    const key = /^([\w-]+):/.exec(line)?.[1];
    if (key) keep = SAFE_KEYS.has(key);
    if (keep) kept.push(line);
  }
  const safeBody = body.replace(/!`[^`\n]*`/g, '[inline command removed by Work Commander]');
  return `${kept.length ? `---\n${kept.join('\n')}\n---\n` : ''}${safeBody}`;
}

const PLUGIN = 'wc-skills';

/**
 * A private plugin holding copies of the chosen skills (and nothing else: no hooks, no MCP servers, no commands).
 * Returns the plugin folder and the names to enable, or null when no skill applies.
 */
export function buildSkillsPlugin(skills: SkillInfo[], into: string): { path: string; names: string[] } | null {
  if (!skills.length) return null;
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(path.join(into, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(into, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'Skills Work Commander passes to Claude Code (copies; nothing that runs on its own).' }, null, 2));
  const names: string[] = [];
  const used = new Set<string>();
  for (const sk of skills) {
    let slug = sk.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'skill';
    while (used.has(slug)) slug += '-2';
    used.add(slug);
    const dest = path.join(into, 'skills', slug);
    fs.cpSync(sk.dir, dest, { recursive: true, dereference: false, filter: (src) => !/[/\\](hooks|\.mcp\.json|\.claude-plugin)([/\\]|$)/.test(src.slice(sk.dir.length)) });
    const md = path.join(dest, 'SKILL.md');
    fs.writeFileSync(md, sanitizeSkill(fs.readFileSync(md, 'utf8')).replace(/^(---\n[\s\S]*?)^name:.*$/m, `$1name: ${slug}`));
    names.push(`${PLUGIN}:${slug}`);
  }
  return { path: into, names };
}
