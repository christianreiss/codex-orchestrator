import { ApiError, ServiceUnavailableError } from '../../http/errors.js';
import { UPSTREAM_REPOSITORY } from './contract.js';

const API = `https://api.github.com/repos/${UPSTREAM_REPOSITORY}`;
export function sensitiveText(text: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY|(?:password|api[_-]?key|secret|access[_-]?token)\s*[=:]\s*["']?[^\s"']{4,}|\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b|\/(?:home|Users)\/[^\s/]+|\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b|\b[\w.-]+\.(?:internal|local|lan)\b)/i.test(text);
}
export interface GithubIssue { number: number; title: string; body: string; state: string; html_url: string; comments?: unknown[] }
export class FeedbackGithub {
  constructor(private token: string | null, private request: typeof fetch = fetch, private signal?: AbortSignal) {}
  private async call<T>(url: string, body?: unknown): Promise<T> {
    if (!(url.startsWith(`${API}/`) || url.startsWith('https://api.github.com/search/issues?'))) throw new Error('Unsupported GitHub resource');
    const response = await this.request(url, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'codex-orchestrator-feedback',
        'x-github-api-version': '2022-11-28', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (body !== undefined && response.status >= 400 && response.status < 500 && response.status !== 408)
        throw new ApiError(`GitHub publication rejected (${response.status})`, { status: 503, code: 'github_publication_rejected' });
      throw new ServiceUnavailableError(`GitHub request failed (${response.status})`, response.status === 429 || response.status === 403 ? 'github_rate_or_access' : 'github_unavailable');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ServiceUnavailableError('GitHub returned no data', 'github_unavailable');
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new ServiceUnavailableError('GitHub response exceeded limit', 'github_incomplete');
        parts.push(value);
      }
    } finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
  }
  async head(): Promise<string> {
    const data = await this.call<{ sha: string }>(`${API}/commits/main`);
    if (!/^[a-f0-9]{40}$/.test(data.sha)) throw new ServiceUnavailableError('GitHub returned an invalid revision');
    return data.sha;
  }
  async isBehind(installed: string, upstream: string): Promise<boolean> {
    if (![installed, upstream].every((sha) => /^[a-f0-9]{40}$/.test(sha))) return false;
    const result = await this.call<{ status: string }>(`${API}/compare/${installed}...${upstream}`);
    return result.status === 'ahead';
  }
  async wrapperVersion(): Promise<string> {
    const data = await this.call<{ content: string; encoding: string }>(`${API}/contents/wrappers/Makefile?ref=main`);
    if (data.encoding !== 'base64') throw new ServiceUnavailableError('Wrapper version unavailable');
    const match = /^VERSION\s*[:?]?=\s*([^\s#]+)/m.exec(Buffer.from(data.content, 'base64').toString('utf8'));
    if (!match) throw new ServiceUnavailableError('Wrapper version unavailable');
    return match[1]!;
  }
  async search(query: string): Promise<GithubIssue[]> {
    if (sensitiveText(query)) throw new ServiceUnavailableError('Search contains private data', 'privacy_review_required');
    const matches: GithubIssue[] = [];
    for (let page = 1; page <= 5; page++) {
      const q = `repo:${UPSTREAM_REPOSITORY} is:issue ${query}`;
      const data = await this.call<{ incomplete_results: boolean; total_count: number; items: GithubIssue[] }>(
        `https://api.github.com/search/issues?${new URLSearchParams({ q, per_page: '100', page: String(page) })}`,
      );
      if (data.incomplete_results || data.total_count > 500 || !Array.isArray(data.items)) throw new ServiceUnavailableError('GitHub search incomplete', 'github_incomplete');
      matches.push(...data.items);
      if (matches.length >= data.total_count) return matches;
    }
    throw new ServiceUnavailableError('GitHub search incomplete', 'github_incomplete');
  }
  async context(issues: GithubIssue[]) {
    const result = [];
    for (const issue of issues.slice(0, 10)) {
      if ((issue.body?.length ?? 0) > 12000) throw new ServiceUnavailableError('Issue body exceeds review limit', 'github_incomplete');
      const [comments, timeline] = await Promise.all([
        this.call<Array<{ body: string; html_url: string }>>(`${API}/issues/${issue.number}/comments?per_page=100`),
        this.call<Array<{ event: string; commit_id?: string; source?: { issue?: { number: number; pull_request?: unknown } } }>>(`${API}/issues/${issue.number}/timeline?per_page=100`),
      ]);
      if (comments.length === 100 || timeline.length === 100) throw new ServiceUnavailableError('Issue history incomplete', 'github_incomplete');
      const fixes = [];
      for (const event of timeline) {
        if (event.commit_id && /^[a-f0-9]{40}$/.test(event.commit_id)) {
          fixes.push(await this.call(`${API}/commits/${event.commit_id}`));
        }
        const linked = event.source?.issue;
        if (linked?.pull_request && Number.isSafeInteger(linked.number)) fixes.push(await this.call(`${API}/pulls/${linked.number}`));
        if (fixes.length >= 5) break;
      }
      result.push({ ...issue, body: issue.body, comments, fixes });
    }
    return result;
  }
  async findMarker(marker: string, issueNumber: number | null): Promise<{ number: number; html_url: string } | null> {
    // Enumerate the author's repository issues/comments rather than relying on the search index.
    for (let page = 1; page <= 10; page++) {
      const rows = issueNumber
        ? await this.call<Array<{ body: string; html_url: string; number?: number }>>(`${API}/issues/${issueNumber}/comments?per_page=100&page=${page}`)
        : await this.call<Array<{ body: string; number: number; html_url: string }>>(`${API}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`);
      const match = rows.find((r) => r.body?.includes(marker));
      if (match) return { number: issueNumber ?? match.number!, html_url: match.html_url };
      if (rows.length < 100) return null;
    }
    throw new ServiceUnavailableError('Could not reconcile GitHub publication', 'github_incomplete');
  }
  async publish(title: string, body: string, issueNumber: number | null) {
    if (!this.token) throw new ServiceUnavailableError('Connect GitHub before publishing', 'github_not_connected');
    if (sensitiveText(`${title}\n${body}`)) throw new ServiceUnavailableError('Public report needs privacy review', 'privacy_review_required');
    const result = issueNumber
      ? await this.call<{ html_url: string; number?: number }>(`${API}/issues/${issueNumber}/comments`, { body })
      : await this.call<{ number: number; html_url: string }>(`${API}/issues`, { title, body });
    return { number: issueNumber ?? result.number!, html_url: result.html_url };
  }
}
