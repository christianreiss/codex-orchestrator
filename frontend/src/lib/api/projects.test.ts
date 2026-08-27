import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";

import type {
  CreateProjectPayload,
  FeedbackPayload,
  FilePayload,
  NotePayload,
  TodoPayload,
} from "./projects";
import type { ProjectAbout } from "./types";

// `projects.ts` interpolates every path by hand and hands the finished string to
// the real API client. Stubbing `./client` keeps the module importable outside
// the browser and records the verb, path and payload each builder puts on the
// wire.
const CLIENT_STUB = "stub:api-client";

const clientStubSource = `
/** Every request the builders issued, in call order; shared with the test. */
export const calls = [];

const record = (method, path, body) => {
  calls.push({ method, path, body });
  return Promise.resolve(null);
};

export const api = {
  get: (path) => record("GET", path, undefined),
  post: (path, body) => record("POST", path, body),
  delete: (path) => record("DELETE", path, undefined),
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

interface RecordedCall {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: unknown;
}

// `node --test` strips types but resolves specifiers verbatim, so the runtime
// imports need specifiers TypeScript rejects statically; hiding them behind
// variables keeps both happy. Types come from the casts.
const clientModule: string = CLIENT_STUB;
const { calls } = (await import(clientModule)) as { calls: RecordedCall[] };

const projectsModule: string = "./projects.ts";
const projects = (await import(projectsModule)) as typeof import("./projects");

/** A slug carrying each character class the path segments have to escape. */
const SLUG = "a/b c-ü";
const ENCODED = "a%2Fb%20c-%C3%BC";

/** The row id every id-bearing path is exercised with. */
const ID = 7;
/** Cards are addressed by their uuid in the admin API, not by their number. */
const CARD_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const COLUMN_ID = "11111111-1111-4111-8111-111111111111";

const ABOUT: ProjectAbout = { title: "Atlas", description: "the coordination project" };
const CREATE_PAYLOAD: CreateProjectPayload = {
  slug: SLUG,
  about: ABOUT,
  roster_markdown: "# roster",
};
const NOTE_PAYLOAD: NotePayload = { header: "header", body: "body" };
const TODO_PAYLOAD: TodoPayload = { title: "title", detail: "detail" };
const FILE_PAYLOAD: FilePayload = {
  stored_name: "notes.md",
  mime_type: "text/markdown",
  description: null,
  content: "file body",
};
const FEEDBACK_PAYLOAD: FeedbackPayload = { type: "bug", title: "title", body: "body" };

interface BuilderCase {
  /** The exported builder, as the surface test matches it. */
  name: string;
  label?: string;
  call: () => Promise<unknown>;
  method: RecordedCall["method"];
  path: string;
  body: unknown;
  /** Whether the slug reaches the path, and so has to survive encoding. */
  slugged: boolean;
}

const BUILDER_CASES: BuilderCase[] = [
  {
    name: "fetchProjectsState",
    call: () => projects.fetchProjectsState(),
    method: "GET",
    path: "/admin/projects/state",
    body: undefined,
    slugged: false,
  },
  {
    name: "updateProjectsState",
    label: "updateProjectsState(true)",
    call: () => projects.updateProjectsState(true),
    method: "POST",
    path: "/admin/projects/state",
    body: { enabled: true },
    slugged: false,
  },
  {
    name: "updateProjectsState",
    label: "updateProjectsState(false)",
    call: () => projects.updateProjectsState(false),
    method: "POST",
    path: "/admin/projects/state",
    body: { enabled: false },
    slugged: false,
  },
  {
    name: "fetchProjects",
    call: () => projects.fetchProjects(),
    method: "GET",
    // The list lives at the bare base, without a trailing segment or slash.
    path: "/admin/projects",
    body: undefined,
    slugged: false,
  },
  {
    name: "createProject",
    call: () => projects.createProject(CREATE_PAYLOAD),
    method: "POST",
    // The new slug rides in the body, so the path stays the bare base.
    path: "/admin/projects",
    body: { slug: SLUG, about: ABOUT, roster_markdown: "# roster" },
    slugged: false,
  },
  {
    name: "deleteProject",
    call: () => projects.deleteProject(SLUG),
    method: "DELETE",
    path: `/admin/projects/${ENCODED}`,
    body: undefined,
    slugged: true,
  },
  {
    name: "fetchProject",
    call: () => projects.fetchProject(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}`,
    body: undefined,
    slugged: true,
  },
  {
    name: "updateAbout",
    call: () => projects.updateAbout(SLUG, ABOUT),
    method: "POST",
    path: `/admin/projects/${ENCODED}/about`,
    body: { about: ABOUT },
    slugged: true,
  },
  {
    name: "updateRoster",
    call: () => projects.updateRoster(SLUG, "# roster"),
    method: "POST",
    path: `/admin/projects/${ENCODED}/roster`,
    body: { roster_markdown: "# roster" },
    slugged: true,
  },
  {
    name: "assistProject",
    call: () => projects.assistProject(SLUG),
    method: "POST",
    path: `/admin/projects/${ENCODED}/assist`,
    // The assist run takes no arguments, but still posts an object.
    body: {},
    slugged: true,
  },
  {
    name: "fetchChanges",
    label: "fetchChanges(slug)",
    call: () => projects.fetchChanges(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}/changes`,
    body: undefined,
    slugged: true,
  },
  {
    name: "fetchNotes",
    call: () => projects.fetchNotes(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}/notes`,
    body: undefined,
    slugged: true,
  },
  {
    name: "createNote",
    call: () => projects.createNote(SLUG, NOTE_PAYLOAD),
    method: "POST",
    path: `/admin/projects/${ENCODED}/notes`,
    body: { header: "header", body: "body" },
    slugged: true,
  },
  {
    name: "updateNote",
    call: () => projects.updateNote(SLUG, ID, NOTE_PAYLOAD),
    // An edit is a POST to the id, not a PUT or a PATCH.
    method: "POST",
    path: `/admin/projects/${ENCODED}/notes/${ID}`,
    body: { header: "header", body: "body" },
    slugged: true,
  },
  {
    name: "deleteNote",
    call: () => projects.deleteNote(SLUG, ID),
    method: "DELETE",
    path: `/admin/projects/${ENCODED}/notes/${ID}`,
    body: undefined,
    slugged: true,
  },
  {
    name: "fetchTodos",
    call: () => projects.fetchTodos(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}/todos`,
    body: undefined,
    slugged: true,
  },
  {
    name: "createTodo",
    call: () => projects.createTodo(SLUG, TODO_PAYLOAD),
    method: "POST",
    path: `/admin/projects/${ENCODED}/todos`,
    body: { title: "title", detail: "detail" },
    slugged: true,
  },
  {
    name: "updateTodo",
    call: () => projects.updateTodo(SLUG, ID, TODO_PAYLOAD),
    method: "POST",
    path: `/admin/projects/${ENCODED}/todos/${ID}`,
    body: { title: "title", detail: "detail" },
    slugged: true,
  },
  {
    name: "markTodoDone",
    call: () => projects.markTodoDone(SLUG, ID),
    method: "POST",
    path: `/admin/projects/${ENCODED}/todos/${ID}/done`,
    // The flip carries no payload at all, not even an empty object.
    body: undefined,
    slugged: true,
  },
  {
    name: "markTodoUndone",
    call: () => projects.markTodoUndone(SLUG, ID),
    method: "POST",
    path: `/admin/projects/${ENCODED}/todos/${ID}/undone`,
    body: undefined,
    slugged: true,
  },
  {
    name: "deleteTodo",
    call: () => projects.deleteTodo(SLUG, ID),
    method: "DELETE",
    path: `/admin/projects/${ENCODED}/todos/${ID}`,
    body: undefined,
    slugged: true,
  },
  {
    name: "fetchBoard",
    call: () => projects.fetchBoard(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}/board`,
    body: undefined,
    slugged: true,
  },
  {
    name: "fetchBoardState",
    call: () => projects.fetchBoardState(),
    // Outside /admin/projects/… on purpose: `board` there would be a slug.
    method: "GET",
    path: "/admin/project-board/state",
    body: undefined,
    slugged: false,
  },
  {
    name: "setBoardEnabled",
    call: () => projects.setBoardEnabled(true),
    method: "POST",
    path: "/admin/project-board/state",
    body: { enabled: true },
    slugged: false,
  },
  {
    name: "createCard",
    call: () => projects.createCard(SLUG, { title: "t" }),
    method: "POST",
    path: `/admin/projects/${ENCODED}/board/cards`,
    body: { title: "t" },
    slugged: true,
  },
  {
    name: "updateCard",
    call: () => projects.updateCard(SLUG, CARD_ID, { title: "t" }),
    method: "POST",
    path: `/admin/projects/${ENCODED}/board/cards/${CARD_ID}`,
    body: { title: "t" },
    slugged: true,
  },
  {
    name: "moveCard",
    call: () => projects.moveCard(SLUG, CARD_ID, "coding"),
    method: "POST",
    path: `/admin/projects/${ENCODED}/board/cards/${CARD_ID}/move`,
    // No `note` key at all when none was given, rather than an explicit null.
    body: { column: "coding" },
    slugged: true,
  },
  {
    name: "releaseCard",
    call: () => projects.releaseCard(SLUG, CARD_ID, "wedged"),
    method: "POST",
    path: `/admin/projects/${ENCODED}/board/cards/${CARD_ID}/release`,
    body: { reason: "wedged" },
    slugged: true,
  },
  {
    name: "deleteCard",
    call: () => projects.deleteCard(SLUG, CARD_ID),
    method: "DELETE",
    path: `/admin/projects/${ENCODED}/board/cards/${CARD_ID}`,
    body: undefined,
    slugged: true,
  },
  {
    name: "updateColumn",
    call: () => projects.updateColumn(SLUG, COLUMN_ID, { wip_limit: 3 }),
    method: "POST",
    path: `/admin/projects/${ENCODED}/board/columns/${COLUMN_ID}`,
    body: { wip_limit: 3 },
    slugged: true,
  },
  {
    name: "fetchFiles",
    call: () => projects.fetchFiles(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}/files`,
    body: undefined,
    slugged: true,
  },
  {
    name: "upsertFile",
    call: () => projects.upsertFile(SLUG, FILE_PAYLOAD),
    method: "POST",
    // Upserts key on `stored_name` in the body, so there is no id segment.
    path: `/admin/projects/${ENCODED}/files`,
    body: {
      stored_name: "notes.md",
      mime_type: "text/markdown",
      description: null,
      content: "file body",
    },
    slugged: true,
  },
  {
    name: "deleteFile",
    call: () => projects.deleteFile(SLUG, ID),
    method: "DELETE",
    path: `/admin/projects/${ENCODED}/files/${ID}`,
    body: undefined,
    slugged: true,
  },
  {
    name: "fetchFeedback",
    call: () => projects.fetchFeedback(SLUG),
    method: "GET",
    path: `/admin/projects/${ENCODED}/feedback`,
    body: undefined,
    slugged: true,
  },
  {
    name: "createFeedback",
    call: () => projects.createFeedback(SLUG, FEEDBACK_PAYLOAD),
    method: "POST",
    path: `/admin/projects/${ENCODED}/feedback`,
    body: { type: "bug", title: "title", body: "body" },
    slugged: true,
  },
];

beforeEach(() => {
  calls.length = 0;
});

describe("request builders", () => {
  for (const builderCase of BUILDER_CASES) {
    const label = builderCase.label ?? builderCase.name;

    it(`${label} issues ${builderCase.method} ${builderCase.path}`, async () => {
      await builderCase.call();
      assert.deepEqual(calls, [
        { method: builderCase.method, path: builderCase.path, body: builderCase.body },
      ]);
    });
  }
});

describe("slug encoding", () => {
  const SLUGGED_CASES = BUILDER_CASES.filter((builderCase) => builderCase.slugged);

  it("covers every builder that takes a slug", () => {
    assert.equal(SLUGGED_CASES.length, 28);
  });

  for (const builderCase of SLUGGED_CASES) {
    const label = builderCase.label ?? builderCase.name;

    it(`${label} percent-encodes the slug segment`, async () => {
      await builderCase.call();
      const { path } = calls[0];

      // ["", "admin", "projects", "<slug>", ...] -- an unescaped "/" in the
      // slug would split into an extra segment and shift everything after it.
      const segments = path.split("/");
      assert.equal(segments[3], ENCODED);
      assert.equal(decodeURIComponent(segments[3]), SLUG);
      assert.ok(!path.includes(SLUG), "the raw slug must not survive into the path");
      assert.ok(!path.includes(" "), "the space must be escaped");
      assert.ok(!path.includes("ü"), "the non-ASCII character must be escaped");
    });
  }
});

describe("fetchChanges since filter", () => {
  const changesPath = async (...args: [] | [number]): Promise<string> => {
    calls.length = 0;
    await projects.fetchChanges(SLUG, ...args);
    return calls[0].path;
  };

  const BASE = `/admin/projects/${ENCODED}/changes`;

  it("omits the query string when nothing has been seen yet", async () => {
    assert.equal(await changesPath(), BASE);
    assert.equal(await changesPath(0), BASE);
  });

  it("omits the query string for a negative cursor", async () => {
    assert.equal(await changesPath(-1), BASE);
    assert.equal(await changesPath(-42), BASE);
  });

  it("appends the cursor once there is one", async () => {
    assert.equal(await changesPath(1), `${BASE}?since=1`);
    assert.equal(await changesPath(42), `${BASE}?since=42`);
    assert.equal(await changesPath(9007199254740991), `${BASE}?since=9007199254740991`);
  });
});

describe("projectKeys", () => {
  it("keys the module state and the list", () => {
    assert.deepEqual(projects.projectKeys.state, ["projects", "state"]);
    assert.deepEqual(projects.projectKeys.list, ["projects"]);
  });

  it("keys each per-project view", () => {
    assert.deepEqual(projects.projectKeys.detail(SLUG), ["project", SLUG]);
    assert.deepEqual(projects.projectKeys.notes(SLUG), ["project", SLUG, "notes"]);
    assert.deepEqual(projects.projectKeys.todos(SLUG), ["project", SLUG, "todos"]);
    assert.deepEqual(projects.projectKeys.files(SLUG), ["project", SLUG, "files"]);
    assert.deepEqual(projects.projectKeys.feedback(SLUG), ["project", SLUG, "feedback"]);
    assert.deepEqual(projects.projectKeys.changes(SLUG), ["project", SLUG, "changes"]);
  });

  it("keeps every per-project key under the detail prefix", () => {
    // Invalidating `detail` has to sweep the sub-views with it, which
    // svelte-query only does on a shared key prefix.
    const detail = projects.projectKeys.detail(SLUG);
    const subViews = [
      projects.projectKeys.notes(SLUG),
      projects.projectKeys.todos(SLUG),
      projects.projectKeys.files(SLUG),
      projects.projectKeys.feedback(SLUG),
      projects.projectKeys.changes(SLUG),
    ];

    assert.deepEqual(detail, ["project", SLUG]);
    for (const key of subViews) {
      assert.deepEqual(key.slice(0, detail.length), detail);
    }
  });

  it("keeps the slug raw in the key, unlike the path", () => {
    assert.equal(projects.projectKeys.detail(SLUG)[1], SLUG);
  });
});

describe("module surface", () => {
  /** Every runtime export, so a new builder cannot slip past the table above. */
  const EXPECTED_EXPORTS = [
    "assistProject",
    "createFeedback",
    "createNote",
    "createProject",
    "createTodo",
    "createCard",
    "deleteCard",
    "deleteFile",
    "deleteNote",
    "deleteProject",
    "deleteTodo",
    "fetchBoard",
    "fetchBoardState",
    "fetchChanges",
    "fetchFeedback",
    "fetchFiles",
    "fetchNotes",
    "fetchProject",
    "fetchProjects",
    "fetchProjectsState",
    "fetchTodos",
    "markTodoDone",
    "markTodoUndone",
    "moveCard",
    "projectKeys",
    "releaseCard",
    "setBoardEnabled",
    "updateCard",
    "updateColumn",
    "updateAbout",
    "updateNote",
    "updateProjectsState",
    "updateRoster",
    "updateTodo",
    "upsertFile",
  ].sort();

  it("exports exactly the documented surface", () => {
    assert.deepEqual(Object.keys(projects).sort(), EXPECTED_EXPORTS);
  });

  it("drives every exported builder", () => {
    const driven = new Set(BUILDER_CASES.map((builderCase) => builderCase.name));
    const exported = Object.entries(projects)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    assert.deepEqual(
      exported.filter((name) => !driven.has(name)),
      [],
      "every builder needs a case in BUILDER_CASES",
    );
    assert.deepEqual(
      [...driven].filter((name) => !exported.includes(name)),
      [],
      "every case must name a builder the module still exports",
    );
  });
});
