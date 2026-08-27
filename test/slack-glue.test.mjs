import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_SLACK_FILE_BYTES,
  SlackFileSession,
  resolveSlackOrigin,
  slackDownloadRoot,
} from "../lib/slack-glue.mjs";

function fakeFile(overrides = {}) {
  return {
    id: "F123",
    name: "crash.png",
    mimetype: "image/png",
    size: 4,
    url_private_download: "https://files.slack.com/files-pri/T1-F123/crash.png",
    ...overrides,
  };
}

function fakeFetch({ file = fakeFile(), body = "data", downloadStatus = 200 } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("files.info")) {
      return {
        ok: true,
        json: async () => ({ ok: true, file }),
      };
    }
    const bytes = Buffer.from(body);
    return {
      ok: downloadStatus === 200,
      status: downloadStatus,
      headers: new Map([["content-length", String(bytes.length)]]),
      body: (async function* stream() {
        yield bytes;
      })(),
    };
  };
  impl.calls = calls;
  return impl;
}

async function sessionInTmp(options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
  return {
    cwd,
    session: new SlackFileSession({
      env: { SLACK_BOT_TOKEN: "xoxb-local", ...options.env },
      fetchImpl: options.fetchImpl ?? fakeFetch(options),
      cwd,
    }),
  };
}

test("resolveSlackOrigin prefers the cloud task origin", () => {
  const cloud = resolveSlackOrigin({
    INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack",
    INTROSPECTION_TASK_CHANNEL_ID: "C1",
    INTROSPECTION_TASK_THREAD_ID: "1.1",
  });
  assert.deepEqual(cloud, { provider: "slack", channel: "C1", thread_ts: "1.1" });

  const local = resolveSlackOrigin({ SLACK_CHANNEL_ID: "C9" });
  assert.deepEqual(local, { provider: "slack", channel: "C9", thread_ts: null });

  assert.equal(resolveSlackOrigin({}), null);
});

test("slackDownloadRoot honors the runtime dir and falls back to cwd", () => {
  assert.equal(slackDownloadRoot({ INTROSPECTION_RUNTIME_FILES_DIR: "/workspace/files" }, "/elsewhere"), "/workspace/files/slack");
  assert.equal(slackDownloadRoot({}, "/somewhere"), "/somewhere/files/slack");
});

test("a local run without SLACK_BOT_TOKEN fails before any network call", async () => {
  const fetchImpl = fakeFetch();
  const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
  const session = new SlackFileSession({ env: {}, fetchImpl, cwd });
  await assert.rejects(
    () => session.downloadFile({ file_id: "F123" }),
    /requires SLACK_BOT_TOKEN/
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test("a cloud session downloads with an empty bearer for the egress to swap", async () => {
  const fetchImpl = fakeFetch();
  const cwd = await mkdtemp(join(tmpdir(), "slack-glue-"));
  const session = new SlackFileSession({
    env: { INTROSPECTION_TASK_CHANNEL_PROVIDER: "slack" },
    fetchImpl,
    cwd,
  });
  const result = await session.downloadFile({ file_id: "F123" });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer ");
  assert.equal(result.size, 4);
});

test("downloads land under the root with a safe name, sha256, and verified size", async () => {
  const { session, cwd } = await sessionInTmp({ file: fakeFile({ name: "../..//weird name!.png" }) });
  const result = await session.downloadFile({ file_id: "F123" });
  assert.ok(result.path.startsWith(join(cwd, "files", "slack")));
  assert.ok(!result.path.includes(".."));
  assert.equal(result.mime_type, "image/png");
  assert.equal(result.size, 4);
  assert.equal(result.sha256.length, 64);
  assert.equal(await readFile(result.path, "utf8"), "data");
  const leftovers = (await readdir(join(cwd, "files", "slack"))).filter((name) => name.includes("partial"));
  assert.deepEqual(leftovers, []);
});

test("a download URL off files.slack.com is refused", async () => {
  const { session } = await sessionInTmp({
    file: fakeFile({ url_private_download: "https://evil.example/crash.png" }),
  });
  await assert.rejects(() => session.downloadFile({ file_id: "F123" }), /files\.slack\.com/);
});

test("a mismatched files.info id is refused", async () => {
  const { session } = await sessionInTmp({ file: fakeFile({ id: "F999" }) });
  await assert.rejects(() => session.downloadFile({ file_id: "F123" }), /different file/);
});

test("oversized files are refused before streaming", async () => {
  const { session } = await sessionInTmp({ file: fakeFile({ size: MAX_SLACK_FILE_BYTES + 1 }) });
  await assert.rejects(() => session.downloadFile({ file_id: "F123" }), /download limit/);
});

test("a size mismatch removes the partial download", async () => {
  const { session, cwd } = await sessionInTmp({ file: fakeFile({ size: 999 }), body: "data" });
  await assert.rejects(() => session.downloadFile({ file_id: "F123" }), /does not match/);
  const entries = await readdir(join(cwd, "files", "slack"));
  assert.deepEqual(entries, []);
});

test("video_low requires a video with an mp4_low rendition and forces mp4 naming", async () => {
  const { session: noRendition } = await sessionInTmp({ file: fakeFile() });
  await assert.rejects(
    () => noRendition.downloadFile({ file_id: "F123", variant: "video_low" }),
    /no video_low rendition/
  );

  const { session } = await sessionInTmp({
    file: fakeFile({
      name: "demo.mov",
      mimetype: "video/quicktime",
      mp4_low: "https://files.slack.com/files-pri/T1-F123/demo_low.mp4",
    }),
  });
  const result = await session.downloadFile({ file_id: "F123", variant: "video_low" });
  assert.ok(result.name.endsWith(".mp4"));
  assert.equal(result.mime_type, "video/mp4");
});

test("argument shapes are validated", async () => {
  const { session } = await sessionInTmp();
  await assert.rejects(() => session.downloadFile({ file_id: "" }), /file_id is required/);
  await assert.rejects(() => session.downloadFile({ file_id: "F1", variant: "huge" }), /variant/);
});
