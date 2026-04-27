const [repoUrl, routeType = "path", routeValue = "smoke-check"] = process.argv.slice(2);

if (!repoUrl) {
  console.error("Usage: pnpm smoke <public-github-url> [path|host] [route-value]");
  process.exit(1);
}

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:8080";

const createResponse = await fetch(`${baseUrl}/api/deployments`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ repoUrl, routeType, routeValue })
});

if (!createResponse.ok) {
  console.error(await createResponse.text());
  process.exit(1);
}

const deployment = await createResponse.json();
console.log(`Queued deployment ${deployment.id}`);

const startedAt = Date.now();

while (Date.now() - startedAt < 180000) {
  const detailResponse = await fetch(`${baseUrl}/api/deployments/${deployment.id}`);
  const detailPayload = await detailResponse.json();
  const current = detailPayload.deployment;

  console.log(`${current.id}: ${current.status}`);

  if (current.status === "running") {
    console.log(`Live URL: ${current.liveUrl}`);
    process.exit(0);
  }

  if (current.status === "failed") {
    console.error(`Deployment failed: ${current.failureReason ?? "unknown error"}`);
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
}

console.error("Smoke test timed out waiting for deployment to complete.");
process.exit(1);

