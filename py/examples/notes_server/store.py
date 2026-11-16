"""The notes backend: an in-memory store with its own version check.

Every note has a version, an integer that grows by one on every write that changes the note and on
nothing else. The store's writes take the version the caller read and refuse a mismatch atomically
(the reliable form of a version check, MWS Annex B-2): the server's tools pass the version on.
"""

from __future__ import annotations

import copy
import threading
from collections.abc import Mapping, Sequence
from typing import Any

from mws_kit import NotAppliedError, Snapshot, VersionConflict

FIELDS = ("title", "body", "tags")


class NoteStore:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._notes: dict[str, dict[str, Any]] = {}
        self._next = 1

    # -- reads ----------------------------------------------------------------------------------

    def get(self, note_id: str) -> dict[str, Any] | None:
        with self._lock:
            n = self._notes.get(note_id)
            return copy.deepcopy(n) if n is not None else None

    def snapshot(self, note_id: str) -> Snapshot | None:
        n = self.get(note_id)
        return None if n is None else Snapshot(n, n["version"])

    def list(self, *, title_prefix: str | None = None, tag: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            out = [
                copy.deepcopy(n)
                for n in self._notes.values()
                if (title_prefix is None or n["title"].startswith(title_prefix)) and (tag is None or tag in n["tags"])
            ]
        return out

    # -- writes ---------------------------------------------------------------------------------

    def create(self, *, title: str, body: str, tags: Sequence[str]) -> dict[str, Any]:
        with self._lock:
            note_id = f"n-{self._next}"
            self._next += 1
            note = {"id": note_id, "title": title, "body": body, "tags": list(dict.fromkeys(tags)), "version": 1}
            self._notes[note_id] = note
            return copy.deepcopy(note)

    def _current(self, note_id: str, expected_version: int | None) -> dict[str, Any]:
        n = self._notes.get(note_id)
        if n is None:
            raise NotAppliedError(f'note "{note_id}" does not exist', code="not_found", object={"type": "note", "id": note_id})
        if expected_version is not None and n["version"] != expected_version:
            raise VersionConflict(Snapshot(copy.deepcopy(n), n["version"]))
        return n

    def patch(self, note_id: str, change: Mapping[str, Any], expected_version: int | None) -> Snapshot:
        """Sets the fields named in ``change`` and nothing else (a field patch)."""
        with self._lock:
            n = self._current(note_id, expected_version)
            new = {**n, **{k: (list(dict.fromkeys(v)) if k == "tags" else v) for k, v in change.items() if k in FIELDS}}
            if any(new[k] != n[k] for k in FIELDS):
                new["version"] = n["version"] + 1
                self._notes[note_id] = new
            return Snapshot(copy.deepcopy(self._notes[note_id]), self._notes[note_id]["version"])

    def delete(self, note_id: str, _change: Any, expected_version: int | None) -> None:
        with self._lock:
            self._current(note_id, expected_version)
            del self._notes[note_id]
        return None

    def add_tag(self, note_id: str, tag: str) -> tuple[dict[str, Any], bool]:
        with self._lock:
            n = self._current(note_id, None)
            if tag in n["tags"]:
                return copy.deepcopy(n), False
            n["tags"] = [*n["tags"], tag]
            n["version"] = n["version"] + 1
            return copy.deepcopy(n), True

    def remove_tag(self, note_id: str, tag: str) -> tuple[dict[str, Any], bool]:
        with self._lock:
            n = self._current(note_id, None)
            if tag not in n["tags"]:
                return copy.deepcopy(n), False
            n["tags"] = [t for t in n["tags"] if t != tag]
            n["version"] = n["version"] + 1
            return copy.deepcopy(n), True

    def delete_many(
        self, ids: Sequence[str], expected_versions: Sequence[int] | None
    ) -> tuple[list[dict[str, Any]], dict[str, tuple[str, dict[str, Any] | None]]]:
        """All or nothing: checks every note first, deletes only if every check passes.

        Returns (deleted notes, failures by id as (code, current note or None)); with any failure
        nothing is deleted.
        """
        with self._lock:
            failures: dict[str, tuple[str, dict[str, Any] | None]] = {}
            for i, note_id in enumerate(ids):
                n = self._notes.get(note_id)
                if n is None:
                    failures[note_id] = ("not_found", None)
                elif expected_versions is not None and n["version"] != expected_versions[i]:
                    failures[note_id] = ("conflict", copy.deepcopy(n))
            if failures:
                return [], failures
            deleted = [self._notes.pop(note_id) for note_id in ids]
            return deleted, []
