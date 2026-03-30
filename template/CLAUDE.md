# mcp-server

MCP (Model Context Protocol) server deployed on AWS EC2 with pm2, behind an Application Load Balancer with HTTPS and OAuth2 authentication via hereya.

## Deployment

To deploy to the staging workspace:

`npm install`

Commit everything and push. Nothing should be unstaged or unpushed or uncommitted.

```bash
npm run build
hereya deploy -w {{deployWorkspace}}
```

This builds the project and runs `hereya deploy` targeting the `{{deployWorkspace}}` workspace.

After each successful deployment, tell the user to add the MCP server as a connector in Claude Desktop using the URL `https://{{customDomain}}/mcp` and then connect (oauth through hereya account). The user is probably not technical, so no technical mumbo jumbo. If this is an update to an existing deployment, tell them to disconnect and reconnect the connector.

## Quick commands

```bash
npm run build        # Bundle server with esbuild + UI with vite + zip for deploy
npm run typecheck    # TypeScript type checking (no emit)
npm run dev          # Run dev server locally
npm run inspect      # Launch MCP Inspector
```

## Architecture

### Request flow

```
Client → ALB (HTTPS) → EC2 (pm2/Node.js) → JWT Validation → MCP SDK → Tool
                                                ↓ (reject)
                                         401 Unauthorized
```

The server validates JWT tokens directly (no separate Lambda authorizer). It fetches JWKS from the OAuth server and verifies RS256 tokens. Only authenticated requests reach the MCP handler. The server extracts `userId`, `orgId`, `orgRole` from the JWT claims and passes them as `authInfo` to MCP tools.

### Endpoints

- `GET /` — Health check (ALB uses this)
- `GET /.well-known/oauth-protected-resource` — OAuth Protected Resource Metadata (RFC 9728)
- `POST /mcp` — MCP endpoint (requires Bearer token)

## Source files

```
src/
├── index.ts         # HTTP server entry point — listens on port 3000, routes requests
├── auth.ts          # JWT validation — JWKS fetching, RS256 verification, org binding
├── server.ts        # MCP server factory — creates McpServer, registers tools and prompts
├── secrets.ts       # Resolves SECRET_KEYS env vars from AWS Secrets Manager
└── tools/
    └── index.ts     # Tool registration hub — add your tools here
└── prompts/
    └── index.ts     # Prompt registration hub — add your prompts here
```

## Adding a new tool

1. Create `src/tools/my-tool.ts`:

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerMyTool(server: McpServer) {
  server.registerTool(
    "my-tool",
    {
      title: "My Tool",
      description: "What this tool does",
      inputSchema: {
        param: z.string().describe("Parameter description"),
      },
    },
    async ({ param }, { authInfo }) => {
      const userId =
        (authInfo?.extra as Record<string, unknown>)?.userId ?? "anonymous";
      return {
        content: [{ type: "text", text: `Result: ${param}` }],
      };
    },
  );
}
```

2. Register in `src/tools/index.ts`:

```typescript
import { registerMyTool } from "./my-tool.js";
// ... in registerTools():
registerMyTool(server);
```

## Auth context in tools

Tools receive auth info via the second parameter's `authInfo.extra`:

```typescript
async ({ input }, { authInfo }) => {
  const extra = authInfo?.extra as Record<string, unknown>;
  const userId = extra?.userId; // User's ID
  const orgId = extra?.orgId; // Organization ID
  const orgRole = extra?.orgRole; // Role in org (e.g., "OWNER")
};
```

## Build

TypeScript compiles `src/` into `dist/` via `tsc`. The UI is bundled into `dist/app.html` by Vite as a single file. The build then copies `package.json` and `package-lock.json` into `dist/` and creates `dist/dist.zip` for EC2 deployment. On the EC2 instance, `npm install --omit=dev` installs runtime dependencies.

## Infrastructure

Uses [hereya](https://hereya.dev) with the `hereya/ec2-web-deploy` infrastructure package. Config in `hereya.yaml`.

**Infrastructure (hereya/ec2-web-deploy) manages:**

- EC2 Auto Scaling Group with rolling updates
- Application Load Balancer (internet-facing, HTTPS)
- ACM certificate (auto-provisioned, DNS-validated)
- Route 53 custom domain
- pm2 process management for Node.js

**Deployment config:**

- `hereyaconfig/hereyavars/hereya--ec2-web-deploy.yaml` — deploy settings (domain)

## Environment variables

| Variable           | Description                                                   | Where set                 |
| ------------------ | ------------------------------------------------------------- | ------------------------- |
| `OAUTH_SERVER_URL` | OAuth server base URL                                         | hereya env / hereyaconfig |
| `BOUND_ORG_ID`     | Organization ID for access control                            | hereya env / hereyaconfig |
| `SECRET_KEYS`      | Comma-separated env var names to resolve from Secrets Manager | hereya env                |
| `PORT`             | Server port (default 3000, set by ec2-web-deploy)             | ec2-web-deploy            |
| `NODE_ENV`         | Set to "production" by ec2-web-deploy                         | ec2-web-deploy            |

## Key technical details

- MCP transport: `StreamableHTTPServerTransport` with `enableJsonResponse: true`
- Server creates a new MCP server + transport per request (stateless per request)
- JWT tokens validated directly by the server using JWKS from OAuth server (cached 5 min)
- pm2 handles process restarts and boot persistence on EC2
- ALB health check hits `GET /` expecting 200
