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
            """)
            for row in db.execute("SELECT * FROM notes"):
                note = self.decode_note(row)
                if not (self.markdown / f"{note['id']}.md").exists():
                    self.export(note)

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

    def export(self, note):
        sources = []
        for index, source in enumerate(note["sources"], 1):
            location = source.get("url") or source.get("path") or source.get("chapter") or ""
            if source.get("start_line") is not None:
                location += f" ({source['start_line']}–{source['end_line']})"
            quote = "\n".join(f"> {line}" for line in source["content"].splitlines())
            sources.append(f"[{index}] {source['title']} {location}\n\n{quote}")
        text = (
            f"# {note['title']}\n\n{note['question']}\n\n{note['markdown']}\n\n"
            f"Concepts: {', '.join(note['concepts'])}\n\n"
            + "\n\n".join(sources)
            + "\n"
        )
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
            temporary.replace(self.markdown / f"{note['id']}.md")
        finally:
            temporary.unlink(missing_ok=True)

    def save(self, note):
        with self.connect() as db:
            db.execute(
                "INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
                (
                    note["id"], note["topic_id"], note["title"], note["question"], note["markdown"],
                    json.dumps(note["sources"], ensure_ascii=False),
                    json.dumps(note["concepts"], ensure_ascii=False), now(),
                ),
            )
            saved = self.decode_note(db.execute("SELECT * FROM notes WHERE id = ?", (note["id"],)).fetchone())
        self.export(saved)
        return saved

    def workspace(self, topic_id):
        with self.connect() as db:
            topics = [dict(row) for row in db.execute("SELECT * FROM topics ORDER BY name")]
            books = [dict(row) for row in db.execute(
                "SELECT book_key, title FROM topic_books WHERE topic_id = ? ORDER BY title", (topic_id,)
            )]
            filter_sql = "WHERE topic_id = ?" if topic_id else ""
            notes = [self.decode_note(row) for row in db.execute(
                f"SELECT * FROM notes {filter_sql} ORDER BY created_at DESC, id DESC",
                (topic_id,) if topic_id else (),
            )]
            links = [dict(row) for row in db.execute("""
                SELECT note_links.*, first.title AS first_title, second.title AS second_title
                FROM note_links JOIN notes first ON first.id = first_id
                                JOIN notes second ON second.id = second_id
                WHERE ? IS NULL OR first.topic_id = ? OR second.topic_id = ?
                ORDER BY first_id, second_id
            """, (topic_id, topic_id, topic_id))]
        return {"topics": topics, "books": books, "notes": notes, "links": links}
