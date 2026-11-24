#!/usr/bin/env python3
"""Offline tests for worker.py + run.sh: a mock garage API on localhost, a fake `claude`, temp state/lock/pause files.
Never touches a real garage or Claude. Run: python3 -m unittest research-worker/test_worker.py (also part of `npm test`)."""
import fcntl, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPORT = {'summary': 'Most likely a weeping water pump; the coolant is leaving through the weep hole slowly.', 'likely_causes': [{'cause': 'water pump'}],
          'check_order': ['look'], 'safe_to_drive': {'verdict': 'caution', 'why': 'x'}, 'parts': [], 'videos': [], 'sources': [{'title': 's', 'url': 'https://example.com/a'}], 'questions_for_owner': []}


class Mock:
    def __init__(self):
        self.job = None; self.result_status = 'failed'; self.calls = []; self.results = []
        mock = self
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def _send(self, code, body=None):
                raw = json.dumps(body).encode() if body is not None else b''
                self.send_response(code); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def do_GET(self):
                mock.calls.append(('GET', self.path, self.headers.get('Authorization')))
                if self.path == '/api/research-jobs/next':
                    if mock.job: j, mock.job = mock.job, None; return self._send(200, j)
                    return self._send(204)
                self._send(404, {})
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
                mock.calls.append(('POST', self.path, self.headers.get('Authorization')))
                if self.path.endswith('/result'):
                    mock.results.append(body)
                    return self._send(200, {'status': 'done' if body.get('ok') else mock.result_status})
                self._send(404, {})
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}'


def job(jid='job-1'):
    return {'job': {'id': jid, 'attempt': 1}, 'car': {'id': 'c1', 'nickname': 'Demo Sedan', 'year': 2015, 'make': 'Demo', 'model': 'Sedan', 'mileage': 1},
            'todo': {'id': 't', 'type': 'symptom', 'title': 'Overheats after a short drive', 'notes': 'x'}, 'context': 'ctx', 'url': 'https://garage.test/#/car/c1/todo'}


class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.mock = Mock()
        self.tmp = tempfile.mkdtemp(prefix='garage-worker-test-')
        tok = os.path.join(self.tmp, 'token'); open(tok, 'w').write('test-token')
        self.claude = os.path.join(self.tmp, 'claude')
        self.set_claude({'structured_output': REPORT, 'subtype': 'success'})
        self.env = {**{k: v for k, v in os.environ.items() if not k.startswith('GARAGE_')},
                    'GARAGE_WORKER_CONF': os.path.join(self.tmp, 'none.conf'),
                    'GARAGE_BASE': self.mock.url, 'GARAGE_STATE_DIR': os.path.join(self.tmp, 'state'),
                    'GARAGE_TOKEN_FILE': tok, 'GARAGE_CLAUDE': self.claude,
                    'GARAGE_PAUSE_FILE': os.path.join(self.tmp, 'PAUSED'), 'GARAGE_WORKDIR': os.path.join(self.tmp, 'work'),
                    'GARAGE_LOCK': os.path.join(self.tmp, 'lock')}
    def tearDown(self): self.mock.srv.shutdown(); shutil.rmtree(self.tmp, ignore_errors=True)
    def set_claude(self, out):
        open(self.claude, 'w').write(f"#!/bin/sh\ncat >/dev/null\necho '{json.dumps(out)}'\n"); os.chmod(self.claude, 0o755)
    def run_worker(self, via='worker'):
        cmd = [os.path.join(HERE, 'run.sh')] if via == 'run.sh' else [sys.executable, os.path.join(HERE, 'worker.py')]
        return subprocess.run(cmd, env=self.env, capture_output=True, text=True, timeout=60)
    def hb(self): return json.load(open(os.path.join(self.tmp, 'state', 'research-heartbeat.json')))

    def test_idle_writes_heartbeat_and_makes_one_request(self):
        p = self.run_worker()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        h = self.hb(); self.assertEqual(h['result'], 'idle'); self.assertAlmostEqual(h['at'], time.time(), delta=30); self.assertEqual(h['ok_at'], h['at'])
        self.assertEqual([c[:2] for c in self.mock.calls], [('GET', '/api/research-jobs/next')], 'idle run = one request')
        self.assertEqual(self.mock.calls[0][2], 'Bearer test-token')

    def test_successful_job_posts_validated_report(self):
        self.mock.job = job('job-ok')
        p = self.run_worker()
        self.assertIn('job job-ok -> done', p.stdout)
        self.assertTrue(self.mock.results[0]['ok']); self.assertEqual(self.mock.results[0]['report']['safe_to_drive']['verdict'], 'caution')
        self.assertEqual(self.hb()['result'], 'job-done')
        self.assertNotIn('test-token', p.stdout + p.stderr, 'never prints the token')

    def test_bad_report_is_posted_as_failure(self):
        self.mock.job = job('job-8'); self.mock.result_status = 'queued'; self.set_claude({'structured_output': {'bad': 1}})
        p = self.run_worker()
        self.assertIn('job job-8 -> queued', p.stdout)
        self.assertFalse(self.mock.results[0]['ok']); self.assertIn('unexpected keys', self.mock.results[0]['error'])

    def test_claude_error_is_posted_as_failure(self):
        self.mock.job = job('job-7'); self.set_claude({'is_error': True, 'subtype': 'error_max_turns', 'result': 'nope'})
        p = self.run_worker()
        self.assertIn('job job-7 -> failed', p.stdout); self.assertEqual(self.hb()['result'], 'job-failed')

    def test_paused_and_daily_limit_still_heartbeat_without_claiming(self):
        open(self.env['GARAGE_PAUSE_FILE'], 'w').close()
        self.run_worker(); self.assertEqual(self.hb()['result'], 'paused'); self.assertEqual(self.mock.calls, [])
        os.remove(self.env['GARAGE_PAUSE_FILE'])
        day = datetime.now().strftime('%Y-%m-%d')
        open(os.path.join(self.tmp, 'state', f'research-count-{day}'), 'w').write('6')
        self.run_worker()
        self.assertEqual(self.hb()['result'], 'daily-limit')
        self.assertEqual(self.mock.calls, [], 'no job claimed at the daily limit')

    def test_daily_cap_is_configurable(self):
        self.env['GARAGE_DAILY_MAX'] = '1'
        self.mock.job = job('a'); self.run_worker()
        self.mock.job = job('b'); self.run_worker()
        self.assertEqual(self.hb()['result'], 'daily-limit'); self.assertEqual(len(self.mock.results), 1)

    def test_unreachable_server_leaves_an_error_heartbeat(self):
        self.run_worker()
        ok_at = self.hb()['ok_at']
        self.env['GARAGE_BASE'] = 'http://127.0.0.1:9'
        p = self.run_worker()
        self.assertNotEqual(p.returncode, 0)
        h = self.hb(); self.assertEqual(h['result'], 'error'); self.assertEqual(h['ok_at'], ok_at)

    def test_missing_base_url_is_an_error(self):
        self.env['GARAGE_BASE'] = ''
        p = self.run_worker(); self.assertNotEqual(p.returncode, 0); self.assertIn('GARAGE_BASE', p.stdout)

    def test_overlapping_run_exits_immediately(self):
        os.makedirs(os.path.dirname(self.env['GARAGE_LOCK']), exist_ok=True)
        with open(self.env['GARAGE_LOCK'], 'w') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            t0 = time.time(); p = self.run_worker('run.sh')
            self.assertEqual(p.returncode, 1); self.assertLess(time.time() - t0, 5)
            self.assertFalse(os.path.exists(os.path.join(self.tmp, 'state', 'research-heartbeat.json')))
        self.assertEqual(self.run_worker('run.sh').returncode, 0)
        self.assertEqual(self.hb()['result'], 'idle')

    def test_conf_file_is_read(self):
        conf = os.path.join(self.tmp, 'w.conf'); open(conf, 'w').write(f'# comment\nGARAGE_BASE={self.mock.url}\n')
        env = {k: v for k, v in self.env.items() if k != 'GARAGE_BASE'}; env['GARAGE_WORKER_CONF'] = conf
        p = subprocess.run([sys.executable, os.path.join(HERE, 'worker.py')], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


class HealthMock:
    def __init__(self, ok=True):
        self.alerts = []; mock = self; self.ok = ok
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def _send(self, code, body=None, headers=None):
                raw = json.dumps(body).encode() if body is not None else b''
                self.send_response(code)
                for k, v in (headers or {}).items(): self.send_header(k, v)
                self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
            def do_GET(self):
                if self.path == '/': return self._send(302, None, {'Location': '/auth/login'})
                if self.path == '/api/health':
                    if self.headers.get('Authorization') != 'Bearer test-token': return self._send(401, {'error': 'bad token'})
                    return self._send(200, {'ok': True, 'ai': {'failed': 0 if mock.ok else 2}, 'research': {'stuck': 0}})
                self._send(404, {})
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
                if self.path == '/mcp': return self._send(401, {'error': 'invalid_token'}, {'WWW-Authenticate': 'Bearer resource_metadata="x"'})
                if self.path == '/api/health/alert': mock.alerts.append(body); return self._send(200, {'ok': True})
                self._send(404, {})
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}'


class HealthTest(unittest.TestCase):
    setUp, tearDown, set_claude = WorkerTest.setUp, WorkerTest.tearDown, WorkerTest.set_claude
    def run_health(self, mock, *args):
        env = {**self.env, 'GARAGE_BASE': mock.url}
        return subprocess.run([sys.executable, os.path.join(HERE, 'health-check.py'), *args], env=env, capture_output=True, text=True, timeout=60)
    def test_all_good_sends_nothing(self):
        m = HealthMock(ok=True)
        try:
            p = self.run_health(m); self.assertIn('all good', p.stdout, p.stdout + p.stderr); self.assertEqual(m.alerts, [])
        finally: m.srv.shutdown()
    def test_problem_alerts_once(self):
        m = HealthMock(ok=False)
        try:
            p = self.run_health(m); self.assertIn('alert sent', p.stdout, p.stdout + p.stderr)
            self.assertEqual(len(m.alerts), 1); self.assertIn('2 failed answer', m.alerts[0]['body'])
            p = self.run_health(m); self.assertIn('already reported', p.stdout); self.assertEqual(len(m.alerts), 1)
            self.assertNotIn('test-token', p.stdout + p.stderr)
        finally: m.srv.shutdown()


if __name__ == '__main__':
    unittest.main()
