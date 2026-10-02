import assert from "node:assert/strict";
import test from "node:test";
import { redactWorkText } from "./work-log-redaction.js";

test("redacts credential assignments, bearer tokens, and known API key formats", () => {
  const secrets = ["ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890", "github_pat_" + "1234567890abcdefghijklmnop", "sk-proj-" + "abcdefghijklmnopqrstuvwxyz", "sk_live_" + "1234567890abcdefghij", "AKIA" + "1234567890ABCDEF", "xoxb-" + "123456789-abcdefghijk"];
  const text = [...secrets, "password=supersecret", 'api_key: "my-key-value"', "Authorization: Bearer abcd.efgh.ijkl"].join("\n");
  const redacted = redactWorkText(text);
  for (const secret of [...secrets, "supersecret", "my-key-value", "abcd.efgh.ijkl"]) assert.equal(redacted.includes(secret), false, secret);
  assert.ok(redacted.includes("[redacted]"));
});

test("drops URL credentials, query strings, and fragments while preserving useful path context", () => {
  assert.equal(redactWorkText("Inspect https://user:pass@example.com:8443/recovery?token=secret#anchor then continue."), "Inspect https://example.com:8443/recovery then continue.");
  assert.equal(redactWorkText("(http://example.com/path?q=secret)."), "(http://example.com/path).");
  assert.equal(redactWorkText("src/save.ts and tests/save.test.ts"), "src/save.ts and tests/save.test.ts");
});

test("redacts private key blocks and JWTs without exposing multiline material", () => {
  const text = "Before\n-----BEGIN RSA " + "PRIVATE KEY-----\nvery-secret-material\n-----END RSA PRIVATE KEY-----\nJWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmno\nAfter";
  const redacted = redactWorkText(text);
  assert.equal(redacted.includes("very-secret-material"), false);
  assert.equal(redacted.includes("eyJhbGci"), false);
  assert.ok(redacted.includes("Before"));
  assert.ok(redacted.includes("After"));
});

test("redacts environment variable credentials and non-http URL authentication", () => {
  const value = redactWorkText("OPENAI_API_KEY=plain-key-value AWS_SECRET_ACCESS_KEY=plain-secret-value\nDATABASE_URL=postgres://db-user:db-pass@db.example.com/project?sslmode=require#secret\nACCESS_TOKEN=plain-token-value");
  for (const secret of ["plain-key-value", "plain-secret-value", "db-user", "db-pass", "sslmode", "#secret", "plain-token-value"]) assert.equal(value.includes(secret), false, secret);
});

test("redacts quoted JSON credential keys including escaped and multiline quoted values", () => {
  const value = redactWorkText('{"password":"fixture-secret", "api_key": "fixture-key", "accessToken": "fixture-token", "description": "safe context"}\n{\n  "secret": "escaped\\\"credential",\n  "refresh_token": "multiline\ncredential"\n}');
  for (const secret of ["fixture-secret", "fixture-key", "fixture-token", "escaped", "credential", "multiline"]) assert.equal(value.includes(secret), false, secret);
  assert.ok(value.includes('"description": "safe context"'));
  assert.ok(value.includes('"password":"[redacted]"'));
  assert.ok(value.includes('"api_key": "[redacted]"'));
});

test("redacts single and double quoted environment credentials across lines", () => {
  const value = redactWorkText('export API_KEY="first\nsecond"\nPASSWORD=\'single-quoted-secret\'\nACCESS_TOKEN="escaped\\\"secret"\nNEXT_STEP="inspect src/save.ts"');
  for (const secret of ["first", "second", "single-quoted-secret", "escaped", "secret"]) assert.equal(value.includes(secret), false, secret);
  assert.ok(value.includes('NEXT_STEP="inspect src/save.ts"'));
});
