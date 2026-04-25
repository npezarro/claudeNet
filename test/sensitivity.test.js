const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scanMessage, PATTERNS } = require('../lib/sensitivity');

describe('PATTERNS', () => {
  it('exports a non-empty array of named patterns', () => {
    assert.ok(Array.isArray(PATTERNS));
    assert.ok(PATTERNS.length > 0);
    for (const p of PATTERNS) {
      assert.ok(p.name, 'each pattern has a name');
      assert.ok(p.pattern instanceof RegExp, 'each pattern is a RegExp');
    }
  });
});

describe('scanMessage', () => {
  it('returns empty array for clean text', () => {
    assert.deepStrictEqual(scanMessage('Hello, how are you?'), []);
    assert.deepStrictEqual(scanMessage('This is a normal message about architecture patterns'), []);
  });

  it('detects api_key pattern', () => {
    const flags = scanMessage('api_key = "sk_test_abcdefghij1234567890"');
    assert.ok(flags.includes('api_key'));
  });

  it('detects api-key with hyphen separator', () => {
    const flags = scanMessage('api-key: ABCDEFGHIJKLMNOPQRST');
    assert.ok(flags.includes('api_key'));
  });

  it('detects token assignment', () => {
    const flags = scanMessage('token = "abcdefghijklmnopqrstuvwxyz"');
    assert.ok(flags.includes('api_key'));
  });

  it('detects secret assignment', () => {
    const flags = scanMessage('secret: abc123def456ghi789jkl012');
    assert.ok(flags.includes('api_key'));
  });

  it('detects bearer_token', () => {
    const flags = scanMessage('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test');
    assert.ok(flags.includes('bearer_token'));
  });

  it('detects private_key header', () => {
    const flags = scanMessage('-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBg...');
    assert.ok(flags.includes('private_key'));
  });

  it('detects RSA private key header', () => {
    const flags = scanMessage('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...');
    assert.ok(flags.includes('private_key'));
  });

  it('detects env_var_leak', () => {
    const flags = scanMessage('DATABASE_URL=postgres://user:pass@host/db');
    assert.ok(flags.includes('env_var_leak'));
  });

  it('detects password assignment', () => {
    const flags = scanMessage('password: mySecretPass123');
    assert.ok(flags.includes('password'));
  });

  it('detects passwd assignment', () => {
    const flags = scanMessage('passwd = "hunter2abc"');
    assert.ok(flags.includes('password'));
  });

  it('detects connection_string (postgres)', () => {
    const flags = scanMessage('postgres://admin:s3cret@db.example.com:5432/mydb');
    assert.ok(flags.includes('connection_string'));
  });

  it('detects connection_string (mongodb)', () => {
    const flags = scanMessage('mongodb://user:pass@cluster0.example.net/test');
    assert.ok(flags.includes('connection_string'));
  });

  it('detects aws_key', () => {
    const flags = scanMessage('AKIAIOSFODNN7EXAMPLE');
    assert.ok(flags.includes('aws_key'));
  });

  it('detects webhook_url (discord)', () => {
    const flags = scanMessage('https://discord.com/api/webhooks/123456/abcdef');
    assert.ok(flags.includes('webhook_url'));
  });

  it('detects webhook_url (discordapp)', () => {
    const flags = scanMessage('https://discordapp.com/api/webhooks/123456/abcdef');
    assert.ok(flags.includes('webhook_url'));
  });

  it('detects ssh_key_path', () => {
    const flags = scanMessage('Use ~/.ssh/id_rsa for authentication');
    assert.ok(flags.includes('ssh_key_path'));
  });

  it('detects gcp_service_account', () => {
    const flags = scanMessage('GOCSPX-abcdefghijklmnopqrstuvwxyz');
    assert.ok(flags.includes('gcp_service_account'));
  });

  it('returns multiple flags when text contains multiple sensitive patterns', () => {
    const text = 'password: hunter2abc\nBearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc';
    const flags = scanMessage(text);
    assert.ok(flags.includes('password'));
    assert.ok(flags.includes('bearer_token'));
    assert.ok(flags.length >= 2);
  });

  it('does not flag short strings that look similar', () => {
    // API key pattern requires 20+ chars after assignment
    assert.deepStrictEqual(scanMessage('token = "short"'), []);
  });

  it('does not flag generic text about passwords', () => {
    // "password" alone without assignment shouldn't flag
    assert.deepStrictEqual(scanMessage('I forgot my password'), []);
  });
});
