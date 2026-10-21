import { createRequire } from "node:module";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
// Resolve the HTTP stack actually used by the installed TronWeb dependency.
const tronwebRequire = createRequire(require.resolve("tronweb"));
const axiosRequire = createRequire(tronwebRequire.resolve("axios"));
const redirects = axiosRequire("follow-redirects");
const servers: Server[] = [];

async function listen(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function getHeaders(url: string, options: Record<string, unknown>) {
  return new Promise<Record<string, string>>((resolve, reject) => {
    const request = redirects.http.get(url, options, (response: any) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("Loopback fixture timed out")));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("redirect credential boundaries", () => {
  // Loopback fixtures and inert markers only; no product APIs or real credentials.
  async function crossOrigin(options: Record<string, unknown>) {
    const initial: Record<string, unknown>[] = [];
    const target = await listen((request, response) => {
      response.end(JSON.stringify(request.headers));
    });
    const source = await listen((request, response) => {
      initial.push(request.headers);
      response.writeHead(302, { location: `${target}/received` });
      response.end();
    });
    // Node does not auto-add Host when raw array-form headers are supplied.
    if (Array.isArray(options.headers)) {
      options = { ...options, headers: ["Host", new URL(source).host, ...options.headers] };
    }
    return { initial, forwarded: await getHeaders(`${source}/start`, options) };
  }

  it("strips built-in credentials from object-form headers across origins", async () => {
    const { initial, forwarded } = await crossOrigin({ headers: {
      Authorization: "offline-auth-marker", Cookie: "offline-cookie-marker",
      "Proxy-Authorization": "offline-proxy-marker", "X-Keep": "visible",
    } });
    assert.equal(initial[0].authorization, "offline-auth-marker");
    for (const key of ["authorization", "cookie", "proxy-authorization"]) {
      assert.equal(Object.hasOwn(forwarded, key), false);
    }
    assert.equal(forwarded["x-keep"], "visible");
  });

  // GHSA-q3jh-wrc6-jgq8: raw header arrays must not bypass credential stripping.
  it("strips built-in credentials from array-form headers across origins", async () => {
    const { initial, forwarded } = await crossOrigin({ headers: [
      "Authorization", "offline-auth-marker", "Cookie", "offline-cookie-marker",
      "Proxy-Authorization", "offline-proxy-marker", "X-Keep", "visible",
    ] });
    assert.equal(initial[0].authorization, "offline-auth-marker");
    for (const key of ["authorization", "cookie", "proxy-authorization"]) {
      assert.equal(Object.hasOwn(forwarded, key), false);
    }
    assert.equal(forwarded["x-keep"], "visible");
  });

  // GHSA-8r9p-f939-6h3c: valid header-name metacharacters must be escaped.
  for (const name of ["X-Api^Key", "X-Token|Secret"]) {
    it(`strips declared sensitive header ${name}`, async () => {
      const { initial, forwarded } = await crossOrigin({
        headers: { [name]: "offline-custom-marker", "X-Keep": "visible" },
        sensitiveHeaders: [name],
      });
      assert.equal(initial[0][name.toLowerCase()], "offline-custom-marker");
      assert.equal(Object.hasOwn(forwarded, name.toLowerCase()), false);
      assert.equal(forwarded["x-keep"], "visible");
    });
  }

  it("preserves credentials for a same-origin relative redirect", async () => {
    const source = await listen((request, response) => {
      if (request.url === "/start") {
        response.writeHead(302, { location: "/received" });
        response.end();
      } else {
        response.end(JSON.stringify(request.headers));
      }
    });
    const forwarded = await getHeaders(`${source}/start`, { headers: {
      Authorization: "offline-auth-marker", Cookie: "offline-cookie-marker",
    } });
    assert.equal(forwarded.authorization, "offline-auth-marker");
    assert.equal(forwarded.cookie, "offline-cookie-marker");
  });
  it("preserves TronWeb provider GET and JSON POST behavior", async () => {
    const source = await listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          method: request.method, path: request.url, body,
          marker: request.headers["x-offline-marker"],
        }));
      });
    });
    const { HttpProvider } = require("tronweb").providers;
    const provider = new HttpProvider(source, 2_000, "", "", {
      "X-Offline-Marker": "provider-fixture",
    });
    const query = await provider.request("/offline-query", { value: "a b" });
    const url = new URL(query.path, source);
    assert.equal(query.method, "GET");
    assert.equal(url.pathname, "/offline-query");
    assert.equal(url.searchParams.get("value"), "a b");
    assert.equal(query.marker, "provider-fixture");
    const post = await provider.request("/offline-post", { amount: "123" }, "post");
    assert.equal(post.method, "POST");
    assert.equal(post.path, "/offline-post");
    assert.deepEqual(JSON.parse(post.body), { amount: "123" });
    assert.equal(post.marker, "provider-fixture");
  });

});
