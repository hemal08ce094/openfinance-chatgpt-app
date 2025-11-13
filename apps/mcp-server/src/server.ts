import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
  type Resource,
  type ResourceTemplate,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  OpenFinanceClient,
  type BalanceSummary,
} from "./openfinanceClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..", "..");
const assetsRoot = path.resolve(projectRoot, "assets/openfinance-consent-flow");
const assetBundleDir = path.join(assetsRoot, "assets");

const port = Number.parseInt(process.env.MCP_PORT ?? "9035", 10);
const starterKitPort = Number.parseInt(
  process.env.STARTER_KIT_PORT ?? process.env.PORT ?? "1411",
  10
);
const starterKitBase = (process.env.STARTER_KIT_BASE_URL ??
  `http://localhost:${starterKitPort}`) as string;
const normalizedStarterKitBase = starterKitBase.replace(/\/+$/, "");
const publicBase = (process.env.PUBLIC_BASE_URL ??
  `http://localhost:${port}`) as string;
const normalizedPublicBase = publicBase.replace(/\/+$/, "");

const openFinanceClient = new OpenFinanceClient(starterKitBase);

function extractAssetRevision(fileName: string): string | null {
  const match = fileName.match(/-([a-z0-9]+)\.[^.]+$/i);
  return match?.[1] ?? null;
}

function ensureAssetDirectory() {
  if (!existsSync(assetBundleDir)) {
    throw new Error(
      `Widget assets not found in ${assetBundleDir}. Run "npm run build:widgets" from the project root.`
    );
  }
}

function findAssetFile(extension: string): string {
  ensureAssetDirectory();
  const entries = readdirSync(assetBundleDir);
  const match = entries.find(
    (entry) =>
      entry.startsWith("index-") &&
      entry.toLowerCase().endsWith(`.${extension.toLowerCase()}`)
  );
  if (!match) {
    throw new Error(
      `Unable to locate ${extension} bundle in ${assetBundleDir}.`
    );
  }
  return match;
}

function escapeScriptContents(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

type WidgetAssetState = {
  html: string;
  revision: string;
  cssFile: string;
  jsFile: string;
};

function loadWidgetAssets(): WidgetAssetState {
  const cssFile = findAssetFile("css");
  const jsFile = findAssetFile("js");
  const cssPath = path.join(assetBundleDir, cssFile);
  const jsPath = path.join(assetBundleDir, jsFile);
  const cssText = readFileSync(cssPath, "utf8");
  const jsText = readFileSync(jsPath, "utf8");
  const revision =
    extractAssetRevision(jsFile) ??
    extractAssetRevision(cssFile) ??
    Date.now().toString(36);

  const widgetHtml = `
<div id="root"></div>
<style>${cssText}</style>
<script>
window.__OPENFINANCE_API_BASE__ = ${JSON.stringify(
    normalizedStarterKitBase
  )};
</script>
<script type="module">
${escapeScriptContents(jsText)}
</script>
`.trim();

  return {
    html: widgetHtml,
    revision,
    cssFile,
    jsFile,
  };
}

const widgetAssets = loadWidgetAssets();

type WidgetDescriptor = {
  id: string;
  title: string;
  templateUri: string;
  description: string;
  invoking: string;
  invoked: string;
  html: string;
};

const consentWidget: WidgetDescriptor = {
  id: "openfinance-consent-flow",
  title: "Consent + balance orchestrator",
  description:
    "Guided UI that walks through consent authorization and balance aggregation using the Open Finance starter kit.",
  templateUri: `ui://widget/openfinance/consent-flow?rev=${widgetAssets.revision}`,
  invoking: "Preparing consent orchestrator",
  invoked: "Consent orchestrator ready",
  html: widgetAssets.html,
};
const widgets = [consentWidget];
const widgetsByUri = new Map(widgets.map((widget) => [widget.templateUri, widget]));

function widgetDescriptorMeta(widget: WidgetDescriptor) {
  return {
    "openai/outputTemplate": widget.templateUri,
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
    "openai/widgetAccessible": true,
    "openai/resultCanProduceWidget": true,
  } as const;
}

function widgetInvocationMeta(widget: WidgetDescriptor) {
  return {
    "openai/toolInvocation/invoking": widget.invoking,
    "openai/toolInvocation/invoked": widget.invoked,
  } as const;
}

const resources: Resource[] = widgets.map((widget) => ({
  uri: widget.templateUri,
  name: widget.title,
  description: widget.description,
  mimeType: "text/html+skybridge",
  _meta: widgetDescriptorMeta(widget),
}));

const resourceTemplates: ResourceTemplate[] = widgets.map((widget) => ({
  uriTemplate: widget.templateUri,
  name: widget.title,
  description: widget.description,
  mimeType: "text/html+skybridge",
  _meta: widgetDescriptorMeta(widget),
}));

const scopeOptions = [
  "confirmation-of-payee",
  "openid accounts",
  "openid payments",
  "openid accounts payments",
  "openid payments accounts",
  "openid products",
];

const dataPermissionOptions = [
  "ReadAccountsBasic",
  "ReadAccountsDetail",
  "ReadBalances",
  "ReadBeneficiariesBasic",
  "ReadBeneficiariesDetail",
  "ReadTransactionsBasic",
  "ReadTransactionsDetail",
  "ReadTransactionsCredits",
  "ReadTransactionsDebits",
  "ReadScheduledPaymentsBasic",
  "ReadScheduledPaymentsDetail",
  "ReadDirectDebits",
  "ReadStandingOrdersBasic",
  "ReadStandingOrdersDetail",
  "ReadConsents",
  "ReadPartyUser",
  "ReadPartyUserIdentity",
  "ReadParty",
] as const;
const dataPermissionEnum = z.enum(dataPermissionOptions);

const registerSchema = z.object({});
const clientCredentialsSchema = z.object({
  scope: z
    .string()
    .trim()
    .refine(
      (value) => scopeOptions.includes(value),
      "Scope must match an allowed Open Finance combination."
    )
    .default("openid accounts"),
});

const consentSchema = z.object({
  maxPaymentAmount: z
    .string()
    .regex(/^(?:0|[1-9]\d*)(?:\.\d{2})$/, "Use a value like 250.00")
    .default("250.00"),
});

const dataConsentSchema = z
  .object({
    permissions: z.array(dataPermissionEnum).nonempty("Select at least one permission"),
    validFrom: z.string().datetime().optional(),
    validUntil: z.string().datetime().optional(),
  })
  .refine(
    (value) =>
      !value.validFrom ||
      !value.validUntil ||
      new Date(value.validFrom) < new Date(value.validUntil),
    {
      message: "validUntil must be later than validFrom",
      path: ["validUntil"],
    }
  );

const exchangeSchema = z.object({
  code: z.string().min(1, "code is required"),
  codeVerifier: z.string().min(1, "codeVerifier is required"),
});

const aggregateSchema = z.object({
  accessToken: z
    .string()
    .min(10, "Provide a valid access token")
    .describe("Access token returned by the authorization-code exchange"),
});

const widgetSchema = z.object({
  scope: z.string().optional(),
  maxPaymentAmount: z.string().optional(),
});

type ToolDefinition = {
  spec: Tool;
  schema: z.ZodTypeAny;
  invoke: (args: unknown) => Promise<CallToolResult>;
};

function describeSummary(summary: BalanceSummary): string {
  if (summary.totals.length === 0) {
    return "No balances were returned by the API.";
  }

  const totals = summary.totals
    .map(
      (item) => `${item.amount.toFixed(2)} ${item.currency.toUpperCase()}`
    )
    .join(", ");
  return `Aggregated balances across ${summary.accounts.length} account(s): ${totals}.`;
}

function asToolResult(message: string, payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    structuredContent: payload,
  };
}

const toolDefinitions = new Map<string, ToolDefinition>();

function registerTool(definition: ToolDefinition) {
  toolDefinitions.set(definition.spec.name, definition);
  return definition.spec;
}

const tools: Tool[] = [
  registerTool({
    spec: {
      name: "openfinance.register",
      title: "Register TPP",
      description:
        "Calls the /register endpoint from the starter kit to initiate or refresh your TPP registration.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        destructiveHint: false,
        openWorldHint: false,
        readOnlyHint: true,
      },
    },
    schema: registerSchema,
    invoke: async () => {
      const payload = await openFinanceClient.register();
      return asToolResult(
        "Starter kit registration payload retrieved.",
        payload
      );
    },
  }),
  registerTool({
    spec: {
      name: "openfinance.clientCredentials",
      title: "Client credentials token",
      description: "Exchange client credentials for a scoped access token.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: scopeOptions,
            description: "OAuth scope to request.",
          },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
    schema: clientCredentialsSchema,
    invoke: async (raw) => {
      const args = clientCredentialsSchema.parse(raw);
      const payload = await openFinanceClient.clientCredentials(args.scope);
      return asToolResult(
        `Issued client-credential token for scope "${args.scope}".`,
        payload
      );
    },
  }),
  registerTool({
    spec: {
      name: "openfinance.createConsent",
      title: "Create consent",
      description:
        "Build a variable-on-demand consent and receive the redirect link + PKCE verifier.",
      inputSchema: {
        type: "object",
        properties: {
          maxPaymentAmount: {
            type: "string",
            description: "Maximum amount per payment in AED (e.g. 250.00).",
          },
        },
        required: ["maxPaymentAmount"],
        additionalProperties: false,
      },
    },
    schema: consentSchema,
    invoke: async (raw) => {
      const args = consentSchema.parse(raw);
      const payload = await openFinanceClient.createConsent(
        args.maxPaymentAmount
      );
      return asToolResult(
        "Consent created. Redirect URL and verifier returned.",
        payload
      );
    },
  }),
  registerTool({
    spec: {
      name: "openfinance.createDataConsent",
      title: "Create data sharing consent",
      description:
        "Build an account-access consent for data aggregation with a custom validity period.",
      inputSchema: {
        type: "object",
        properties: {
          permissions: {
            type: "array",
            description: "List of data permissions requested from the user.",
            items: { type: "string", enum: dataPermissionOptions },
          },
          validFrom: {
            type: "string",
            description: "ISO 8601 timestamp when the consent becomes active.",
          },
          validUntil: {
            type: "string",
            description:
              "ISO 8601 timestamp when the consent expires. Must be later than validFrom.",
          },
        },
        required: ["permissions"],
        additionalProperties: false,
      },
    },
    schema: dataConsentSchema,
    invoke: async (raw) => {
      const args = dataConsentSchema.parse(raw);
      const payload = await openFinanceClient.createDataConsent({
        permissions: args.permissions,
        validFrom: args.validFrom,
        validUntil: args.validUntil,
      });
      return asToolResult(
        "Data sharing consent created. Redirect URL ready for authorization.",
        payload
      );
    },
  }),
  registerTool({
    spec: {
      name: "openfinance.exchangeAuthorizationCode",
      title: "Exchange authorization code",
      description:
        "Call the /token/authorization-code endpoint with a code + verifier to produce an access token.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Authorization code returned by the redirect.",
          },
          codeVerifier: {
            type: "string",
            description: "PKCE verifier that was issued during consent.",
          },
        },
        required: ["code", "codeVerifier"],
        additionalProperties: false,
      },
    },
    schema: exchangeSchema,
    invoke: async (raw) => {
      const args = exchangeSchema.parse(raw);
      const payload = await openFinanceClient.exchangeAuthorizationCode(
        args.code,
        args.codeVerifier
      );
      return asToolResult(
        "Authorization code exchanged for account access.",
        payload
      );
    },
  }),
  registerTool({
    spec: {
      name: "openfinance.aggregateBalances",
      title: "Aggregate balances",
      description:
        "Fetches accounts + balances from the starter kit APIs and returns an aggregated summary.",
      inputSchema: {
        type: "object",
        properties: {
          accessToken: {
            type: "string",
            description: "Access token with accounts scope.",
          },
        },
        required: ["accessToken"],
        additionalProperties: false,
      },
    },
    schema: aggregateSchema,
    invoke: async (raw) => {
      const args = aggregateSchema.parse(raw);
      const summary = await openFinanceClient.aggregateBalances(
        args.accessToken
      );
      return {
        content: [
          {
            type: "text",
            text: describeSummary(summary),
          },
        ],
        structuredContent: summary,
      };
    },
  }),
  registerTool({
    spec: {
      name: "openfinance.launchConsentFlow",
      title: "Launch guided consent flow",
      description:
        "Returns the consent + balance widget so you can run the entire flow inside ChatGPT.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "Optional OAuth scope to prefill inside the widget.",
          },
          maxPaymentAmount: {
            type: "string",
            description: "Optional amount to seed the widget with.",
          },
        },
        additionalProperties: false,
      },
      _meta: widgetDescriptorMeta(consentWidget),
    },
    schema: widgetSchema,
    invoke: async (raw) => {
      const args = widgetSchema.parse(raw ?? {});
      return {
        content: [
          {
            type: "text",
            text: "Embedded consent + balance UI ready.",
          },
        ],
        structuredContent: {
          scope: args.scope ?? "openid accounts",
          maxPaymentAmount: args.maxPaymentAmount ?? "250.00",
        },
        _meta: widgetInvocationMeta(consentWidget),
      };
    },
  }),
];

function createMcpServer(): Server {
  const server = new Server(
    {
      name: "openfinance-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({
      tools,
    })
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const handler = toolDefinitions.get(request.params.name);
      if (!handler) {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }
      const args = handler.schema.parse(request.params.arguments ?? {});
      return handler.invoke(args);
    }
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources,
    })
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({
      resourceTemplates,
    })
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => {
      const widget = widgetsByUri.get(request.params.uri);
      if (!widget) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }
      return {
        contents: [
          {
            uri: widget.templateUri,
            mimeType: "text/html+skybridge",
            text: widget.html,
            _meta: widgetDescriptorMeta(widget),
          },
        ],
      };
    }
  );

  return server;
}

type SessionRecord = {
  server: Server;
  transport: SSEServerTransport;
};

const sessions = new Map<string, SessionRecord>();
const ssePath = "/mcp";
const postPath = "/mcp/messages";

async function handleSse(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const server = createMcpServer();
  const transport = new SSEServerTransport(postPath, res);
  sessions.set(transport.sessionId, { server, transport });

  transport.onclose = async () => {
    sessions.delete(transport.sessionId);
    await server.close();
  };

  transport.onerror = (error) => {
    console.error("SSE transport error", error);
  };

  try {
    await server.connect(transport);
  } catch (error) {
    sessions.delete(transport.sessionId);
    console.error("Failed to start SSE session", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to establish SSE connection");
    }
  }
}

async function handlePostMessage(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    res.writeHead(400).end("Missing sessionId query parameter");
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    res.writeHead(404).end("Unknown session");
    return;
  }
  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Failed to process message", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to process message");
    }
  }
}

function contentTypeFor(filePath: string) {
  const ext = path.extname(filePath);
  switch (ext) {
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

function serveInlinedWidget(res: ServerResponse, req: IncomingMessage) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  
  // Dynamically inject the correct API base URL based on the request host
  let apiBaseUrl = normalizedStarterKitBase;
  
  // Check X-Forwarded-Host first (set by proxy), then fall back to Host header
  const forwardedHost = req.headers["x-forwarded-host"] as string | undefined;
  const host = forwardedHost || req.headers.host;
  
  // If accessed via a remote host (not localhost), use that host as the API base
  if (host && !host.includes("localhost") && !host.includes("127.0.0.1")) {
    const protocol = req.headers["x-forwarded-proto"] || "https";
    apiBaseUrl = `${protocol}://${host}`;
    console.log(`[MCP Server] Serving widget with remote API base: ${apiBaseUrl} (from ${forwardedHost ? 'X-Forwarded-Host' : 'Host'} header)`);
  }
  
  // Replace the hardcoded localhost URL with the dynamic one
  const dynamicHtml = consentWidget.html.replace(
    'window.__OPENFINANCE_API_BASE__ = "http://localhost:1411"',
    `window.__OPENFINANCE_API_BASE__ = "${apiBaseUrl}"`
  );
  
  res.writeHead(200).end(dynamicHtml);
}

function serveBundledAsset(pathname: string, res: ServerResponse) {
  const relative = pathname.replace(/^\/assets\/?/, "");
  if (!relative) {
    res.writeHead(404).end("Not found");
    return;
  }
  const safeRelative = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(assetBundleDir, safeRelative);
  if (!filePath.startsWith(assetBundleDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", contentTypeFor(filePath));
  const stream = createReadStream(filePath);
  stream.on("error", (error) => {
    console.error("Failed to stream asset", filePath, error);
    if (!res.headersSent) {
      res.writeHead(500).end("Failed to read asset");
    } else {
      res.destroy(error);
    }
  });
  stream.pipe(res);
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (
    req.method === "OPTIONS" &&
    (url.pathname === ssePath || url.pathname === postPath)
  ) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === ssePath) {
    await handleSse(res);
    return;
  }

  if (req.method === "POST" && url.pathname === postPath) {
    await handlePostMessage(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/widgets")) {
    serveInlinedWidget(res, req);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    serveBundledAsset(url.pathname, res);
    return;
  }

  res.writeHead(404).end("Not found");
});

httpServer.on("clientError", (err, socket) => {
  console.error("HTTP client error", err);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

httpServer.listen(port, () => {
  console.log("Open Finance MCP server ready.");
  console.log(`HTTP base: ${normalizedPublicBase}`);
  console.log(`SSE stream: GET ${normalizedPublicBase}${ssePath}`);
  console.log(
    `Messages endpoint: POST ${normalizedPublicBase}${postPath}?sessionId=<id>`
  );
  console.log(`Widget assets directory: ${assetsRoot}`);
  console.log(`Starter kit base: ${normalizedStarterKitBase}`);
});
