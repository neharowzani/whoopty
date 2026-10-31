"""Serves the dashboard from web/ and runs the Gemma pipeline on POST /api/run."""
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pipeline

PORT = 8000


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always serve the latest page while we iterate.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/api/run":
            self.send_error(404)
            return
        try:
            body, status = json.dumps(pipeline.run()).encode(), 200
        except Exception as error:
            body, status = str(error).encode(), 500
        self.send_response(status)
        self.send_header("Content-Type", "application/json" if status == 200 else "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    web = Path(__file__).parent / "web"
    print(f"Whoopty on http://localhost:{PORT}")
    ThreadingHTTPServer(("", PORT), partial(Handler, directory=str(web))).serve_forever()
