// Test helpers shared by the worker tests: a scripted fetch and an in-memory KV.
export type Call = { url: string; init?: RequestInit };

export function scriptedFetch(answers: Array<unknown | Error>): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...answers];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected fetch ${String(input)}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function memoryKV(initial: Record<string, string> = {}): KVNamespace & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
  } as unknown as KVNamespace & { data: Map<string, string> };
}
