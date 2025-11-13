// app.js
import express from 'express';
import cors from 'cors'
import { createServer as createViteServer } from "vite";
import swaggerUi from 'swagger-ui-express'
import fs from 'fs'
import YAML from "yaml";
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { logInfo, logError, summarizePayload } from './api/logger.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// 🔹 Import APIs
// register
import register from './api/routes/register.js'
// consent creation (oauth)
import consentCreate from './api/routes/consentCreate.js'
// token 
import tokens from './api/routes/tokens.js'
// resources
import bankData from './api/routes/bankData.js'
import paymentInitiation from './api/routes/paymentInitiation.js'
import productsAndLeads from './api/routes/productsAndLeads.js'
import confirmationOfPayee from './api/routes/confirmationOfPayee.js'
import authDebug from './api/routes/authDebug.js'




const starterKitPort =
  Number.parseInt(
    process.env.STARTER_KIT_PORT ?? process.env.PORT ?? "1411",
    10
  ) || 1411;
const mcpPortForProxy = process.env.MCP_PORT ?? "9035";
const MCP_TARGET =
  process.env.MCP_SERVER_URL || `http://localhost:${mcpPortForProxy}`;

const app = express();

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});

app.use(
  ['/mcp', '/mcp/messages', '/widgets', '/assets'],
  createProxyMiddleware({
    target: MCP_TARGET,
    changeOrigin: true,
    ws: true,
    logLevel: 'warn',
    pathRewrite: (_path, req) => req.originalUrl,
    onProxyReq: (proxyReq, req) => {
      // Preserve the original host for dynamic API base detection
      if (req.headers.host) {
        proxyReq.setHeader('X-Forwarded-Host', req.headers.host);
      }
      // Preserve protocol (http/https)
      const protocol = req.headers['x-forwarded-proto'] || (req.connection.encrypted ? 'https' : 'http');
      proxyReq.setHeader('X-Forwarded-Proto', protocol);
    },
  })
);

const corsOptions = {
  origin: true,
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "authorization",
    "content-type",
    "x-requested-with",
    "accept",
    "ngrok-skip-browser-warning",
  ],
  maxAge: 600,
};

app.use(express.json());
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

const shouldLogRequest = (url = '') =>
  url.startsWith('/consent-create') ||
  url.startsWith('/token') ||
  url.startsWith('/register') ||
  url.startsWith('/open-finance');

app.use((req, res, next) => {
  if (!shouldLogRequest(req.originalUrl)) {
    return next();
  }
  const start = Date.now();
  logInfo(`→ ${req.method} ${req.originalUrl}`, {
    query: req.query,
    body: summarizePayload(req.body),
  });
  res.on('finish', () => {
    logInfo(`← ${req.method} ${req.originalUrl}`, {
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
});


// API routes
app.use('', register);

app.use('/consent-create', consentCreate);
app.use('/token', tokens);

app.use('/open-finance/account-information/v1.2', bankData);
app.use('/open-finance/payment/v1.2', paymentInitiation);
app.use('/open-finance/product/v1.2', productsAndLeads);
app.use('/open-finance/confirmation-of-payee/v1.2', confirmationOfPayee);
app.use('', authDebug);

// Swagger UI
const file = fs.readFileSync("./api/swagger.yaml", "utf8");
const swaggerSpec = YAML.parse(file);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));


// client
// Vite middleware setup (dev mode)
const vite = await createViteServer({
  server: { middlewareMode: true },
  root: path.join(__dirname, "./client"),
  appType: "custom", // don't serve index.html automatically
});

app.use(vite.middlewares);


// Let Vite handle /client routes
app.use(async (req, res, next) => {
  try {
    // Serve index.html for any route under /client (including deep links)
    if (!req.originalUrl.startsWith("/client")) return next();

    const templatePath = path.join(vite.config.root, "index.html");
    let template = await fs.promises.readFile(templatePath, "utf-8");

    // Let Vite transform index.html (for dev mode, HMR, env vars, etc.)
    template = await vite.transformIndexHtml(req.originalUrl, template);

    res.status(200).set({ "Content-Type": "text/html" }).end(template);
  } catch (err) {
    vite.ssrFixStacktrace(err);
    next(err);
  }
});

// Start server
const PORT = starterKitPort;
app.use((err, req, res, next) => {
  logError(`Unhandled error on ${req.method} ${req.originalUrl}`, {
    message: err.message,
    stack: err.stack,
  });
  res
    .status(err.status || 500)
    .json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () =>
  logInfo(`Starter kit listening`, {
    port: PORT,
    proxyingMcpTarget: MCP_TARGET,
  })
);
