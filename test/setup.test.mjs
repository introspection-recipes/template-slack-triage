import assert from "node:assert/strict";
import test from "node:test";

import {
  findBaseUrl,
  isMissingConnectorError,
  resolveReturnUrl,
} from "../scripts/setup.mjs";

test("findBaseUrl recognizes the current CLI cp_url field", () => {
  assert.equal(
    findBaseUrl({ cp_url: "https://api.staging.introspection.dev" }),
    "https://api.staging.introspection.dev",
  );
});

test("findBaseUrl retains compatibility with nested legacy fields", () => {
  assert.equal(
    findBaseUrl({ profile: { api_base_url: "https://api.introspection.dev" } }),
    "https://api.introspection.dev",
  );
});

test("missing connector responses are treated as first-run state", () => {
  assert.equal(
    isMissingConnectorError(
      "Error: no connector with slug `bug-intake-slack` in project `project-id`",
    ),
    true,
  );
  assert.equal(isMissingConnectorError("Error: connector not found"), true);
  assert.equal(isMissingConnectorError("Error: request failed with 404"), true);
});

test("unrelated connector errors remain fatal", () => {
  assert.equal(isMissingConnectorError("Error: request failed with 403 Forbidden"), false);
});

test("resolveReturnUrl maps hosted production and staging API URLs", () => {
  assert.equal(
    resolveReturnUrl("https://api.introspection.dev"),
    "https://platform.introspection.dev/",
  );
  assert.equal(
    resolveReturnUrl("https://api.staging.introspection.dev/v1"),
    "https://platform.staging.introspection.dev/",
  );
});

test("resolveReturnUrl accepts an explicit URL for custom deployments", () => {
  assert.equal(
    resolveReturnUrl("https://api.example.com", " https://console.example.com/integrations "),
    "https://console.example.com/integrations",
  );
});

test("resolveReturnUrl rejects an unknown deployment without an override", () => {
  assert.throws(
    () => resolveReturnUrl("https://api.example.com"),
    /set INTROSPECTION_RETURN_URL/,
  );
});
