import os
import sys
import threading
import uvicorn


def configured_port():
    raw = os.environ.get("KOODO_RESEARCH_PORT", "").strip()
    if raw:
        try:
            port = int(raw)
            if 1 <= port <= 65535:
                return port
        except ValueError:
            pass
    return 18756


def watch_parent_stdin(server):
    def monitor():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except OSError:
            pass
        server.should_exit = True
        timer = threading.Timer(3.0, os._exit, args=(0,))
        timer.daemon = True
        timer.start()

    thread = threading.Thread(target=monitor, name="parent-stdin-watchdog", daemon=True)
    thread.start()


if __name__ == "__main__":
    managed = os.environ.get("KOODO_RESEARCH_WATCH_STDIN", "").strip() == "1"
    config = uvicorn.Config(
        "research_agent.app:app",
        host="127.0.0.1",
        port=configured_port(),
        access_log=not managed,
    )
    server = uvicorn.Server(config)
    if managed:
        watch_parent_stdin(server)
    server.run()
