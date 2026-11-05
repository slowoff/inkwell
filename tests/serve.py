#!/usr/bin/env python3
# The test server. Playwright's wait_for_function runs its check through eval, which the page's security rule (1.88) blocks, so
# index.html is served without the rule, unless the request has the cookie csp=1 (test_audit_fixes.py tests the real rule that way).
import http.server, re, sys
RULE = re.compile(rb'<meta http-equiv="Content-Security-Policy"[^>]*>\n?')
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/index.html') and 'csp=1' not in (self.headers.get('Cookie') or ''):
            body = RULE.sub(b'', open('index.html', 'rb').read())
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body); return
        super().do_GET()
http.server.ThreadingHTTPServer(('', int(sys.argv[1])), H).serve_forever()
