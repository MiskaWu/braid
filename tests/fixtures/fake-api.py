# 測試用的假 Claude API：只回「列出模型」與組織標頭，記下收到的 Authorization 與路徑。
# 用法：python3 fake-api.py <紀錄檔> [組織 id|status:<碼>]，第一行印出埠號，之後一直服務到被結束。
# 只聽 127.0.0.1；Windows 端的 PowerShell 經 WSL 的 localhost 轉送也連得到。braid 的腳本只在
# BRAID_API_BASE 是 http://127.0.0.1:<埠> 時才會連過來，真的憑證不會被送到這裡以外的地方。
import http.server
import sys

seen, answer = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else '0000aaaa-1111-2222-3333-444455556666')


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        with open(seen, 'a') as f:
            f.write(f"{self.headers.get('Authorization', '')}\t{self.path}\n")
        if answer.startswith('status:'):
            self.send_response(int(answer[7:]))
            self.end_headers()
            return
        self.send_response(200)
        self.send_header('anthropic-organization-id', answer)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"data":[]}')

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
