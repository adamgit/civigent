export type FetchCall = {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
};

export type InstalledFetchMock = {
  calls: FetchCall[];
  restore: () => void;
};

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function textResponse(text: string, init: ResponseInit = {}): Response {
  return new Response(text, {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: init.headers,
  });
}

export function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): InstalledFetchMock {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ input, init });
    return handler(input, init);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export function installQueuedFetchMock(
  responses: Array<Response | ((call: FetchCall) => Promise<Response>)>,
): InstalledFetchMock {
  let index = 0;
  return installFetchMock(async (input, init) => {
    if (index >= responses.length) {
      throw new Error("No queued fetch response available.");
    }
    const current = responses[index];
    index += 1;
    if (typeof current === "function") {
      return current({ input, init });
    }
    return current;
  });
}
