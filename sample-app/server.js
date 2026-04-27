const http = require("node:http");

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "sample-app" }));
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Brimble Sample App</title>
        <style>
          body {
            margin: 0;
            min-height: 100vh;
            display: grid;
            place-items: center;
            background: linear-gradient(135deg, #101820, #1d5f52);
            color: #f8f7f2;
            font-family: ui-sans-serif, system-ui, sans-serif;
          }

          main {
            padding: 3rem;
            border-radius: 1.5rem;
            border: 1px solid rgba(248, 247, 242, 0.2);
            background: rgba(248, 247, 242, 0.08);
            backdrop-filter: blur(12px);
            max-width: 42rem;
          }
        </style>
      </head>
      <body>
        <main>
          <p>Brimble sample app</p>
          <h1>Container reached through the deployment pipeline.</h1>
          <p>This fixture exists to verify Railpack build, Docker runtime, and Caddy routing.</p>
        </main>
      </body>
    </html>
  `);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`sample-app listening on ${port}`);
});

