/**
 * `GET <url>` with `key` as the bearer token; resolves to the JSON body, or to undefined when the body is not
 * JSON. Throws with the HTTP status and the Refuseless error code and message (docs.refuseless.com/guides/errors)
 * when the response is not OK.
 */
export async function getJson(url: string, key: string, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}` }, signal });
  const body = (await response.json().catch(() => undefined)) as { error?: any } | undefined;
  if (!response.ok) {
    const reason = [body?.error?.code, body?.error?.message].filter(Boolean).join(": ");
    throw new Error(`GET ${url} failed with HTTP ${response.status}${reason ? ` (${reason})` : ""}`);
  }
  return body;
}
