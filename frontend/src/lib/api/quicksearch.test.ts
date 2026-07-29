import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

// `quicksearch.ts` reaches the network only through `./client`. Stubbing it
// keeps the module importable outside the browser, records the path each
// fetcher asks for and hands back whatever envelope the test staged.
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
/** Every path passed to \`api.get\`, in call order; shared with the test. */
export const calls = [];

/** Envelope the next \`api.get\` resolves with; staged by the test. */
let response = null;
export const setResponse = (next) => {
  response = next;
};

export const api = {
  get: (path) => {
    calls.push(path);
    return Promise.resolve(response);
  },
};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./client") return { url: CLIENT_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === CLIENT_STUB) {
      return { format: "module", shortCircuit: true, source: clientStubSource };
    }
    return nextLoad(url, context);
  },
});

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls, setResponse } = (await import(clientModule)) as {
  calls: string[];
  setResponse: (next: unknown) => void;
};

const quicksearchModule: string = "./quicksearch.ts";
const { fetchHosts, fetchProjects, fetchSkills, fetchUsers, quickSearchKeys } = (await import(
  quicksearchModule
)) as typeof import("./quicksearch");

/** Stages `envelope` as the next response and runs `fetch` against it. */
async function fetchWith<T>(fetch: () => Promise<T[]>, envelope: unknown): Promise<T[]> {
  setResponse(envelope);
  return await fetch();
}

/** The path the most recent fetcher asked the client for. */
function lastPath(): string {
  const path = calls.at(-1);
  assert.ok(path, "expected a request to have been issued");
  return path;
}

describe("fetchHosts", () => {
  it("asks the admin hosts endpoint", async () => {
    await fetchWith(fetchHosts, { hosts: [] });
    assert.equal(lastPath(), "/admin/hosts");
  });

  it("reads the root-level hosts array", async () => {
    const rows = await fetchWith(fetchHosts, {
      hosts: [
        { id: 1, fqdn: "a.example.com", status: "ok", secure: true, vip: false },
        { id: 2, fqdn: "b.example.com" },
      ],
    });
    assert.deepEqual(rows, [
      { id: 1, fqdn: "a.example.com", status: "ok", secure: true, vip: false },
      { id: 2, fqdn: "b.example.com", status: null, secure: undefined, vip: undefined },
    ]);
  });

  it("returns nothing when the envelope carries no hosts array", async () => {
    assert.deepEqual(await fetchWith(fetchHosts, {}), []);
    assert.deepEqual(await fetchWith(fetchHosts, { hosts: null }), []);
    assert.deepEqual(await fetchWith(fetchHosts, { hosts: "a.example.com" }), []);
    assert.deepEqual(await fetchWith(fetchHosts, { hosts: { id: 1, fqdn: "a.example.com" } }), []);
    assert.deepEqual(await fetchWith(fetchHosts, null), []);
  });

  it("skips rows that are not objects", async () => {
    const rows = await fetchWith(fetchHosts, {
      hosts: [null, undefined, "a.example.com", 7, true, { id: 1, fqdn: "kept.example.com" }],
    });
    assert.deepEqual(
      rows.map((h) => h.fqdn),
      ["kept.example.com"],
    );
  });

  it("skips rows without a usable id or fqdn", async () => {
    const rows = await fetchWith(fetchHosts, {
      hosts: [
        { fqdn: "no-id.example.com" },
        { id: null, fqdn: "null-id.example.com" },
        { id: 3 },
        { id: 4, fqdn: "" },
        { id: 5, fqdn: 5 },
        { id: 6, fqdn: "kept.example.com" },
      ],
    });
    assert.deepEqual(
      rows.map((h) => h.fqdn),
      ["kept.example.com"],
    );
  });

  it("keeps a host whose id is 0", async () => {
    const rows = await fetchWith(fetchHosts, { hosts: [{ id: 0, fqdn: "zero.example.com" }] });
    assert.deepEqual(
      rows.map((h) => h.id),
      [0],
    );
  });

  it("accepts a numeric-string id and rejects anything else non-numeric", async () => {
    const rows = await fetchWith(fetchHosts, {
      hosts: [
        { id: "42", fqdn: "numeric.example.com" },
        { id: "-7", fqdn: "negative.example.com" },
        { id: "4.5", fqdn: "fraction.example.com" },
        { id: "abc", fqdn: "word.example.com" },
        { id: " 8 ", fqdn: "padded.example.com" },
        { id: Number.NaN, fqdn: "nan.example.com" },
        { id: Number.POSITIVE_INFINITY, fqdn: "infinite.example.com" },
        { id: true, fqdn: "boolean.example.com" },
      ],
    });
    assert.deepEqual(
      rows.map((h) => [h.fqdn, h.id]),
      [
        ["numeric.example.com", 42],
        ["negative.example.com", -7],
      ],
    );
  });

  it("maps booleans and 0/1 onto secure and vip, ignoring strings", async () => {
    const rows = await fetchWith(fetchHosts, {
      hosts: [
        { id: 1, fqdn: "a.example.com", secure: true, vip: false },
        { id: 2, fqdn: "b.example.com", secure: 1, vip: 0 },
        { id: 3, fqdn: "c.example.com", secure: "true", vip: "1" },
        { id: 4, fqdn: "d.example.com", secure: null },
        { id: 5, fqdn: "e.example.com" },
      ],
    });
    assert.deepEqual(
      rows.map((h) => [h.secure, h.vip]),
      [
        [true, false],
        [true, false],
        [undefined, undefined],
        [undefined, undefined],
        [undefined, undefined],
      ],
    );
  });

  it("nulls a status that is not a string", async () => {
    const rows = await fetchWith(fetchHosts, {
      hosts: [
        { id: 1, fqdn: "a.example.com", status: "ok" },
        { id: 2, fqdn: "b.example.com", status: 3 },
        { id: 3, fqdn: "c.example.com", status: null },
        { id: 4, fqdn: "d.example.com" },
      ],
    });
    assert.deepEqual(
      rows.map((h) => h.status),
      ["ok", null, null, null],
    );
  });
});

describe("fetchProjects", () => {
  it("asks the admin projects endpoint", async () => {
    await fetchWith(fetchProjects, { projects: [] });
    assert.equal(lastPath(), "/admin/projects");
  });

  it("reads the root-level projects array", async () => {
    const rows = await fetchWith(fetchProjects, {
      projects: [
        { slug: "alpha", name: "Alpha", title: "Alpha Labs", description: "the first" },
        { slug: "beta" },
      ],
    });
    assert.deepEqual(rows, [
      { slug: "alpha", name: "Alpha", title: "Alpha Labs", description: "the first" },
      { slug: "beta", name: null, title: null, description: null },
    ]);
  });

  it("returns nothing when the envelope carries no projects array", async () => {
    assert.deepEqual(await fetchWith(fetchProjects, {}), []);
    assert.deepEqual(await fetchWith(fetchProjects, { projects: null }), []);
    assert.deepEqual(await fetchWith(fetchProjects, { projects: "alpha" }), []);
    assert.deepEqual(await fetchWith(fetchProjects, { projects: { slug: "alpha" } }), []);
    assert.deepEqual(await fetchWith(fetchProjects, null), []);
  });

  it("skips rows that are not objects", async () => {
    const rows = await fetchWith(fetchProjects, {
      projects: [null, undefined, "alpha", 7, true, { slug: "kept" }],
    });
    assert.deepEqual(
      rows.map((p) => p.slug),
      ["kept"],
    );
  });

  it("skips rows without a usable slug", async () => {
    const rows = await fetchWith(fetchProjects, {
      projects: [
        { name: "no slug" },
        { slug: null },
        { slug: "" },
        { slug: 7 },
        { slug: "kept" },
      ],
    });
    assert.deepEqual(
      rows.map((p) => p.slug),
      ["kept"],
    );
  });

  it("nulls a name, title or description that is not a string", async () => {
    const rows = await fetchWith(fetchProjects, {
      projects: [{ slug: "alpha", name: 7, title: null, description: { text: "x" } }],
    });
    assert.deepEqual(rows, [{ slug: "alpha", name: null, title: null, description: null }]);
  });
});

describe("fetchSkills", () => {
  it("asks the admin skills endpoint", async () => {
    await fetchWith(fetchSkills, { skills: [] });
    assert.equal(lastPath(), "/admin/skills");
  });

  it("reads the root-level skills array", async () => {
    const rows = await fetchWith(fetchSkills, {
      skills: [
        { slug: "review", display_name: "Review", name: "review", description: "reads diffs" },
        { slug: "deploy" },
      ],
    });
    assert.deepEqual(rows, [
      { slug: "review", display_name: "Review", name: "review", description: "reads diffs" },
      { slug: "deploy", display_name: null, name: null, description: null },
    ]);
  });

  it("returns nothing when the envelope carries no skills array", async () => {
    assert.deepEqual(await fetchWith(fetchSkills, {}), []);
    assert.deepEqual(await fetchWith(fetchSkills, { skills: null }), []);
    assert.deepEqual(await fetchWith(fetchSkills, { skills: "review" }), []);
    assert.deepEqual(await fetchWith(fetchSkills, { skills: { slug: "review" } }), []);
    assert.deepEqual(await fetchWith(fetchSkills, null), []);
  });

  it("skips rows that are not objects", async () => {
    const rows = await fetchWith(fetchSkills, {
      skills: [null, undefined, "review", 7, true, { slug: "kept" }],
    });
    assert.deepEqual(
      rows.map((s) => s.slug),
      ["kept"],
    );
  });

  it("skips rows without a usable slug", async () => {
    const rows = await fetchWith(fetchSkills, {
      skills: [
        { display_name: "no slug" },
        { slug: null },
        { slug: "" },
        { slug: 7 },
        { slug: "kept" },
      ],
    });
    assert.deepEqual(
      rows.map((s) => s.slug),
      ["kept"],
    );
  });

  it("nulls a display name, name or description that is not a string", async () => {
    const rows = await fetchWith(fetchSkills, {
      skills: [{ slug: "review", display_name: 7, name: null, description: ["x"] }],
    });
    assert.deepEqual(rows, [{ slug: "review", display_name: null, name: null, description: null }]);
  });
});

describe("fetchUsers", () => {
  it("asks the admin users endpoint", async () => {
    await fetchWith(fetchUsers, { users: [] });
    assert.equal(lastPath(), "/admin/users");
  });

  it("reads the root-level users array", async () => {
    const rows = await fetchWith(fetchUsers, {
      users: [
        { id: 1, username: "ada", name: "Ada", email: "ada@example.com" },
        { id: 2, username: "bo" },
      ],
    });
    assert.deepEqual(rows, [
      { id: 1, username: "ada", name: "Ada", email: "ada@example.com" },
      { id: 2, username: "bo", name: null, email: null },
    ]);
  });

  it("returns nothing when the envelope carries no users array", async () => {
    assert.deepEqual(await fetchWith(fetchUsers, {}), []);
    assert.deepEqual(await fetchWith(fetchUsers, { users: null }), []);
    assert.deepEqual(await fetchWith(fetchUsers, { users: "ada" }), []);
    assert.deepEqual(await fetchWith(fetchUsers, { users: { id: 1, username: "ada" } }), []);
    assert.deepEqual(await fetchWith(fetchUsers, null), []);
  });

  it("skips rows that are not objects", async () => {
    const rows = await fetchWith(fetchUsers, {
      users: [null, undefined, "ada", 7, true, { id: 1, username: "kept" }],
    });
    assert.deepEqual(
      rows.map((u) => u.username),
      ["kept"],
    );
  });

  it("skips rows without a usable id or username", async () => {
    const rows = await fetchWith(fetchUsers, {
      users: [
        { username: "no-id" },
        { id: null, username: "null-id" },
        { id: true, username: "boolean-id" },
        { id: { value: 1 }, username: "object-id" },
        { id: 5 },
        { id: 6, username: "" },
        { id: 7, username: 7 },
        { id: 8, username: "kept" },
      ],
    });
    assert.deepEqual(
      rows.map((u) => u.username),
      ["kept"],
    );
  });

  it("keeps a user whose id is 0", async () => {
    const rows = await fetchWith(fetchUsers, { users: [{ id: 0, username: "zero" }] });
    assert.deepEqual(
      rows.map((u) => u.id),
      [0],
    );
  });

  // Unlike `fetchHosts`, this fetcher falls back to the raw string, so an id
  // that is not an integer survives as a string instead of dropping the row.
  it("narrows a numeric-string id to a number and keeps other strings verbatim", async () => {
    const rows = await fetchWith(fetchUsers, {
      users: [
        { id: "42", username: "numeric" },
        { id: "-7", username: "negative" },
        { id: "4.5", username: "fraction" },
        { id: "u-9", username: "opaque" },
      ],
    });
    assert.deepEqual(
      rows.map((u) => [u.username, u.id]),
      [
        ["numeric", 42],
        ["negative", -7],
        ["fraction", "4.5"],
        ["opaque", "u-9"],
      ],
    );
  });

  it("nulls a name or email that is not a string", async () => {
    const rows = await fetchWith(fetchUsers, {
      users: [{ id: 1, username: "ada", name: 7, email: { address: "ada@example.com" } }],
    });
    assert.deepEqual(rows, [{ id: 1, username: "ada", name: null, email: null }]);
  });
});

describe("quickSearchKeys", () => {
  it("namespaces one tuple per fetcher", () => {
    assert.deepEqual(quickSearchKeys, {
      hosts: ["quicksearch", "hosts"],
      projects: ["quicksearch", "projects"],
      skills: ["quicksearch", "skills"],
      users: ["quicksearch", "users"],
    });
  });
});
