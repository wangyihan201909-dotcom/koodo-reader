import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile


def now():
    return datetime.now(timezone.utc).isoformat()


class Knowledge:
    def __init__(self, directory: Path):
        self.database = directory / "knowledge.sqlite3"
        self.markdown = directory / "notes"
        self.markdown.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS topics (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS topic_books (
                    topic_id TEXT REFERENCES topics(id), book_key TEXT, title TEXT NOT NULL,
                    PRIMARY KEY (topic_id, book_key)
                );
                CREATE TABLE IF NOT EXISTS notes (
                    id TEXT PRIMARY KEY, topic_id TEXT REFERENCES topics(id),
                    title TEXT NOT NULL, question TEXT NOT NULL, markdown TEXT NOT NULL,
                    sources TEXT NOT NULL, concepts TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS note_links (
                    first_id TEXT REFERENCES notes(id), second_id TEXT REFERENCES notes(id),
                    reason TEXT NOT NULL, PRIMARY KEY (first_id, second_id),
                    CHECK (first_id < second_id)
                );
                CREATE TABLE IF NOT EXISTS pending_note_exports (
                    note_id TEXT PRIMARY KEY REFERENCES notes(id)
                );
            """)
            db.execute("BEGIN IMMEDIATE")
            pending = {row["note_id"] for row in db.execute("SELECT note_id FROM pending_note_exports")}
            for row in db.execute("SELECT * FROM notes"):
                note = self.decode_note(row)
                self.sync_export(db, note, note["id"] in pending)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def decode_note(row):
        note = dict(row)
        note["sources"] = json.loads(note["sources"])
        note["concepts"] = json.loads(note["concepts"])
        return note

    @staticmethod
    def render_markdown(note):
        sources = []
        for index, source in enumerate(note["sources"], 1):
            location = source.get("url") or source.get("path") or source.get("chapter") or ""
            if source.get("start_line") is not None:
                location += f" ({source['start_line']}–{source['end_line']})"
            quote = "\n".join(f"> {line}" for line in source["content"].splitlines())
            sources.append(f"[{index}] {source['title']} {location}\n\n{quote}")
        return (
            f"# {note['title']}\n\n{note['question']}\n\n{note['markdown']}\n\n"
            f"Concepts: {', '.join(note['concepts'])}\n\n"
            + "\n\n".join(sources)
            + "\n"
        )

    def export(self, note_id, text):
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.markdown, suffix=".tmp", delete=False
        ) as output:
            temporary = Path(output.name)
            try:
                output.write(text)
            except BaseException:
                output.close()
                temporary.unlink(missing_ok=True)
                raise
        try:
            temporary.replace(self.markdown / f"{note_id}.md")
        finally:
            temporary.unlink(missing_ok=True)

    def save(self, note):
        with self.connect() as db:
            added = db.execute(
                "INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
                (
                    note["id"], note["topic_id"], note["title"], note["question"], note["markdown"],
                    json.dumps(note["sources"], ensure_ascii=False),
                    json.dumps(note["concepts"], ensure_ascii=False), now(),
                ),
            )
            if added.rowcount:
                db.execute("INSERT INTO pending_note_exports VALUES (?)", (note["id"],))
        return self.export_latest(note["id"])

    def edit(self, note):
        with self.connect() as db:
            updated = db.execute(
                "UPDATE notes SET title = ?, markdown = ?, topic_id = ? WHERE id = ?",
                (note["title"], note["markdown"], note["topic_id"], note["id"]),
            )
            if updated.rowcount == 0:
                return None
            db.execute("INSERT OR IGNORE INTO pending_note_exports VALUES (?)", (note["id"],))
        return self.export_latest(note["id"])

    def export_latest(self, note_id):
        with self.connect() as db:
            # Serialize projections with SQLite writes so an older edit cannot overwrite a new one.
            db.execute("BEGIN IMMEDIATE")
            saved = self.decode_note(db.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone())
            pending = db.execute("SELECT 1 FROM pending_note_exports WHERE note_id = ?", (note_id,)).fetchone()
            self.sync_export(db, saved, pending is not None)
            return saved

    def sync_export(self, db, note, pending):
        note_id = note["id"]
        if pending or not (self.markdown / f"{note_id}.md").exists():
            self.export(note_id, self.render_markdown(note))
            db.execute("DELETE FROM pending_note_exports WHERE note_id = ?", (note_id,))

    def search_notes(self, query: str, limit: int = 8):
        terms = [part.strip().lower() for part in query.split() if part.strip()][:6]
        with self.connect() as db:
            rows = db.execute("SELECT * FROM notes ORDER BY created_at DESC, id DESC LIMIT 200").fetchall()
        notes = [self.decode_note(row) for row in rows]
        if not terms:
            return notes[:limit]
        scored = []
        for note in notes:
            title = note["title"].lower()
            question = note["question"].lower()
            concepts = " ".join(note["concepts"]).lower()
            markdown = note["markdown"].lower()
            score = 0
            for term in terms:
                if term in title:
                    score += 4
                if term in concepts:
                    score += 3
                if term in question:
                    score += 2
                if term in markdown:
                    score += 1
            if score > 0:
                scored.append((score, note))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [item[1] for item in scored[:limit]]

    def workspace(self, topic_id):
        with self.connect() as db:
            db.execute("BEGIN")
            topics = [dict(row) for row in db.execute("SELECT * FROM topics ORDER BY name")]
            books = [dict(row) for row in db.execute(
                "SELECT book_key, title FROM topic_books WHERE topic_id = ? ORDER BY title", (topic_id,)
            )]
            filter_sql = "WHERE topic_id = ?" if topic_id else ""
            notes = [self.decode_note(row) for row in db.execute(
                f"SELECT * FROM notes {filter_sql} ORDER BY created_at DESC, id DESC",
                (topic_id,) if topic_id else (),
            )]
            note_options = [dict(row) for row in db.execute(
                "SELECT id, title, topic_id FROM notes ORDER BY title, id"
            )]
            links = [dict(row) for row in db.execute("""
                SELECT note_links.*, first.title AS first_title, second.title AS second_title
                FROM note_links JOIN notes first ON first.id = first_id
                                JOIN notes second ON second.id = second_id
                WHERE ? IS NULL OR first.topic_id = ? OR second.topic_id = ?
                ORDER BY first_id, second_id
            """, (topic_id, topic_id, topic_id))]
        return {"topics": topics, "books": books, "notes": notes, "note_options": note_options, "links": links}
