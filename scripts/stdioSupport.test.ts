import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { codexChildEnvironment, codexDiagnosticFromStderr } from "../server/codex/stdioSupport";
import { shouldProxyHost, startSelectiveProxy } from "../server/selectiveProxy";

const proxyUrl = "http://127.0.0.1:7893";
const environment = codexChildEnvironment({
  NODE_ENV: "test",
  CODEX_WEB_PROXY_URL: proxyUrl,
  HTTPS_PROXY: "http://existing-proxy:8080"
});

assert.equal(environment.HTTP_PROXY, proxyUrl);
assert.equal(environment.HTTPS_PROXY, "http://existing-proxy:8080");
assert.equal(environment.ALL_PROXY, proxyUrl);
assert.equal(environment.WSS_PROXY, proxyUrl);
assert.equal(environment.http_proxy, proxyUrl);
assert.equal(environment.https_proxy, proxyUrl);
assert.equal(environment.all_proxy, proxyUrl);
assert.equal(environment.wss_proxy, proxyUrl);
assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1");
assert.equal(environment.no_proxy, environment.NO_PROXY);
assert.equal(environment.HF_HUB_ENABLE_HF_TRANSFER, undefined);

const injectUrl = "http://127.0.0.1:17995";
const injected = codexChildEnvironment({
  NODE_ENV: "test",
  CODEX_WEB_PROXY_URL: proxyUrl,
  CODEX_WEB_INJECT_PROXY_URL: injectUrl,
  HTTP_PROXY: proxyUrl,
  HTTPS_PROXY: proxyUrl
});
assert.equal(injected.HTTP_PROXY, injectUrl);
assert.equal(injected.HTTPS_PROXY, injectUrl);
assert.equal(injected.ALL_PROXY, injectUrl);
assert.equal(injected.WSS_PROXY, injectUrl);

const withExistingNoProxy = codexChildEnvironment({
  NODE_ENV: "test",
  CODEX_WEB_PROXY_URL: proxyUrl,
  NO_PROXY: "localhost"
});
assert.equal(withExistingNoProxy.NO_PROXY, "localhost");
assert.equal(withExistingNoProxy.no_proxy, "localhost");

const withoutProxyUrl = codexChildEnvironment({ NODE_ENV: "test" });
assert.equal(withoutProxyUrl.HTTP_PROXY, undefined);
assert.equal(withoutProxyUrl.NO_PROXY, undefined);

assert.equal(shouldProxyHost("chatgpt.com"), true);
assert.equal(shouldProxyHost("wss.chatgpt.com:443"), true);
assert.equal(shouldProxyHost("api2.cursor.sh"), true);
assert.equal(shouldProxyHost("api.anthropic.com"), true);
assert.equal(shouldProxyHost("claude.ai"), true);
assert.equal(shouldProxyHost("huggingface.co"), false);
assert.equal(shouldProxyHost("github.com"), false);

const diagnostic = codexDiagnosticFromStderr(
  "ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: Connection reset by peer"
);
assert.equal(diagnostic?.code, "upstream_connection");
assert.equal(diagnostic?.retrying, true);
assert.equal(
  codexDiagnosticFromStderr(
    "ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: tls handshake eof, url: wss://chatgpt.com/backend-api/codex/responses"
  )?.code,
  "upstream_connection"
);
assert.equal(codexDiagnosticFromStderr("WARN codex app-server initialized"), null);

async function testSelectiveConnect() {
  const clashConnects: string[] = [];
  const clash = createServer();
  clash.on("connect", (req, client, head) => {
    clashConnects.push(req.url || "");
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) client.write(head);
    client.end();
  });
  await new Promise<void>((resolve) => clash.listen(0, "127.0.0.1", resolve));
  const clashPort = (clash.address() as { port: number }).port;
  const origin = createServer();
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as { port: number }).port;
  const selective = await startSelectiveProxy({ upstreamUrl: `http://127.0.0.1:${clashPort}` });
  const selectivePort = Number(new URL(selective.url).port);

  const connectThrough = (authority: string) => new Promise<void>((resolve, reject) => {
    const socket = connect(selectivePort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", reject);
  });

  await connectThrough("chatgpt.com:443");
  await connectThrough(`127.0.0.1:${originPort}`);
  assert.deepEqual(clashConnects, ["chatgpt.com:443"]);
  await selective.close();
  await new Promise<void>((resolve, reject) => clash.close((error) => error ? reject(error) : resolve()));
  await new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve()));
}

testSelectiveConnect().then(() => {
  console.log("stdio gateway support tests passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
