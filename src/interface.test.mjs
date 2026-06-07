import assert from "node:assert/strict";
import test from "node:test";
import { assertionResults, buildRequest, jsonPath, reportContents, requestToCurl } from "./interface.ts";

const row = (name, value, enabled = true) => ({ id: Math.random(), name, value, enabled });
const request = (overrides = {}) => ({
  method: "POST",
  url: "https://{{host}}/users",
  params: [row("page", "{{page}}")],
  headers: [row("X-Token", "{{token}}"), row("X-Disabled", "{{missing}}", false)],
  body: "{{body}}",
  bodyMode: "json",
  formRows: [],
  multipartRows: [],
  binaryFile: "",
  authType: "bearer",
  authFields: { token: "{{token}}" },
  ...overrides,
});

test("shared builder filters disabled rows and resolves auth", () => {
  const built = buildRequest(request(), { host: "example.test", page: "2", token: "secret", body: "{}" });
  assert.equal(built.url, "https://example.test/users?page=2");
  assert.equal(built.headers.find((header) => header.name === "Authorization")?.value, "Bearer secret");
  assert.equal(built.headers.some((header) => header.name === "X-Disabled"), false);
});

test("cURL includes multipart files and text fields", () => {
  const built = buildRequest(request({
    bodyMode: "multipart",
    authType: "none",
    multipartRows: [
      { ...row("label", "{{body}}"), kind: "text" },
      { ...row("upload", "/tmp/file.bin"), kind: "file" },
    ],
  }), { host: "example.test", page: "1", token: "secret", body: "value" });
  const curl = requestToCurl("POST", built);
  assert.match(curl, /-F 'label=value'/);
  assert.match(curl, /-F 'upload=@\/tmp\/file.bin'/);
});

test("assertions and JSON paths support array indexes", () => {
  assert.equal(jsonPath({ items: [{ id: 42 }] }, "$.items[0].id"), 42);
  const results = assertionResults([{
    id: "array", kind: "json-path", operator: "equals", target: "$.items[0].id", expected: "42", enabled: true,
  }], { status: 200, elapsed_ms: 5, headers: [], body: '{"items":[{"id":42}]}' });
  assert.equal(results[0].passed, true);
});

test("JUnit report escapes XML attributes", () => {
  const xml = reportContents({
    collection: 'A & "B"',
    elapsed_ms: 5,
    failed: 1,
    items: [{ name: "<request>", elapsed_ms: 5, error: "'failed'", tests: [] }],
  }, "junit");
  assert.match(xml, /&amp;/);
  assert.match(xml, /&quot;/);
  assert.match(xml, /&lt;request&gt;/);
  assert.match(xml, /&apos;failed&apos;/);
});
