import { SlackFileSession, resolveSlackOrigin } from "../lib/slack-glue.mjs";

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

export default function registerSlackTools(pi) {
  const files = new SlackFileSession();

  pi.registerTool({
    name: "slack_origin",
    label: "Slack origin",
    description:
      "The Slack conversation this session answers: provider, channel, and thread_ts (null for a top-level message). Call this first and pass its channel and thread_ts explicitly to every Slack MCP call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    executionMode: "sequential",
    async execute() {
      const origin = resolveSlackOrigin();
      if (!origin) {
        return errorResult(
          "No Slack origin is configured. In the Introspection runtime the task origin supplies it; for a local run set SLACK_CHANNEL_ID (and optionally SLACK_THREAD_TS)."
        );
      }
      return jsonResult(origin);
    },
  });

  pi.registerTool({
    name: "slack_workspace_download_file",
    label: "Download Slack file",
    description:
      "Download one Slack file into the task workspace and return its local path, size, and sha256. Pass variant \"video_low\" for a video's smaller mp4 rendition when files.info reports mp4_low. Use the returned path with read_bug_media.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_id"],
      properties: {
        file_id: { type: "string", minLength: 1, maxLength: 100 },
        variant: { type: "string", enum: ["original", "video_low"] },
      },
    },
    executionMode: "sequential",
    async execute(_id, input) {
      try {
        return jsonResult(await files.downloadFile(input));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
