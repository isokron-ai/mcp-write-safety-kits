// The backend: an in-memory store of notebooks and notes. It stands for whatever a real server
// writes to. It has a version per note but no checks of its own; the MCP layer (tools.ts) adds
// them with the kit. Everything is synchronous, so one call's read and write are not interleaved
// with another call's inside this process.

export interface Notebook {
  key: string;
  name: string;
}

export type Status = "open" | "archived";

export interface Note {
  id: string;
  notebook: string;
  title: string;
  body: string;
  tags: string[];
  status: Status;
  /** Grows by one with each change. */
  version: number;
  created_at: string;
  updated_at: string;
}

/** The fields a caller may set. */
export type NoteFields = Pick<Note, "title" | "body" | "tags" | "status">;
export const NOTE_FIELDS = ["title", "body", "tags", "status"] as const;

export const DEFAULT_NOTEBOOK = "inbox";

export class NotesStore {
  readonly notebooks = new Map<string, Notebook>([[DEFAULT_NOTEBOOK, { key: DEFAULT_NOTEBOOK, name: "Inbox" }]]);
  readonly notes = new Map<string, Note>();
  private seq = 0;

  private now(): string {
    return new Date().toISOString();
  }

  createNote(notebook: string, fields: NoteFields): Note {
    const t = this.now();
    const note: Note = { id: `n-${++this.seq}`, notebook, ...fields, tags: [...fields.tags], version: 1, created_at: t, updated_at: t };
    this.notes.set(note.id, note);
    return structuredClone(note);
  }

  getNote(id: string): Note | undefined {
    const n = this.notes.get(id);
    return n ? structuredClone(n) : undefined;
  }

  /** Sets the given fields. Returns the names of the fields whose value changed; the version grows only when one did. */
  patchNote(id: string, patch: Partial<NoteFields>): { note: Note; changed: string[] } {
    const n = this.notes.get(id);
    if (!n) throw new Error(`no note ${id}`);
    const changed: string[] = [];
    for (const f of NOTE_FIELDS) {
      const v = patch[f];
      if (v === undefined) continue;
      if (JSON.stringify(n[f]) !== JSON.stringify(v)) {
        (n as unknown as Record<string, unknown>)[f] = structuredClone(v);
        changed.push(f);
      }
    }
    if (changed.length) {
      n.version++;
      n.updated_at = this.now();
    }
    return { note: structuredClone(n), changed };
  }

  deleteNote(id: string): Note | undefined {
    const n = this.notes.get(id);
    if (n) this.notes.delete(id);
    return n;
  }

  listNotes(filter: { notebook?: string; title_prefix?: string; tag?: string; ids?: string[] }): Note[] {
    return [...this.notes.values()]
      .filter((n) => filter.notebook === undefined || n.notebook === filter.notebook)
      .filter((n) => filter.title_prefix === undefined || n.title.startsWith(filter.title_prefix))
      .filter((n) => filter.tag === undefined || n.tags.includes(filter.tag))
      .filter((n) => filter.ids === undefined || filter.ids.includes(n.id))
      .map((n) => structuredClone(n));
  }
}
