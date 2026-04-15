// src/agent/security/secret-detector.ts
// YUAN Coding Agent — Secret Detection & Redaction
//
// Scans tool outputs for API keys, passwords, tokens, and other secrets.
// Redacts matches before they reach SSE streams or DB logs.

/** A detected secret with location info */
export interface SecretMatch {
  pattern: string;
  label: string;
  index: number;
  length: number;
  redacted: string;
}

/** Detection result */
export interface DetectionResult {
  hasSecrets: boolean;
  matches: SecretMatch[];
  /** The input text with all secrets redacted */
  redacted: string;
}

/**
 * Secret patterns — regex + human label.
 * Each pattern captures the full secret value to be redacted.
 */
const SECRET_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  // AWS
  { regex: /AKIA[0-9A-Z]{16}/g, label: "AWS Access Key" },
  { regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/g, label: "AWS Secret Key" },

  // GitHub / GitLab
  { regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/g, label: "GitHub Token" },
  { regex: /glpat-[A-Za-z0-9\-_]{20,}/g, label: "GitLab Token" },

  // Generic API keys (common prefixes)
  { regex: /sk-[A-Za-z0-9]{20,}/g, label: "API Secret Key (sk-)" },
  { regex: /sk-ant-[A-Za-z0-9\-]{20,}/g, label: "Anthropic API Key" },
  { regex: /xoxb-[0-9]{10,}-[A-Za-z0-9]+/g, label: "Slack Bot Token" },
  { regex: /xoxp-[0-9]{10,}-[A-Za-z0-9]+/g, label: "Slack User Token" },

  // YUA platform keys
  { regex: /yua_sk_[a-f0-9]{48}/g, label: "YUA API Key" },

  // Google
  { regex: /AIza[0-9A-Za-z\-_]{35}/g, label: "Google API Key" },

  // Stripe
  { regex: /sk_live_[0-9a-zA-Z]{24,}/g, label: "Stripe Secret Key" },
  { regex: /rk_live_[0-9a-zA-Z]{24,}/g, label: "Stripe Restricted Key" },

  // Toss Payments
  { regex: /sk_test_[A-Za-z0-9]{20,}/g, label: "Toss Test Secret Key" },
  { regex: /sk_live_[A-Za-z0-9]{20,}/g, label: "Toss Live Secret Key" },

  // JWT / Bearer tokens (long base64 strings)
  { regex: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, label: "JWT Token" },

  // Private keys (PEM)
  { regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, label: "Private Key (PEM)" },

  // Generic password patterns in config files
  { regex: /(?:password|passwd|pwd)\s*[=:]\s*["']([^"'\s]{8,})["']/gi, label: "Password in Config" },

  // Database connection strings
  { regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s"']+:[^\s"'@]+@[^\s"']+/g, label: "Database Connection String" },

  // .env style secrets (KEY=value where value looks like a secret)
  { regex: /(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|AUTH)_?[A-Z_]*\s*=\s*["']?([A-Za-z0-9/+=_\-]{20,})["']?/gi, label: "Environment Variable Secret" },
];

/**
 * Scan text for secrets and return detection result with redacted version.
 */
export function detectSecrets(text: string): DetectionResult {
  if (!text || text.length === 0) {
    return { hasSecrets: false, matches: [], redacted: text };
  }

  const matches: SecretMatch[] = [];

  for (const { regex, label } of SECRET_PATTERNS) {
    // Reset regex state (global flag)
    regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0];
      // Use capture group if available, else full match
      const secretValue = match[1] ?? fullMatch;

      matches.push({
        pattern: regex.source.slice(0, 40),
        label,
        index: match.index,
        length: fullMatch.length,
        redacted: `[REDACTED:${label}]`,
      });
    }
  }

  if (matches.length === 0) {
    return { hasSecrets: false, matches: [], redacted: text };
  }

  // Sort by index descending so we can replace from end to start without shifting indices
  matches.sort((a, b) => b.index - a.index);

  let redacted = text;
  for (const m of matches) {
    redacted =
      redacted.slice(0, m.index) +
      m.redacted +
      redacted.slice(m.index + m.length);
  }

  // Re-sort ascending for the return value
  matches.sort((a, b) => a.index - b.index);

  return { hasSecrets: true, matches, redacted };
}

/**
 * Quick check — returns true if text likely contains secrets.
 * Faster than full detection (short-circuits on first match).
 */
export function hasSecrets(text: string): boolean {
  if (!text || text.length === 0) return false;

  for (const { regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}

/**
 * Redact secrets from text (convenience wrapper).
 */
export function redactSecrets(text: string): string {
  return detectSecrets(text).redacted;
}
