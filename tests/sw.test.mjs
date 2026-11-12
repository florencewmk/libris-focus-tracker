import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const origin = "https://example.test";
const base = "/libris-focus-tracker/";
const template = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const assets = [base, `${base}index.html`, `${base}assets/app-v1.js`, `${base}assets/app-v1.css`];
const current = `libris-offline:${base}:test-v1`;

function worker() {
  const events = new Map();
  const deleted = [];
  const stores = new Map();
  let fetcher = async (request) => new Response(request.url.endsWith(".js") ? "app-v1" : "shell-v1");
  const keyFor = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const items = stores.get(name);
      return {
        async addAll(requests) {
          const fetched = await Promise.all(requests.map(async (request) => [keyFor(request), await fetcher(request)]));
          for (const [url, response] of fetched) items.set(url, response);
        },
        async match(request) { return items.get(keyFor(request))?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deleted.push(name); return stores.delete(name); },
  };
  const source = template
    .replace('"__LIBRIS_BASE__"', JSON.stringify(base))
    .replace('"__LIBRIS_REVISION__"', '"test-v1"')
    .replace('"__LIBRIS_SHELL__"', '"shell-v1"')
    .replace('["__LIBRIS_PRECACHE__"]', JSON.stringify(assets));
  vm.runInNewContext(source, {
    URL, Response, caches,
    Request: class extends Request { constructor(path, options) { super(new URL(path, origin), options); } },
    fetch: (request) => fetcher(request),
    self: {
      location: { origin },
      addEventListener(name, callback) { events.set(name, callback); },
      clients: { async claim() {} },
      registration: { async update() {} },
      skipWaiting() { throw new Error("Updates must wait for existing tabs"); },
    },
  });
  return {
    caches, stores, deleted,
    network(callback) { fetcher = callback; },
    async dispatch(name, request) {
      const waits = [];
      let response;
      events.get(name)({
        request,
        waitUntil(promise) { waits.push(promise); },
        respondWith(promise) { response = promise; },
      });
      await Promise.all(waits);
      return response;
    },
  };
}

test("installation caches the shell and app bundles; cold offline navigation accepts query strings", async () => {
  const app = worker();
  await app.dispatch("install");
  assert.equal(app.stores.get(current).size, assets.length);
  app.network(async () => { throw new Error("offline"); });
  const response = await app.dispatch("fetch", { url: `${origin}${base}?installed=1`, method: "GET", mode: "navigate" });
  assert.equal(await response.text(), "shell-v1");
  const script = await app.dispatch("fetch", { url: `${origin}${base}assets/app-v1.js`, method: "GET", mode: "cors" });
  assert.equal(await script.text(), "app-v1");
});

test("a new online shell cannot replace the old cached build before its worker activates", async () => {
  const app = worker();
  await app.dispatch("install");
  app.network(async () => new Response("shell-v2-with-new-bundle"));
  const response = await app.dispatch("fetch", { url: `${origin}${base}`, method: "GET", mode: "navigate" });
  assert.equal(await response.text(), "shell-v1");
});

test("installation rejects a shell from another deployment and removes its incomplete cache", async () => {
  const app = worker();
  app.network(async () => new Response("shell-v2"));
  await assert.rejects(app.dispatch("install"), /app changed during download/);
  assert.equal(app.stores.has(current), false);
});

test("missing scripts, API calls, other apps, and external requests never receive an HTML fallback", async () => {
  const app = worker();
  await app.dispatch("install");
  for (const url of [
    `${origin}${base}assets/missing.js`,
    `${origin}${base}api/study_sessions`,
    `${origin}/other-app/assets/app-v1.js`,
    `https://external.test${base}assets/app-v1.js`,
  ]) assert.equal(await app.dispatch("fetch", { url, method: "GET", mode: "cors" }), undefined);
  assert.equal(await app.dispatch("fetch", { url: `${origin}${base}`, method: "POST", mode: "navigate" }), undefined);
});

test("activation deletes only this Libris app's prior versions", async () => {
  const app = worker();
  const old = `libris-offline:${base}:old-version`;
  const unrelated = ["another-app-cache", "libris-offline:/other-path/:v1"];
  for (const name of [current, old, "libris-focus-pages-v3", ...unrelated]) await app.caches.open(name);
  await app.dispatch("activate");
  assert.deepEqual(app.deleted.sort(), [old, "libris-focus-pages-v3"].sort());
  assert.deepEqual((await app.caches.keys()).sort(), [current, ...unrelated].sort());
});
