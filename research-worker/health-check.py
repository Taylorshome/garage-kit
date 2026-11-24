#!/usr/bin/env python3
"""Daily health check for your garage, run from the same always-on computer as the research worker (optional).

Checks: the site answers (sign-in redirect), the MCP endpoint asks for OAuth (401), GET /api/health (database, AI
failures in the last 24 h, stuck research jobs), the research worker's heartbeat (if it's installed and not paused),
and the newest backup in backups/d1/ (if you keep backups there). Problems are sent ONCE as one notification through
your garage's notification integration (POST /api/health/alert with the research-worker token); nothing is sent when
all is well. The same problem list isn't repeated within 12 hours.

  python3 research-worker/health-check.py            run and alert
  python3 research-worker/health-check.py --dry-run  print what it would send
  python3 research-worker/health-check.py --json     print the results
Cron (daily 8:35): 35 8 * * * /path/to/kit/research-worker/run-health.sh
Uses research-worker/worker.conf (GARAGE_BASE, GARAGE_TOKEN_FILE, GARAGE_STATE_DIR) like worker.py. Never prints the token.
"""
import glob, hashlib, json, os, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import worker as W   # shares config loading, heartbeat path, pause file

UA = 'garage-health/1.0'


def req(method, path, token=None, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    h = {'User-Agent': UA, 'Accept': 'application/json'}
    if token: h['Authorization'] = f'Bearer {token}'
    if data is not None: h['Content-Type'] = 'application/json'
    r = urllib.request.Request(W.BASE + path, data=data, method=method, headers=h)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try:
        with urllib.request.build_opener(NoRedirect).open(r, timeout=timeout) as res:
            raw = res.read(); return res.status, dict(res.headers), (json.loads(raw) if raw and 'json' in res.headers.get('Content-Type', '') else None)
    except urllib.error.HTTPError as e:
        raw = e.read(); ct = e.headers.get('Content-Type', '')
        return e.code, dict(e.headers), (json.loads(raw) if raw and 'json' in ct else None)


def checks(token):
    problems, info = [], {}
    try:
        st, _, _ = req('GET', '/')
        info['site'] = st
        if st not in (200, 302, 303): problems.append(f'site answered {st}')
    except Exception as e: problems.append(f'site unreachable ({type(e).__name__})')
    try:
        st, h, _ = req('POST', '/mcp', body={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        info['mcp'] = st
        if st != 401 or 'resource_metadata' not in (h.get('WWW-Authenticate') or h.get('www-authenticate') or ''): problems.append(f'MCP endpoint answered {st} (expected the 401 OAuth challenge)')
    except Exception as e: problems.append(f'MCP endpoint unreachable ({type(e).__name__})')
    try:
        st, _, h = req('GET', '/api/health', token)
        info['health'] = h
        if st != 200 or not h or not h.get('ok'): problems.append(f'/api/health: {st} {(h or {}).get("error", "")}'.strip())
        else:
            if h['ai']['failed']: problems.append(f"AI mechanic: {h['ai']['failed']} failed answer(s) in 24 h")
            if h['research']['stuck']: problems.append(f"{h['research']['stuck']} research job(s) stuck")
    except Exception as e: problems.append(f'/api/health failed ({type(e).__name__})')
    if os.path.exists(W.HEARTBEAT) and not os.path.exists(W.PAUSE_FILE):
        hb = json.load(open(W.HEARTBEAT)); now = time.time(); info['heartbeat'] = hb
        if now - hb.get('at', 0) > 20 * 60: problems.append(f"research worker hasn't run for {int((now - hb.get('at', 0)) // 60)} min (cron/launchd?)")
        elif now - (hb.get('ok_at') or 0) > 2 * 3600: problems.append(f"research worker erroring: {hb.get('detail', hb.get('result'))}")
    backups = sorted(glob.glob(os.path.join(HERE, '..', 'backups', 'd1', 'garage-*.sql*')))
    if backups:
        age = (time.time() - os.path.getmtime(backups[-1])) / 3600; info['backup_age_h'] = round(age, 1)
        if age > 36: problems.append(f'newest backup is {int(age)} h old')
    return problems, info


def main():
    args = sys.argv[1:]
    if not W.BASE: sys.exit('GARAGE_BASE is not set (research-worker/worker.conf)')
    token = open(W.TOKEN_FILE).read().strip()
    problems, info = checks(token)
    if '--json' in args: print(json.dumps({'problems': problems, **info}, indent=1, default=str)); return
    if not problems: print('all good'); return
    state = os.path.join(W.STATE, 'health-last.json')
    key = hashlib.sha256('\n'.join(problems).encode()).hexdigest()
    try: last = json.load(open(state))
    except (FileNotFoundError, ValueError): last = {}
    if last.get('key') == key and time.time() - last.get('at', 0) < 12 * 3600: print('same problems already reported'); return
    body = {'title': f'Garage health: {len(problems)} problem(s)', 'body': '; '.join(problems)[:400]}
    if '--dry-run' in args: print('DRY RUN would send:', json.dumps(body)); return
    st, _, r = req('POST', '/api/health/alert', token, body)
    print('alert sent' if st == 200 else f'alert failed: {st}', '|', body['body'])
    if st == 200: W.write_json(state, {'key': key, 'at': int(time.time())})


if __name__ == '__main__':
    main()
