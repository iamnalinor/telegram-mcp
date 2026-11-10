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

/** An OpenAI key in the message, if there is one. */
export function openaiKey(text: string): string | null {
  return /\bsk-(?:proj|svcacct)-[0-9A-Za-z_-]{20,400}/.exec(text)?.[0] ?? null;
}

/** An OpenAI webhook signing secret in the message, if there is one. */
export function webhookSecret(text: string): string | null {
  return /\bwhsec_[0-9A-Za-z+/=]{16,200}/.exec(text)?.[0] ?? null;
}
