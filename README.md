# Slack Linear Assistant

Use Linear from Slack: ask questions, browse teams and projects, query backlogs, create or update issues and comments, or submit a bug report with screenshots, audio, and video.

Mention the bot in a channel or reply. It handles any request supported by its declared Linear tools and replies in the same Slack thread. For bug reports, it analyzes attachments, checks for duplicates, and creates an issue or adds an evidence comment.

## First-time setup

You need:

- An Introspection project and an authenticated `introspection` CLI.
- A [Linear API key](https://linear.app/docs/api-and-webhooks#api-keys) that can create, comment on, and update issues in the teams where reports may be filed.
- Permission to install an app in your Slack workspace.

### 1. Get a Slack app configuration token

Open [Slack's app configuration token page](https://api.slack.com/reference/manifests#config-tokens), choose your workspace, and select **Generate Token**. Copy the access token that begins with `xoxe.xoxp-`.

The token expires after 12 hours. It lets the setup command create and configure the Slack app. You do not need to create a Slack app yourself or find a bot token, app token, client secret, signing secret, webhook URL, OAuth callback, or channel ID.

### 2. Run setup

From the recipe directory:

```bash
export LINEAR_API_KEY='lin_api_...'
export SLACK_APP_CONFIG_TOKEN='xoxe.xoxp-...'
export SLACK_BOT_NAME='Acme Bug Concierge' # optional; defaults to "Introspection"

npm install
npm run setup
```

Setup creates the Introspection runtime, stores the Linear key as a write-only credential, connects Linear, creates and configures the Slack app and connector, and prints a Slack installation link.

For hosted Introspection environments, setup infers the platform page to open after Slack authorization from the API URL. For a custom deployment, set `INTROSPECTION_RETURN_URL` to the page users should return to after authorizing. This is separate from the Slack OAuth callback, which setup configures automatically.

The installation link expires after one hour. If it expires, run `npm run setup` again to get a new link.

### 3. Install and invite the bot

Open the installation link and approve the Slack app. Your workspace may require an administrator to approve the installation.

Invite the bot to each channel where it should accept reports:

```text
/invite @Introspection
```

If you set `SLACK_BOT_NAME`, use that name instead. The chosen name is applied to both the Slack app and its bot user.

## Linear teams

The bot discovers Linear teams when it handles a report. If the Linear key can access one team, the bot uses it automatically.

If the key can access several teams, the bot chooses the best match from the product and component described in the report. The requester can name a team when they want to choose it directly:

```text
@Introspection File this in Engineering: saving a conversation shows raw XML.
```

The requester can also use a team key, such as `team: ENG`. An explicit team always wins. If no team is a reasonable match, the bot asks which team to use and does not change Linear. Its Slack reply names the chosen team so someone can correct a routing mistake.

## Models and credentials

The recipe uses Introspection's managed model gateway by default:

- Main intake agent: `openrouter/anthropic/claude-sonnet-5`
- Media analyst: `openrouter/google/gemini-3.7-flash`

Both models use the same gateway, telemetry, and managed credential path. You do not need a model API key for the default setup.

To choose other models, edit the `ai.model` field in [`agents/agent.yaml`](agents/agent.yaml) or [`agents/media-analyst.yaml`](agents/media-analyst.yaml) before first-time setup. For BYOK, change `llm_mode` in [`.introspection/slack-linear-bug-intake.yaml`](.introspection/slack-linear-bug-intake.yaml) and bind the credential required by your provider. The default BYOK configuration uses one OpenRouter credential for both models.

## Use the bot

Ask general Linear questions or request supported changes:

```text
@Introspection List the bugs in the Dev Ex backlog.
@Introspection Move INT-123 to In Progress and assign it to Atharva.
```

The bot does not impose a “bug intake only” scope. Its available Slack and Linear tools define what it can do; it will explain a concrete tool limitation only when the requested operation is not available.

People can use the bot naturally in either shape:

```text
@Introspection Saving a conversation sometimes shows raw XML in the message bubble.
[screenshot or video]
```

or:

```text
Saving a conversation sometimes shows raw XML in the message bubble.
[screenshot or video]
  ↳ @Introspection can you log this?
```

The bot replies in the thread with the created or matched Linear issue link and its current workflow status. Add follow-up evidence or questions to the same thread. After the bot has joined a thread, later text replies do not need another mention.

If you add a file without text, send a short reply such as `uploaded` so the bot knows to continue.

The bot can also update one existing issue when the message names the issue and states each change:

```text
@Introspection Update BOT-2. Set the status to In Progress, set the priority to High, assign it to me, and add the Bug label.
```

The bot checks named values against Linear before making the change. It updates only the fields in the message. A later message can make another update.

## Test Recipe changes

Use `introspection dev` to test local Recipe edits against a real Slack event in
the development environment:

```bash
introspection dev --runtime slack-linear-bug-intake --logs
```

The cloud task uses your local Recipe files. Slack sends events through the
normal Events API webhook, and the Recipe calls the Slack Web API through the
cloud provider proxy. You do not need a local Slack server or a hosted MCP
token.

Use `introspection dev` for both inbound events and outbound channel tools.
Standalone channel access through `introspection local` is not supported.

## Safety and limits

- The bot makes at most one Linear change for each Slack message. One change can update several fields on one issue.
- It does not retry a failed Linear change because the first request may have succeeded remotely.
- It uses only teams available to the supplied Linear key.
- It reports the team it chose and asks only when no team is a reasonable match.
- It analyzes up to eight attachments, with a combined media limit of 32 MiB.

## Validate the recipe

```bash
introspection check
```

## Package shape

| Path                               | Responsibility                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `SYSTEM.md`                        | Invocation, trust, Slack tools, Linear MCP, triage, mutation, and reply policy |
| `agents/agent.yaml`                | Main Sonnet intake agent and exact tool allowlist                              |
| `agents/media-analyst.yaml`        | Video-capable Gemini subagent                                                  |
| `extensions/bug-intake-tools.mjs`  | Task-file media reader and narrow Pi media serialization bridge                |
| `package.json`                     | Slack connector dependency and tool declaration                               |
| `skills/triage-bug/SKILL.md`       | Duplicate and issue-quality procedure                                          |
| `scripts/setup.mjs`                | Linear credential/MCP binding plus two-phase Slack app/connector setup         |
| `slack-app/manifest.template.json` | Slack app scopes and events                                                    |

## License

Apache-2.0. This recipe preserves the license and attribution from `template-slack-agent`.
