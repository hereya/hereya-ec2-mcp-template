import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server.js";
import { resolveSecrets } from "./secrets.js";
import { validateToken, getOAuthServerUrl, getBoundOrgId } from "./auth.js";

const PORT = Number(process.env.PORT) || 3000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // ALB health check
  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Protected Resource Metadata (RFC 9728)
  if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = req.headers["x-forwarded-proto"] || "http";
    const resource = `${protocol}://${host}/mcp`;
    const orgId = getBoundOrgId();
    const metadata = {
      resource,
      authorization_servers: [`${getOAuthServerUrl()}/oauth/${orgId}`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp:access"],
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(metadata));
    return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp" && req.method === "POST") {
    const result = await validateToken(req.headers.authorization);

    if (!result.valid) {
      console.log(`[auth] rejected: ${result.reason}`);
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Unauthorized" }));
      return;
    }

    console.log(`[auth] accepted: user=${result.claims.sub} org=${result.claims.org_id} role=${result.claims.org_role}`);

    const body = await readBody(req);

    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    try {
      const parsedBody = JSON.parse(body);

      const authInfo = {
        token: req.headers.authorization?.replace("Bearer ", "") ?? "",
        clientId: "ec2-server",
        scopes: ["mcp:access"],
        extra: {
          userId: String(result.claims.sub ?? ""),
          orgId: String(result.claims.org_id ?? ""),
          orgRole: String(result.claims.org_role ?? ""),
        },
      };

      const host = req.headers.host || `localhost:${PORT}`;
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const requestUrl = `${protocol}://${host}${req.url}`;

      const request = new Request(requestUrl, {
        method: "POST",
        headers: new Headers(req.headers as Record<string, string>),
        body,
      });

      const response = await transport.handleRequest(request, { parsedBody, authInfo });

      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(await response.text());
    } finally {
      await transport.close();
      await server.close();
    }
    return;
  }

  // Default: method not allowed
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  }));
});

// Resolve secrets once on startup (not per-request like Lambda)
resolveSecrets().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`MCP server running on port ${PORT}`);
    console.log(`  OAuth server: ${getOAuthServerUrl()}`);
    console.log(`  Bound org ID: ${getBoundOrgId() || "(not set)"}`);
    console.log(`  Health: http://localhost:${PORT}/`);
    console.log(`  PRM: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
    console.log(`  MCP: http://localhost:${PORT}/mcp`);
  });
}).catch((err) => {
  console.error("Failed to resolve secrets:", err);
  process.exit(1);
});
