#!/usr/bin/env node
// TODO(slack-hosted-mcp): once the platform's Slack MCP grant leg ships
// (introspection-cloud docs/design/slack-hosted-mcp.md, spike S1), add the
// second Slack credential here alongside `bindLinear` — either a supplied
// static secret or the OAuth leg, whichever the spike selects.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const recipeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(recipeRoot, "slack-app", "manifest.template.json");
const statePath = resolve(recipeRoot, ".slack", "setup.json");
const runtime = process.env.INTROSPECTION_RUNTIME?.trim() || "slack-linear-bug-intake";
const environment = process.env.INTROSPECTION_ENVIRONMENT?.trim() || "production";
const connectorSlug = process.env.SLACK_CONNECTOR_SLUG?.trim() || "bug-intake-slack";

function botName() {
  const value = process.env.SLACK_BOT_NAME?.trim() || "Introspection";
  if (value.length > 35 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("SLACK_BOT_NAME must be 1-35 display characters without control characters");
  }
  return value;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function command(program, args, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new Error(`${program} ${args.join(" ")} failed (${code})${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

async function introspection(args, options) {
  const response = await command(
    "introspection",
    ["--output", "json", "--non-interactive", ...args],
    options,
  );
  if (response.code !== 0 || !response.stdout) return { ...response, value: null };
  try {
    return { ...response, value: JSON.parse(response.stdout) };
  } catch {
    throw new Error(`introspection returned non-JSON output: ${response.stdout.slice(0, 500)}`);
  }
}

export function findBaseUrl(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of ["cp_url", "api_base_url", "base_url", "url"]) {
    if (typeof value[key] === "string" && /^https?:\/\//.test(value[key])) return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = findBaseUrl(nested);
    if (found) return found;
  }
  return null;
}

export function isMissingConnectorError(stderr) {
  return /(\b404\b|not found|no connector with slug)/i.test(stderr);
}

export function resolveReturnUrl(baseUrl, explicitReturnUrl) {
  const candidate = explicitReturnUrl?.trim();
  if (candidate) {
    const url = new URL(candidate);
    if (!/^https?:$/.test(url.protocol)) {
      throw new Error("INTROSPECTION_RETURN_URL must use http or https");
    }
    return url.toString();
  }

  const url = new URL(baseUrl);
  if (url.hostname === "api.introspection.dev"
    || (url.hostname.startsWith("api.") && url.hostname.endsWith(".introspection.dev"))) {
    url.hostname = `platform.${url.hostname.slice(4)}`;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  throw new Error(
    "Could not determine where to return after connector authorization; set INTROSPECTION_RETURN_URL",
  );
}

function objectId(value, label) {
  const id = value?.id ?? value?.connector?.id ?? value?.record?.id;
  if (typeof id !== "string" || !id) throw new Error(`${label} response did not contain an id`);
  return id;
}

export function runtimeListHasEntries(value) {
  if (Array.isArray(value)) return value.length > 0;
  for (const key of ["items", "data", "runtimes"]) {
    if (Array.isArray(value?.[key])) return value[key].length > 0;
  }
  return false;
}

export function renderManifest(template, { redirectUrl, eventsRequestUrl, name = "Introspection" }) {
  const rendered = template.replaceAll("${SLACK_OAUTH_REDIRECT_URL}", redirectUrl)
    .replaceAll("${SLACK_EVENTS_REQUEST_URL}", eventsRequestUrl || "https://example.invalid/slack/events");
  const manifest = JSON.parse(rendered);
  manifest.display_information.name = name;
  manifest.features.bot_user.display_name = name;
  if (!eventsRequestUrl) delete manifest.settings.event_subscriptions;
  return manifest;
}

async function slack(method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${required("SLACK_APP_CONFIG_TOKEN")}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const details = Array.isArray(payload.errors)
      ? `: ${payload.errors.map((item) => item.message).join("; ")}`
      : "";
    throw new Error(`${method} failed (${payload.error ?? response.status})${details}`);
  }
  return payload;
}

async function existingState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function saveState(value) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function bindLinear() {
  required("LINEAR_API_KEY");
  const scope = ["--runtime", runtime, "--environment", environment];
  await introspection([
    "bindings", "credentials", "create",
    "--name", "LINEAR_API_KEY",
    "--from-env", "LINEAR_API_KEY",
    ...scope,
  ]);
  await introspection([
    "bindings", "mcp", "connect",
    "--mcp-server-id", "linear",
    "--endpoint-url", "https://mcp.linear.app/mcp",
    "--header", "Authorization=Bearer ${LINEAR_API_KEY}",
    ...scope,
  ]);
}

async function ensureRuntime() {
  const existing = await introspection(
    ["runtimes", "list", "--runtime", runtime],
    { allowFailure: true },
  );
  if (existing.code !== 0) {
    throw new Error(`Could not check for runtime ${runtime}: ${existing.stderr}`);
  }
  if (!runtimeListHasEntries(existing.value)) {
    await introspection(["runtimes", "create"]);
  }
}

async function setupSlack(baseUrl, returnUrl) {
  const template = await readFile(manifestPath, "utf8");
  const name = botName();
  const redirectUrl = new URL("/v1/oauth/connections/callback", baseUrl).toString();
  const connectorLookup = await introspection(
    ["connectors", "get", connectorSlug],
    { allowFailure: true },
  );
  if (connectorLookup.code !== 0 && !isMissingConnectorError(connectorLookup.stderr)) {
    throw new Error(`Could not check for an existing Slack connector: ${connectorLookup.stderr}`);
  }
  const saved = await existingState();
  let connector = connectorLookup.value;
  let appId = process.env.SLACK_APP_ID?.trim() || saved?.app_id || null;

  if (!connector) {
    const bootstrap = renderManifest(template, { redirectUrl, eventsRequestUrl: null, name });
    let credentials = saved?.bootstrap_credentials;
    if (!appId || !credentials?.client_id || !credentials?.client_secret || !credentials?.signing_secret) {
      await slack("apps.manifest.validate", { manifest: bootstrap });
      const createdApp = await slack("apps.manifest.create", { manifest: bootstrap });
      appId = createdApp.app_id;
      credentials = createdApp.credentials;
      if (appId && credentials) {
        await saveState({ app_id: appId, bootstrap_credentials: credentials });
      }
    }
    if (!appId || !credentials?.client_id || !credentials?.client_secret || !credentials?.signing_secret) {
      throw new Error("Slack did not return the app credentials needed to create the connector");
    }
    const botScopes = bootstrap.oauth_config.scopes.bot;
    const createArgs = [
      "connectors", "create",
      "--name", name,
      "--slug", connectorSlug,
      "--provider", "slack",
      "--auth-mode", "oauth-stored",
      "--environment", environment,
      "--client-id", credentials.client_id,
      "--client-secret", credentials.client_secret,
      "--signing-secret", credentials.signing_secret,
      "--authorization-endpoint", "https://slack.com/oauth/v2/authorize",
      "--token-endpoint", "https://slack.com/api/oauth.v2.access",
    ];
    for (const scope of botScopes) createArgs.push("--scope", scope);
    connector = (await introspection(createArgs)).value;
  }

  if (!appId) {
    throw new Error(
      `Connector ${connectorSlug} already exists. Set SLACK_APP_ID to its Slack app id, or delete the old connector before creating a replacement app.`,
    );
  }
  const connectorId = objectId(connector, "Connector");
  const eventsRequestUrl = new URL(`/v1/webhooks/slack/${connectorId}`, baseUrl).toString();
  const manifest = renderManifest(template, { redirectUrl, eventsRequestUrl, name });
  await slack("apps.manifest.validate", { manifest });
  const updated = await slack("apps.manifest.update", { app_id: appId, manifest });
  await introspection([
    "connectors", "update", connectorId,
    "--name", name,
    "--webhook-url", eventsRequestUrl,
  ]);
  const authorization = (await introspection([
    "connectors", "authorize", connectorId,
    "--runtime", runtime,
    "--subject", "app",
    "--expires-in", "1h",
    "--return-url", returnUrl,
  ])).value;
  const authorizeUrl = authorization?.authorization_url
    ?? authorization?.authorize_url
    ?? authorization?.url;
  if (typeof authorizeUrl !== "string" || !authorizeUrl) {
    throw new Error("Connector authorization response did not contain an install URL");
  }

  await saveState({
    app_id: appId,
    connector_id: connectorId,
    connector_slug: connectorSlug,
    bot_name: name,
    runtime,
    environment,
    redirect_url: redirectUrl,
    return_url: returnUrl,
    events_request_url: eventsRequestUrl,
    permissions_updated: Boolean(updated.permissions_updated),
    generated_at: new Date().toISOString(),
  });
  return { appId, connectorId, authorizeUrl, name, permissionsUpdated: Boolean(updated.permissions_updated) };
}

async function main() {
  if (!/^(development|staging|production)$/.test(environment)) {
    throw new Error("INTROSPECTION_ENVIRONMENT must be development, staging, or production");
  }

  const identity = await introspection(["whoami"]);
  const baseUrl = process.env.INTROSPECTION_API_BASE_URL?.trim() || findBaseUrl(identity.value);
  if (!baseUrl) throw new Error("Could not determine the Introspection API URL; set INTROSPECTION_API_BASE_URL");
  const returnUrl = resolveReturnUrl(baseUrl, process.env.INTROSPECTION_RETURN_URL);

  await ensureRuntime();
  await bindLinear();
  const slackSetup = await setupSlack(baseUrl, returnUrl);

  console.log(`Configured Linear MCP for runtime ${runtime} (${environment}).`);
  console.log(`Created or updated Slack app "${slackSetup.name}" (${slackSetup.appId}) and connector ${slackSetup.connectorId}.`);
  console.log(`Install the bot: ${slackSetup.authorizeUrl}`);
  console.log("This installation link expires in one hour. Rerun npm run setup to create a new one.");
  if (slackSetup.permissionsUpdated) {
    console.log("Slack reports changed permissions; completing the install link will grant the new scopes.");
  }
  console.log(`After authorization, invite @${slackSetup.name} to each Slack channel where it should accept reports.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
