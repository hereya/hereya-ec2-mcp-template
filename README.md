# hereya/ec2-mcp-template

Hereya infrastructure package that scaffolds a production-ready MCP (Model Context Protocol) server deployed on **AWS EC2 with pm2**, behind an Application Load Balancer with HTTPS and OAuth2 authentication.

## What it does

When you add this package to a hereya project, it:

1. Creates an **AWS CodeCommit repository** with a ready-to-use MCP server codebase
2. Sets up **IAM credentials** for Git access (stored in Secrets Manager)
3. The template code deploys to **EC2 via `hereya/ec2-web-deploy`** — Auto Scaling Group, ALB, ACM certificate, Route 53 custom domain, and pm2 process management

## Architecture

```
MCP Client (Claude, etc.)
    │
    ▼
ALB (HTTPS, port 443)
    │  ACM certificate + Route 53 custom domain
    ▼
EC2 Instance (pm2 → Node.js, port 3000)
    │
    ├── GET /                                    → Health check (ALB)
    ├── GET /.well-known/oauth-protected-resource → OAuth PRM (RFC 9728)
    └── POST /mcp                                → JWT validation → MCP SDK → Tools
```

### How it differs from `hereya/mcp-template`

| | `hereya/mcp-template` | `hereya/ec2-mcp-template` |
|---|---|---|
| **Compute** | AWS Lambda | EC2 + pm2 |
| **Auth** | Lambda Authorizer (separate) | Built-in JWT validation |
| **Scaling** | Per-request (Lambda) | ASG (1-2 instances, rolling updates) |
| **Deploy package** | `aws/mcp-lambda` | `hereya/ec2-web-deploy` |
| **Use case** | Stateless, low-traffic MCP servers | Long-running processes, persistent connections, heavier workloads |

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `projectName` | Yes | Project identifier (e.g., `myorg/my-mcp-server`) |
| `workspace` | Yes | Target workspace for deployment |
| `customDomain` | Yes | Domain for the MCP endpoint (e.g., `mcp.example.com`) |
| `organizationId` | No | Hereya org ID for access control |
| `deployWorkspace` | No | Workspace name shown in CLAUDE.md |
| `hereyaCodecommitIamUserName` | No | Reuse existing IAM user (skip creation) |
| `hereyaCodecommitUserArn` | No | Existing IAM user ARN |
| `hereyaCodecommitUsername` | No | Existing user's Git username |
| `hereyaCodecommitPassword` | No | Existing user's Git password |

## Outputs

| Output | Description |
|--------|-------------|
| `hereyaGitRemoteUrl` | CodeCommit HTTPS clone URL |
| `hereyaGitUsername` | Git HTTPS username |
| `hereyaGitPassword` | Secrets Manager ARN for Git password (auto-resolved by Hereya) |

## Template structure

The CodeCommit repository is initialized with:

```
├── src/
│   ├── index.ts          # HTTP server — health check, OAuth PRM, MCP endpoint
│   ├── auth.ts           # JWT validation (JWKS, RS256, org binding)
│   ├── server.ts         # MCP server factory
│   ├── secrets.ts        # AWS Secrets Manager resolver
│   ├── tools/index.ts    # Tool registration hub
│   ├── prompts/index.ts  # Prompt registration hub
│   └── app/ui.ts         # MCP App UI
├── hereya.yaml           # References hereya/ec2-web-deploy for deployment
├── CLAUDE.md             # Deployment guide for Claude Code
├── package.json
├── tsconfig.json
└── vite.config.ts        # UI build (single-file HTML)
```

## MCP connector URL

After deployment, the MCP endpoint is:

```
https://<customDomain>/mcp
```

Add this URL as a connector in Claude Desktop (or any MCP client) and authenticate via OAuth through your Hereya account.

## Development

### CDK project (this package)

```bash
npm install
npm run build     # Compile TypeScript
npx cdk synth     # Synthesize CloudFormation
```

### Template (the generated MCP server)

```bash
cd template
npm install
npm run dev       # Run server locally on port 3000
npm run build     # Compile + bundle UI + create dist.zip
npm run typecheck # Type checking
npm run inspect   # Launch MCP Inspector
```

## Build output

The template build (`npm run build`) produces `dist/dist.zip` containing:

- `index.js` + compiled server modules — Node.js server code
- `app.html` — MCP App UI (Vite single-file bundle)
- `package.json` + `package-lock.json` — for `npm install` on EC2

On EC2, `hereya/ec2-web-deploy` unzips, runs `npm install --omit=dev`, and starts the server with pm2.
