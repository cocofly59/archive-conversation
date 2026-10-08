const PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style API key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["Stripe live key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credentials in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/i],
];

/** Names the kinds of likely secrets found in a text. Detection only: nothing is redacted. */
export function findSecrets(text: string): string[] {
  return PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
