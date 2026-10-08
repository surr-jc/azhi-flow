/**
 * A Copilot token as pasted: surrounding quotes, a "Bearer " or "token " prefix and stray whitespace
 * (a wrapped line, a trailing newline) make Copilot answer "Authorization header is badly formatted".
 */
export function cleanCopilotToken(value: string): string {
  let v = value.trim().replace(/^(['"`])(.*)\1$/s, '$2').trim();
  v = v.replace(/^(?:authorization\s*:\s*)?(?:bearer|token)\s+/i, '');
  return v.replace(/\s+/g, '');
}
