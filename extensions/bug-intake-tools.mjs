import { BugMediaSession, rewriteProviderMediaPayload } from "../lib/bug-intake.mjs";

export default function registerBugIntakeTools(pi) {
  const session = new BugMediaSession();

  pi.registerTool({
    name: "read_bug_media",
    label: "Read bug-report media",
    description: "Read image, audio, or video files downloaded by slack.download_file into this model turn. Pass only their exact task-local paths. Intended for the media-analyst agent.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["paths"],
      properties: {
        paths: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 2000 },
        },
      },
    },
    executionMode: "sequential",
    async execute(_id, input) {
      return session.mediaToolResult(input);
    },
  });

  pi.on("before_provider_request", (event) => rewriteProviderMediaPayload(event.payload));
}
