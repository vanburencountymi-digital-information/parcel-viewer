"""Tiny reverse proxy: forwards :8091 -> Docker app at :8080.
Lets the preview browser attach to the running Parcel Viewer for the
DIC-376 accessibility audit without contending for the Docker-held port 8080.
"""
import http.server
import socketserver
import urllib.request
import urllib.error

UPSTREAM = "http://localhost:8080"
PORT = 8091

HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
       "te", "trailers", "transfer-encoding", "upgrade", "content-length",
       "content-encoding"}


class Proxy(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _proxy(self, body=None):
        url = UPSTREAM + self.path
        req = urllib.request.Request(url, data=body, method=self.command)
        for k, v in self.headers.items():
            # Drop Accept-Encoding so upstream returns identity — otherwise nginx
            # gzips and we'd forward compressed bytes without the content-encoding
            # header (which is in HOP), leaving the browser unable to decode them.
            if k.lower() in ("host", "content-length", "accept-encoding"):
                continue
            req.add_header(k, v)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
            data = resp.read()
            self.send_response(resp.status)
            for k, v in resp.headers.items():
                if k.lower() in HOP or k.lower() == "location":
                    continue
                self.send_header(k, v)
            # rewrite redirect Location to stay on the proxy
            loc = resp.headers.get("Location")
            if loc:
                self.send_header("Location", loc.replace(UPSTREAM, f"http://localhost:{PORT}"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() in HOP or k.lower() == "location":
                    continue
                self.send_header(k, v)
            loc = e.headers.get("Location")
            if loc:
                self.send_header("Location", loc.replace(UPSTREAM, f"http://localhost:{PORT}"))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(502, f"proxy error: {e}")

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        self._proxy(body)

    def do_PUT(self):
        self.do_POST()

    def do_OPTIONS(self):
        self._proxy()

    def log_message(self, *a):
        pass


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    print(f"a11y proxy listening on http://localhost:{PORT} -> {UPSTREAM}")
    ThreadingServer(("0.0.0.0", PORT), Proxy).serve_forever()
