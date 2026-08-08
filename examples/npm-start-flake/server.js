import http from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const sendJson = (response, statusCode, body) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
};

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      status: "ok",
      app: "npm-start-flake",
    });
    return;
  }

  if (request.method === "GET" && request.url === "/") {
    sendJson(response, 200, {
      message: "Hello from an npm run start app deployed by Nix Ship.",
      deploymentId: process.env.DEPLOYMENT_ID ?? null,
      dataDir: process.env.DATA_DIR ?? null,
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

const shutDown = (signal) => {
  console.log(`Received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`npm-start-flake listening on http://${host}:${port}`);
});

process.on("SIGINT", () => shutDown("SIGINT"));
process.on("SIGTERM", () => shutDown("SIGTERM"));
