// The tools, built only with @mcp-write-safety/kit. Each write tool shows one or more helpers:
//
//   create_note     strict inputs, retry keys (withIdempotency), a receipt
//   update_note     version check (compareAndSet, version required), a receipt or a conflict
//   delete_note     version check on a delete
//   add_tag         a list edit that only adds: destructiveHint false, idempotentHint true
//   remove_tag      a list edit by value, so it cannot land on another element
//   delete_notes    a bulk delete: a selector is required, all-or-nothing, every item named
//   create_notebook a create under a caller-chosen key that never overwrites
//   delete_notebook a delete with no version, and a description that says so

import {
  ToolSet, defineTool, applied, notApplied, itemsResult, compareAndSet, withIdempotency, idempotencyKeyProperty,
  MemoryIdempotencyStore, NotAppliedError, outputSchemaFor, q, type CallToolResult, type JsonSchema, type ReadWith,
} from "@mcp-write-safety/kit";
import { DEFAULT_NOTEBOOK, NOTE_FIELDS, type Note, type NoteFields, type NotesStore, type Status } from "./store.js";

const KEY_TTL_MS = 24 * 60 * 60 * 1000;

const TITLE: JsonSchema = { type: "string", minLength: 1, maxLength: 200, description: "The note's title." };
const BODY: JsonSchema = { type: "string", maxLength: 10_000, description: "The note's text; may be empty." };
const TAG: JsonSchema = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,29}$", description: "A tag: lowercase letters, digits and hyphens, up to 30 characters." };
const TAGS: JsonSchema = { type: "array", items: TAG, maxItems: 20, uniqueItems: true, description: "The whole list of tags." };
const STATUS: JsonSchema = { type: "string", enum: ["open", "archived"] };
const NOTE_ID: JsonSchema = { type: "string", pattern: "^n-[0-9]{1,12}$", description: "The note's id, e.g. \"n-12\"." };
const NOTEBOOK_KEY: JsonSchema = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,39}$", description: "A notebook key: lowercase letters, digits and hyphens." };
const VERSION: JsonSchema = { type: "integer", minimum: 1, description: "The note's version as you last read it (get_note). The write is refused if the note changed since." };

/** A read tool's answer: the data as structured content and as JSON text. */
function data(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

/** The fields of a note that get_note returns and that hold no secret: the allow-list for the state a conflict carries. */
const READABLE_NOTE_FIELDS: Array<keyof Note> = ["id", "notebook", "title", "body", "tags", "status", "version", "created_at", "updated_at"];

/** The structured output of every write tool: only the write-result shape (outputSchema, B-9 advice). */
const WRITE_OUTPUT = outputSchemaFor();

const readNote = (id: string): ReadWith => ({ tool: "get_note", arguments: { id } });
const readNotebooks: ReadWith = { tool: "list_notebooks", arguments: {} };
const readNotes = (notebook?: string): ReadWith => ({ tool: "list_notes", arguments: notebook ? { notebook } : {} });

export function buildTools(store: NotesStore): ToolSet {
  const keys = new MemoryIdempotencyStore({ ttlMs: KEY_TTL_MS });

  // ---------------------------------------------------------------- notebooks

  const listNotebooks = defineTool({
    kind: "read",
    name: "list_notebooks",
    description: "Lists every notebook (key and name).",
    inputSchema: { type: "object", properties: {} },
    hints: { openWorld: false },
    handler: () => data({ notebooks: [...store.notebooks.values()] }),
  });

  const createNotebook = defineTool<{ key: string; name: string }>({
    kind: "write",
    name: "create_notebook",
    description: "Creates a notebook under a key you choose. A key that exists is refused; nothing is overwritten.",
    inputSchema: {
      type: "object",
      properties: { key: NOTEBOOK_KEY, name: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["key", "name"],
    },
    hints: { destructive: false, idempotent: false, openWorld: false },
    readWith: () => readNotebooks,
    outputSchema: WRITE_OUTPUT,
    handler: ({ key, name }) => {
      if (store.notebooks.has(key)) {
        return notApplied({ summary: `notebook ${q(key)} already exists, so it was not created again`, code: "already_exists", operation: "create", object: { type: "notebook", id: key }, readWith: readNotebooks });
      }
      store.notebooks.set(key, { key, name });
      return applied({ summary: `created notebook ${q(key)} named ${q(name)}`, operation: "create", object: { type: "notebook", id: key }, changed: ["/key", "/name"], readWith: readNotebooks });
    },
  });

  const deleteNotebook = defineTool<{ key: string }>({
    kind: "write",
    name: "delete_notebook",
    description: `Deletes an empty notebook. A notebook that holds notes is refused, and so is "${DEFAULT_NOTEBOOK}". Notebooks carry no version, so a stale delete is not detected: a notebook changed since you read it is deleted all the same.`,
    inputSchema: { type: "object", properties: { key: NOTEBOOK_KEY }, required: ["key"] },
    hints: { destructive: true, idempotent: true, openWorld: false },
    readWith: () => readNotebooks,
    outputSchema: WRITE_OUTPUT,
    handler: ({ key }) => {
      const object = { type: "notebook", id: key };
      if (key === DEFAULT_NOTEBOOK) throw new NotAppliedError(`notebook ${q(key)} is the default notebook and cannot be deleted`, { code: "default_notebook", object });
      if (!store.notebooks.has(key)) throw new NotAppliedError(`notebook ${q(key)} was not found`, { code: "not_found", object });
      const held = store.listNotes({ notebook: key }).length;
      if (held) throw new NotAppliedError(`notebook ${q(key)} holds ${held} note(s); delete them first`, { code: "not_empty", object });
      store.notebooks.delete(key);
      return applied({ summary: `deleted notebook ${q(key)}`, operation: "delete", object });
    },
  });

  // ---------------------------------------------------------------- notes: reads

  const listNotes = defineTool<{ notebook?: string; title_prefix?: string; tag?: string }>({
    kind: "read",
    name: "list_notes",
    description: "Lists notes, optionally only those in one notebook, whose title starts with a prefix, or that carry a tag. Each note is given with its id and version.",
    inputSchema: {
      type: "object",
      properties: { notebook: NOTEBOOK_KEY, title_prefix: { type: "string", minLength: 1, maxLength: 200 }, tag: TAG },
    },
    hints: { openWorld: false },
    handler: (f) => data({ notes: store.listNotes(f).map((n) => ({ id: n.id, notebook: n.notebook, title: n.title, tags: n.tags, status: n.status, version: n.version })) }),
  });

  const getNote = defineTool<{ id: string }>({
    kind: "read",
    name: "get_note",
    description: "Returns one note with its version. Pass the version as expected_version when you update or delete the note.",
    inputSchema: { type: "object", properties: { id: NOTE_ID }, required: ["id"] },
    hints: { openWorld: false },
    handler: ({ id }) => {
      const n = store.getNote(id);
      return n ? data({ ...n }) : notApplied({ summary: `note ${q(id)} was not found`, code: "not_found" });
    },
  });

  // ---------------------------------------------------------------- notes: writes

  const createNote = defineTool<Partial<NoteFields> & { notebook?: string; title: string; idempotency_key?: string }>({
    kind: "write",
    name: "create_note",
    description: `Creates a note in a notebook (default "${DEFAULT_NOTEBOOK}") and returns its id and version. Each call without an idempotency_key creates a new note.`,
    inputSchema: {
      type: "object",
      properties: {
        notebook: NOTEBOOK_KEY,
        title: TITLE,
        body: BODY,
        tags: TAGS,
        status: STATUS,
        idempotency_key: idempotencyKeyProperty({ ttlMs: KEY_TTL_MS }),
      },
      required: ["title"],
    },
    hints: { destructive: false, idempotent: false, openWorld: false },
    readWith: (a) => readNotes(a.notebook ?? DEFAULT_NOTEBOOK),
    outputSchema: WRITE_OUTPUT,
    handler: (args) => withIdempotency({ store: keys, scope: "create_note", args, readWith: readNotes(args.notebook ?? DEFAULT_NOTEBOOK) }, async () => {
      const notebook = args.notebook ?? DEFAULT_NOTEBOOK;
      if (!store.notebooks.has(notebook)) return notApplied({ summary: `notebook ${q(notebook)} was not found, so no note was created`, code: "not_found", operation: "create" });
      const n = store.createNote(notebook, { title: args.title, body: args.body ?? "", tags: args.tags ?? [], status: args.status ?? "open" });
      const set = ["title", ...NOTE_FIELDS.filter((f) => f !== "title" && args[f] !== undefined)];
      return applied({
        summary: `created note ${q(n.id)} in notebook ${q(n.notebook)}`,
        operation: "create",
        object: { type: "note", id: n.id, version: n.version, scope: n.notebook },
        changed: set,
        readWith: readNote(n.id),
      });
    }),
  });

  const updateNote = defineTool<Partial<NoteFields> & { id: string; expected_version: number }>({
    kind: "write",
    name: "update_note",
    description: "Sets the fields you send (title, body, tags, status) and leaves the others as they are. tags replaces the whole list; use add_tag or remove_tag to change one tag. Requires expected_version: the write is refused with a conflict, and nothing is changed, if the note changed since that version.",
    inputSchema: {
      type: "object",
      properties: { id: NOTE_ID, expected_version: VERSION, title: TITLE, body: BODY, tags: TAGS, status: STATUS },
      required: ["id", "expected_version"],
    },
    hints: { destructive: true, idempotent: true, openWorld: false },
    readWith: (a) => readNote(a.id),
    outputSchema: WRITE_OUTPUT,
    handler: ({ id, expected_version, ...fields }) => compareAndSet<Note>({
      id,
      type: "note",
      expectedVersion: expected_version,
      readWith: readNote(id),
      read: () => {
        const n = store.getNote(id);
        return n && { version: n.version, state: n };
      },
      write: () => {
        const { note, changed } = store.patchNote(id, fields);
        return { version: note.version, changed };
      },
      conflictFields: READABLE_NOTE_FIELDS,
      summary: (r) => r.changed?.length ? `updated note ${q(id)}; it is now at version ${q(r.version)}` : `note ${q(id)} already had these values; nothing changed`,
    }),
  });

  const deleteNote = defineTool<{ id: string; expected_version: number }>({
    kind: "write",
    name: "delete_note",
    description: "Deletes one note. Requires expected_version: the delete is refused with a conflict, and nothing is deleted, if the note changed since that version.",
    inputSchema: { type: "object", properties: { id: NOTE_ID, expected_version: VERSION }, required: ["id", "expected_version"] },
    hints: { destructive: true, idempotent: true, openWorld: false },
    readWith: (a) => readNote(a.id),
    outputSchema: WRITE_OUTPUT,
    handler: ({ id, expected_version }) => compareAndSet<Note>({
      id,
      type: "note",
      operation: "delete",
      expectedVersion: expected_version,
      readWith: readNote(id),
      read: () => {
        const n = store.getNote(id);
        return n && { version: n.version, state: n };
      },
      write: (cur) => {
        store.deleteNote(id);
        return { version: cur.version };
      },
      conflictFields: READABLE_NOTE_FIELDS,
      summary: () => `deleted note ${q(id)}`,
    }),
  });

  const addTag = defineTool<{ id: string; tag: string }>({
    kind: "write",
    name: "add_tag",
    description: "Adds one tag to a note. A tag the note already has changes nothing. Other tags are kept.",
    inputSchema: { type: "object", properties: { id: NOTE_ID, tag: TAG }, required: ["id", "tag"] },
    hints: { destructive: false, idempotent: true, openWorld: false },
    readWith: (a) => readNote(a.id),
    outputSchema: WRITE_OUTPUT,
    handler: ({ id, tag }) => {
      const n = store.getNote(id);
      const object = { type: "note", id };
      if (!n) return notApplied({ summary: `note ${q(id)} was not found`, code: "not_found", operation: "add_tag", object });
      if (n.tags.includes(tag)) return applied({ summary: `note ${q(id)} already has tag ${q(tag)}; nothing changed`, operation: "add_tag", object: { ...object, version: n.version }, changed: [], readWith: readNote(id) });
      if (n.tags.length >= 20) return notApplied({ summary: `note ${q(id)} already has 20 tags, the most it can hold`, code: "too_many_tags", operation: "add_tag", object });
      const { note, changed } = store.patchNote(id, { tags: [...n.tags, tag] });
      return applied({ summary: `added tag ${q(tag)} to note ${q(id)}`, operation: "add_tag", object: { ...object, version: note.version }, changed, readWith: readNote(id) });
    },
  });

  const removeTag = defineTool<{ id: string; tag: string }>({
    kind: "write",
    name: "remove_tag",
    description: "Removes one tag from a note, by its name, so it never removes another tag. A tag the note does not have changes nothing.",
    inputSchema: { type: "object", properties: { id: NOTE_ID, tag: TAG }, required: ["id", "tag"] },
    hints: { destructive: true, idempotent: true, openWorld: false },
    readWith: (a) => readNote(a.id),
    outputSchema: WRITE_OUTPUT,
    handler: ({ id, tag }) => {
      const n = store.getNote(id);
      const object = { type: "note", id };
      if (!n) return notApplied({ summary: `note ${q(id)} was not found`, code: "not_found", operation: "remove_tag", object });
      if (!n.tags.includes(tag)) return applied({ summary: `note ${q(id)} does not have tag ${q(tag)}; nothing changed`, operation: "remove_tag", object: { ...object, version: n.version }, changed: [], readWith: readNote(id) });
      const { note, changed } = store.patchNote(id, { tags: n.tags.filter((t) => t !== tag) });
      return applied({ summary: `removed tag ${q(tag)} from note ${q(id)}`, operation: "remove_tag", object: { ...object, version: note.version }, changed, readWith: readNote(id) });
    },
  });

  const deleteNotes = defineTool<{ notebook: string; title_prefix?: string; tag?: string; ids?: string[] }>({
    kind: "write",
    name: "delete_notes",
    description: "Deletes the notes of one notebook that match every selector you send: title_prefix, tag and/or ids. At least one selector is required; there is no way to delete every note at once. All or nothing: if any listed id is missing or in another notebook, nothing is deleted. Deletes without a version check: a note changed since you listed it is deleted all the same.",
    inputSchema: {
      type: "object",
      properties: {
        notebook: NOTEBOOK_KEY,
        title_prefix: { type: "string", minLength: 1, maxLength: 200 },
        tag: TAG,
        ids: { type: "array", items: NOTE_ID, minItems: 1, maxItems: 100, uniqueItems: true },
      },
      required: ["notebook"],
    },
    hints: { destructive: true, idempotent: true, openWorld: false },
    readWith: (a) => readNotes(a.notebook),
    outputSchema: WRITE_OUTPUT,
    handler: ({ notebook, title_prefix, tag, ids }) => {
      if (title_prefix === undefined && tag === undefined && ids === undefined) {
        return notApplied({ summary: "delete_notes needs a selector (title_prefix, tag or ids), and none was sent; nothing was deleted", code: "selector_required", operation: "delete" });
      }
      if (!store.notebooks.has(notebook)) return notApplied({ summary: `notebook ${q(notebook)} was not found; nothing was deleted`, code: "not_found", operation: "delete" });
      if (ids) {
        const reasons = new Map<string, { code: string; message: string }>();
        for (const id of ids) {
          const n = store.getNote(id);
          if (!n) reasons.set(id, { code: "not_found", message: `note ${q(id)} was not found` });
          else if (n.notebook !== notebook) reasons.set(id, { code: "other_scope", message: `note ${q(id)} is in notebook ${q(n.notebook)}, not ${q(notebook)}` });
        }
        if (reasons.size) {
          // All or nothing: every item is named; the valid ones were not attempted.
          return itemsResult({
            summary: `${reasons.size} of ${ids.length} listed note(s) could not be deleted, so none was (all or nothing)`,
            operation: "delete",
            items: ids.map((id, index) => {
              const r = reasons.get(id);
              return r ? { index, id, outcome: "not_applied" as const, ...r } : { index, id, outcome: "not_attempted" as const, message: "not deleted: another item failed and the batch is all or nothing" };
            }),
            readWith: readNotes(notebook),
          });
        }
      }
      const matched = store.listNotes({ notebook, title_prefix, tag, ids });
      for (const n of matched) store.deleteNote(n.id);
      // A list of ids: one item per listed id, by index. A selector: the count, and the ids deleted.
      return itemsResult({
        summary: `deleted ${matched.length} note(s) from notebook ${q(notebook)}`,
        operation: "delete",
        object: { type: "note", scope: notebook },
        items: ids
          ? ids.map((id, index) => ({ index, id, version: matched.find((n) => n.id === id)!.version, outcome: "applied" as const }))
          : matched.map((n) => ({ id: n.id, version: n.version, outcome: "applied" as const })),
        appliedCount: matched.length,
        readWith: readNotes(notebook),
      });
    },
  });

  return new ToolSet([listNotebooks, createNotebook, deleteNotebook, listNotes, getNote, createNote, updateNote, deleteNote, addTag, removeTag, deleteNotes]);
}

export type { Status };
