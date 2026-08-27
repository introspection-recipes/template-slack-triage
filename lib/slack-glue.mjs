import { createHash } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";

// Download bound. Guards the stream and the task workspace, not the model
// payload — read_bug_media enforces its own 32 MiB cap when media enters a
// model turn, so a large original whose mp4_low rendition is small stays
// resolvable here.
export const MAX_SLACK_FILE_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SLACK_API_BASE = "https://slack.com/api";
const SLACK_FILES_HOST = "files.slack.com";

/**
 * The Slack conversation this session answers, from wherever the host put it.
 *
 * Cloud sandboxes carry the task origin as INTROSPECTION_TASK_CHANNEL_* env;
 * a local run names its target with SLACK_CHANNEL_ID / SLACK_THREAD_TS. One
 * resolver serves both so the agent-facing contract — call slack_origin, pass
 * its channel and thread explicitly to every Slack call — never branches on
 * where the session runs.
 */
export function resolveSlackOrigin(env = process.env) {
  const cloudChannel = env.INTROSPECTION_TASK_CHANNEL_ID?.trim();
  if (cloudChannel) {
    return {
      provider: env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim() || "slack",
      channel: cloudChannel,
      thread_ts: env.INTROSPECTION_TASK_THREAD_ID?.trim() || null,
    };
  }
  const localChannel = env.SLACK_CHANNEL_ID?.trim();
  if (localChannel) {
    return {
      provider: "slack",
      channel: localChannel,
      thread_ts: env.SLACK_THREAD_TS?.trim() || null,
    };
  }
  return null;
}

/**
 * Where downloaded Slack files land.
 *
 * The cloud runtime names the task files tree via
 * INTROSPECTION_RUNTIME_FILES_DIR; without it (a local run, or the cloud
 * default where the workspace is the cwd) the tree is ./files under the
 * session workspace — the same location either way, since the cloud cwd is
 * the workspace root.
 */
export function slackDownloadRoot(env = process.env, cwd = process.cwd()) {
  const runtimeFiles = env.INTROSPECTION_RUNTIME_FILES_DIR?.trim();
  if (runtimeFiles) return resolve(runtimeFiles, "slack");
  return resolve(cwd, "files", "slack");
}

function requiredFileId(value) {
  if (typeof value !== "string") throw new Error("file_id must be a string");
  const cleaned = value.trim();
  if (!cleaned) throw new Error("file_id is required");
  if (cleaned.length > 100) throw new Error("file_id exceeds 100 characters");
  return cleaned;
}

function fileVariant(value) {
  if (value === undefined || value === null || value === "" || value === "original") return "original";
  if (value === "video_low") return "video_low";
  throw new Error('variant must be "original" or "video_low"');
}

// Filesystem-safe segment: strip to a conservative set and refuse dot-only
// names so a hostile Slack filename can never traverse or hide.
function safeSegment(value, fallback) {
  const cleaned = basename(String(value ?? "")).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
  return cleaned;
}

function downloadName(fileId, name, variant) {
  const id = safeSegment(fileId, "file");
  const base = safeSegment(name, "download");
  if (variant === "video_low") {
    const stem = base.replace(/\.[^.]+$/, "");
    return `${id}-video-low-${stem || "download"}.mp4`;
  }
  return `${id}-${base}`;
}

/**
 * The private URL to fetch, host-pinned. Slack file bytes live only on
 * files.slack.com; anything else in the metadata is treated as hostile.
 */
function downloadUrl(file, variant) {
  let raw;
  if (variant === "video_low") {
    if (!file.mp4_low) throw new Error("file has no video_low rendition");
    if (typeof file.mimetype !== "string" || !file.mimetype.startsWith("video/")) {
      throw new Error("video_low is only available for video files");
    }
    raw = file.mp4_low;
  } else {
    raw = file.url_private_download || file.url_private;
  }
  if (typeof raw !== "string" || !raw) throw new Error("file has no downloadable URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== SLACK_FILES_HOST) {
    throw new Error(`file URL host is not ${SLACK_FILES_HOST}`);
  }
  return url;
}

function declaredSize(file) {
  const size = file.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("file metadata carries no usable size");
  }
  return size;
}

/**
 * Slack file downloads for the triage workflow.
 *
 * The in-pod connector's download_file tool, rebuilt recipe-side for the
 * hosted-MCP posture (the hosted server returns file content into model
 * context, which is exactly wrong for large or private files — these bytes
 * belong in the task workspace, referenced by path).
 *
 * Auth is a plain bearer on both requests. In a cloud sandbox the env is
 * unset and the egress proxy swaps the Authorization header for the
 * workspace bot token; locally SLACK_BOT_TOKEN (files:read) is required and
 * its absence is a typed error before any network call.
 */
export class SlackFileSession {
  constructor({ env = process.env, fetchImpl = fetch, cwd = process.cwd() } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.cwd = cwd;
  }

  localToken() {
    return this.env.SLACK_BOT_TOKEN?.trim() || "";
  }

  inCloudRuntime() {
    return Boolean(this.env.INTROSPECTION_TASK_CHANNEL_PROVIDER?.trim());
  }

  authHeader() {
    return `Bearer ${this.localToken()}`;
  }

  async callSlack(method, params) {
    const response = await this.fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Authorization: this.authHeader(),
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) throw new Error(`slack.com/${method} returned ${response.status}`);
    return response.json();
  }

  async downloadFile(input) {
    const fileId = requiredFileId(input.file_id);
    const variant = fileVariant(input.variant);

    if (!this.localToken() && !this.inCloudRuntime()) {
      throw new Error(
        "slack_workspace_download_file requires SLACK_BOT_TOKEN (a bot token with files:read) when running outside the Introspection runtime"
      );
    }

    const info = await this.callSlack("files.info", { file: fileId });
    if (info.ok !== true) throw new Error(`files.info failed: ${info.error ?? "unknown error"}`);
    const file = info.file;
    if (!file || file.id !== fileId) throw new Error("files.info returned a different file");

    const size = declaredSize(file);
    if (variant === "original" && size > MAX_SLACK_FILE_BYTES) {
      throw new Error(`file is ${size} bytes; the download limit is ${MAX_SLACK_FILE_BYTES}`);
    }

    const url = downloadUrl(file, variant);
    const root = slackDownloadRoot(this.env, this.cwd);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = resolve(root, downloadName(fileId, file.name, variant));

    const response = await this.fetch(url, {
      headers: { Authorization: this.authHeader() },
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`file download returned ${response.status}`);
    }

    const written = await writeDownload(response, destination, variant === "original" ? size : null);
    return {
      id: fileId,
      name: basename(destination),
      path: destination,
      mime_type: variant === "video_low" ? "video/mp4" : file.mimetype || "application/octet-stream",
      size: written.size,
      sha256: written.sha256,
    };
  }
}

/**
 * Stream to a private partial file, hash while writing, verify, then rename
 * into place. A failure at any point removes the partial so a retry never
 * sees a torn download.
 */
async function writeDownload(response, destination, expectedSize) {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(declared) && declared > MAX_SLACK_FILE_BYTES) {
    throw new Error(`download is ${declared} bytes; the limit is ${MAX_SLACK_FILE_BYTES}`);
  }
  const partial = `${destination}.partial-${createHash("sha256").update(destination + Date.now()).digest("hex").slice(0, 12)}`;
  const handle = await open(partial, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_SLACK_FILE_BYTES) {
        throw new Error(`download exceeded the ${MAX_SLACK_FILE_BYTES}-byte limit`);
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (expectedSize !== null && size !== expectedSize) {
      throw new Error(`download size ${size} does not match the declared ${expectedSize}`);
    }
    await handle.close();
    await rename(partial, destination);
    return { size, sha256: hash.digest("hex") };
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(partial).catch(() => {});
    throw error;
  }
}
