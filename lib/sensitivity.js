const PATTERNS = [
  { name: 'api_key', pattern: /(?:api[_-]?key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9_\-.]{20,}/i },
  { name: 'private_key', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/ },
  { name: 'env_var_leak', pattern: /^[A-Z_]{3,}=\S{10,}/m },
  { name: 'password', pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?\S{6,}/i },
  { name: 'connection_string', pattern: /(?:postgres|mysql|mongodb):\/\/\S+:\S+@/i },
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'webhook_url', pattern: /https:\/\/discord(?:app)?\.com\/api\/webhooks\//i },
  { name: 'ssh_key_path', pattern: /~\/\.ssh\/[a-zA-Z0-9_-]+/ },
  { name: 'gcp_service_account', pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
];

function scanMessage(text) {
  const flags = [];
  for (const { name, pattern } of PATTERNS) {
    if (pattern.test(text)) {
      flags.push(name);
    }
  }
  return flags;
}

module.exports = { scanMessage, PATTERNS };
