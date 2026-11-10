/**
 * API keys that can start sessions or spend money on someone's account:
 * Anthropic's (`sk-ant-…`, routine tokens too), OpenAI's project and
 * service-account keys (`sk-proj-…`, `sk-svcacct-…`) and webhook signing
 * secrets (`whsec_…`). Whoever pastes one into a chat the bot sees — by
 * mistake, in a quote, in a reply — it is never written to the database.
 *
 * The patterns stay narrow: a bare `sk-` would take ordinary words apart.
 */

const KEY =
  /sk-ant-[0-9A-Za-z_-]{10,}|\bsk-(?:proj|svcacct)-[0-9A-Za-z_-]{20,}|\bwhsec_[0-9A-Za-z+/=]{16,}/g;

export function holdsSecret(text: string | null | undefined): boolean {
  KEY.lastIndex = 0;
  return !!text && KEY.test(text);
}

export function redactSecrets(text: string): string;
export function redactSecrets(text: string | null): string | null;
export function redactSecrets(text: string | null): string | null {
  return text === null ? null : text.replace(KEY, "[key removed]");
}

/**
 * What an API's error may echo back — a bearer token, any `sk-…` key, a
 * signing secret — removed before it is logged or shown. Wider than
 * `redactSecrets`: this is for the API's words, not people's.
 */
export function redactCredentials(text: string): string {
  return redactSecrets(text)
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [removed]")
    .replace(/\bsk-[0-9A-Za-z_*.-]{8,}/g, "[key removed]")
    .replace(/\bwhsec_[0-9A-Za-z+/=]+/g, "[key removed]");
}

/** A key longer than any OpenAI issues: a paste gone wrong, refused whole rather than cut short. */
export const TOO_LONG = Symbol("too long");

/** An OpenAI key in the message, if there is one. */
export function openaiKey(text: string): string | typeof TOO_LONG | null {
  const key = /\bsk-(?:proj|svcacct)-[0-9A-Za-z_-]{20,}/.exec(text)?.[0] ?? null;
  return key && key.length > 400 ? TOO_LONG : key;
}

/** An OpenAI webhook signing secret in the message, if there is one. */
export function webhookSecret(text: string): string | typeof TOO_LONG | null {
  const secret = /\bwhsec_[0-9A-Za-z+/=]{16,}/.exec(text)?.[0] ?? null;
  return secret && secret.length > 200 ? TOO_LONG : secret;
}
