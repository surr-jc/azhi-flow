/** Minimal HTTP client for the Azhi API, used by the CLI and workers. */
export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const err = new Error((data as { message?: string })?.message ?? `${method} ${path}: HTTP ${res.status}`) as Error & { status: number; body: unknown };
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data as T;
  }

  async raw(path: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  get = <T = unknown>(path: string) => this.request<T>('GET', path);
  post = <T = unknown>(path: string, body?: unknown) => this.request<T>('POST', path, body ?? {});
  put = <T = unknown>(path: string, body?: unknown) => this.request<T>('PUT', path, body ?? {});
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
