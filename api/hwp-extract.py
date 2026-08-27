"""Private legacy-HWP text extractor. It never stores the source file or text."""
from http.server import BaseHTTPRequestHandler
from io import BytesIO
import json
import os
import struct
import urllib.request
import zlib
import olefile

MAX_BYTES = 10 * 1024 * 1024
PARA_TEXT_TAG = 67

def decode_section(data: bytes, compressed: bool) -> str:
    if compressed:
        data = zlib.decompress(data, -15)
    output, offset = [], 0
    while offset + 4 <= len(data):
        header = struct.unpack_from("<I", data, offset)[0]
        tag, size = header & 0x3FF, header >> 20
        offset += 4
        if size == 0xFFF:
            if offset + 4 > len(data): break
            size = struct.unpack_from("<I", data, offset)[0]
            offset += 4
        record = data[offset:offset + size]
        offset += size
        if tag == PARA_TEXT_TAG:
            output.append(record.decode("utf-16le", errors="ignore").replace("\x00", " "))
    return " ".join(output)

def extract_hwp(raw: bytes) -> str:
    with olefile.OleFileIO(BytesIO(raw)) as document:
        header = document.openstream("FileHeader").read()
        compressed = bool(struct.unpack_from("<I", header, 36)[0] & 1)
        paths = sorted((path for path in document.listdir() if len(path) == 2 and path[0] == "BodyText"), key=lambda path: path[1])
        return "\n".join(decode_section(document.openstream(path).read(), compressed) for path in paths)

class handler(BaseHTTPRequestHandler):
    def _json(self, status, body):
        encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status); self.send_header("content-type", "application/json; charset=utf-8"); self.send_header("content-length", str(len(encoded))); self.end_headers(); self.wfile.write(encoded)

    def do_POST(self):
        if self.headers.get("x-bidfit-internal-secret") != os.environ.get("CRON_SECRET", ""): return self._json(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length))
            url = str(payload.get("sourceUrl", ""))
            if not url.startswith("https://"): return self._json(400, {"error": "invalid source URL"})
            with urllib.request.urlopen(url, timeout=30) as response:
                raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES: return self._json(413, {"error": "file exceeds 10MB"})
            text = " ".join(extract_hwp(raw).split())
            return self._json(200, {"text": text[:200000]})
        except Exception as error:
            return self._json(422, {"error": str(error)[:300]})
