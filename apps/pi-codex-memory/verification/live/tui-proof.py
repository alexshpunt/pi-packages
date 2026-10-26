"""Real-provider PTY proof. All data/stores are disposable; never copies credentials."""
import fcntl, json, os, pathlib, pty, re, secrets, select, sqlite3, struct, subprocess, sys, tempfile, termios, time
package = pathlib.Path(__file__).resolve().parents[2]
mode = sys.argv[2] if len(sys.argv) > 2 else 'proof'
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True, mode=0o700)
case_path = root / 'case.json'
if case_path.exists():
    case = json.loads(case_path.read_text())
else:
    case = {'cwd': tempfile.mkdtemp(prefix='pi-memory-real-work-', dir=str(pathlib.Path.home() / 'tmp')), 'marker': 'violet-' + str(secrets.randbelow(900000)+100000),
            'region': 'zone-river-' + str(secrets.randbelow(9000)+1000), 'corrected': 'amber-' + str(secrets.randbelow(900000)+100000),
            'providerPaths': str(package.parents[1] / '.reports/codex-memory/live-benchmark/provider-paths.json')}
    if os.environ.get('PI_MEMORY_PACKAGE_PATH'): case['packagePath'] = os.environ['PI_MEMORY_PACKAGE_PATH']
    case_path.write_text(json.dumps(case, ensure_ascii=False)); case_path.chmod(0o600)
question = '이 검증 프로젝트의 배포 표식과 지역 식별자는 무엇이었나요? 기억 도구를 실제로 읽어서 정확한 두 문자열을 답하고 출처를 인용하세요. 근거가 없으면 추측하지 말고 모른다고 답하세요.'

def events(phase):
    path = root / (phase + '-events.jsonl')
    if not path.exists(): return []
    rows = []
    for line in path.read_text().splitlines():
        try: rows.append(json.loads(line))
        except json.JSONDecodeError: pass
    return rows

def state(agent='agent'):
    path = root / agent / 'pi-codex-memory/state.sqlite'
    if not path.exists(): return {'records': [], 'summary': ''}
    try:
        with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=1) as db:
            records = [json.loads(row[0]) for row in db.execute('SELECT value FROM records')]
            summary = '\n'.join(row[0] for row in db.execute('SELECT summary FROM scopes'))
            jobs = [dict(zip(['key', 'status', 'error'], row)) for row in db.execute('SELECT key,status,error FROM jobs')]
            return {'records': records, 'summary': summary, 'jobs': jobs}
    except sqlite3.OperationalError: return {'records': [], 'summary': ''}

class Terminal:
    def __init__(self, phase):
        self.phase = phase; self.output = b''; self.closed = False
        self.eventStart = len(events(phase))
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 48, 160, 0, 0))
        editor = root / 'test-editor.py'
        editor.write_text('#!/usr/bin/env python3\nimport os,sys,pathlib\npathlib.Path(sys.argv[-1]).write_text(os.environ["PI_MEMORY_EDIT_TEXT"])\n'); editor.chmod(0o700)
        edit_text = f'이 검증 프로젝트의 현재 배포 표식은 {case["corrected"]}, 지역 식별자는 {case["region"]}입니다. 이 프로젝트에만 적용되는 사용자 정정이며 일반 선호나 실행 승인이 아닙니다.'
        self.process = subprocess.Popen(['node', str(package / 'verification/live/tui.mjs'), str(root), phase], cwd=case['cwd'],
            env={**os.environ, 'TERM': 'xterm-256color', 'EDITOR': str(editor), 'VISUAL': str(editor), 'PI_MEMORY_EDIT_TEXT': edit_text}, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        try:
            self.wait(lambda: any(e.get('event') == 'session_start' and e.get('mode') == 'tui' for e in events(phase)[self.eventStart:]), 45)
            self.drain()
        except Exception:
            self.close()
            raise
    def pump(self, seconds=0.15):
        if select.select([self.master], [], [], seconds)[0]:
            try: chunk = os.read(self.master, 65536)
            except OSError: return
            self.output += chunk
            if b'\x1b[6n' in chunk: os.write(self.master, b'\x1b[1;1R')
    def drain(self):
        end = time.monotonic() + 1
        while time.monotonic() < end: self.pump(0.1)
    def send(self, text):
        os.write(self.master, text.encode() if isinstance(text, str) else text)
    def step(self, text, needle):
        marker = len(self.output)
        self.send(text)
        self.wait(lambda: needle in self.output[marker:].decode('utf8', 'replace'), 30)
        self.drain()
    def command(self, text):
        self.send(text + '\r'); self.drain()
    def wait(self, check, seconds=180):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump()
            if check(): return
            if self.process.poll() is not None: break
        clean = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', self.output.decode('utf8', 'replace'))
        raise RuntimeError('TUI condition not reached; tail=' + clean[-2500:])
    def prompt(self, text):
        before = len(events(self.phase))
        self.command(text)
        self.wait(lambda: any(e.get('event') == 'settled' for e in events(self.phase)[before:]))
        rows = events(self.phase)[before:]
        answers = [e['text'] for e in rows if e.get('event') == 'assistant' and e.get('stopReason') == 'stop']
        return {'answer': answers[-1] if answers else '', 'events': rows}
    def fresh(self):
        before = sum(e.get('event') == 'session_start' and e.get('mode') == 'tui' for e in events(self.phase))
        self.command('/new')
        self.wait(lambda: sum(e.get('event') == 'session_start' and e.get('mode') == 'tui' for e in events(self.phase)) > before, 45)
        self.drain()
    def close(self):
        if self.closed: return
        was_terminated = False
        if self.process.poll() is None:
            self.command('/quit')
            try: self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                was_terminated = True
                self.process.terminate(); self.process.wait(timeout=5)
        self.pump(0)
        path = root / (self.phase + '-terminal.log'); path.write_bytes(self.output); path.chmod(0o600)
        (root / (self.phase + '-exit.json')).write_text(json.dumps({'exitCode': self.process.returncode, 'wasTerminated': was_terminated}))
        os.close(self.master); self.closed = True
        if was_terminated or self.process.returncode != 0: raise RuntimeError('TUI did not exit cleanly: ' + str(self.process.returncode))

def cancel_running_request(t, report):
    t.step('/codex-memory extract\r', '메모리 추출·통합 실행')
    before = len(events(t.phase)); before_state = state()
    t.send('\r')
    t.wait(lambda: any(e.get('event') == 'model_request' and e.get('kind') == 'extraction' for e in events(t.phase)[before:]), 30)
    request = next(e for e in events(t.phase)[before:] if e.get('event') == 'model_request' and e.get('kind') == 'extraction')
    payload = json.loads(request['context']['messages'][0]['content'][0]['text'])
    key = 'extract:' + payload['source_thread_id']
    report['cancelled_request'] = {'requestId': request['requestId'], 'jobKey': key}
    report['checks']['exact_request_was_running'] = any(j['key'] == key and j['status'] == 'running' for j in state()['jobs'])
    if not report['checks']['exact_request_was_running']: raise RuntimeError('Cancellation probe did not intercept a running request.')
    t.command('/codex-memory cancel')
    t.wait(lambda: any(j['key'] == key and j['status'] == 'cancelled' and j['error'] == 'aborted' for j in state()['jobs']), 20)
    until = time.monotonic() + 3
    while time.monotonic() < until: t.pump(0.2)
    report['after_cancel'] = state()
    report['checks']['exact_request_cancelled'] = any(j['key'] == key and j['status'] == 'cancelled' and j['error'] == 'aborted' for j in state()['jobs'])
    report['checks']['cancel_no_new_record'] = [r['id'] for r in state()['records']] == [r['id'] for r in before_state['records']]

report = {'status': 'running', 'case': case, 'checks': {}}
t = None
try:
    if mode == 'lifecycle':
        t = Terminal('lifecycle')
        before = len(events('lifecycle'))
        t.command('/codex-memory status')
        t.wait(lambda: any(e.get('event') == 'memory_status' for e in events('lifecycle')[before:]), 20)
        report['checks']['stored_records_survive_restart'] = any(case['marker'] in r['body'] for r in state()['records'])
        starts = sum(e.get('event') == 'session_start' and e.get('mode') == 'tui' for e in events('lifecycle'))
        t.command('/reload')
        t.wait(lambda: sum(e.get('event') == 'session_start' and e.get('mode') == 'tui' for e in events('lifecycle')) > starts, 45)
        t.fresh()
        before = len(events('lifecycle'))
        t.command('/codex-memory status')
        t.wait(lambda: any(e.get('event') == 'memory_status' for e in events('lifecycle')[before:]), 20)
        report['checks']['reload_and_new_session_work'] = any(case['marker'] in r['body'] for r in state()['records'])
        report['checks']['no_model_request'] = not any(e.get('event') == 'model_request' for e in events('lifecycle')[t.eventStart:])
        t.close(); t = None
        report['termination'] = json.loads((root / 'lifecycle-exit.json').read_text())
        report['checks']['normal_process_exit'] = report['termination']['exitCode'] == 0 and not report['termination']['wasTerminated']
    elif mode == 'cancel':
        t = Terminal('cancel')
        report['setup'] = t.prompt('이번 세션에서는 실행 중인 기억 생성을 취소하는 동작을 검증합니다. 확인했다고만 답하세요.')
        cancel_running_request(t, report)
        t.close(); t = None
    elif mode == 'manage':
        t = Terminal('manage')
        original = next(r for r in state()['records'] if case['marker'] in r['body'])
        def target_menu(path):
            t.step('/codex-memory\r', 'Codex Memory v2')
            t.step('\r', '기억 검색')
            t.step(path + '\r', '기억 1개')
            t.step('\r', '본문·출처 보기')
        target_menu(original['path'])
        t.step('\x1b[B\r', '수정할 내용')
        t.step('\x07', case['corrected'])
        t.step('\r', '기억 저장')
        t.step('\r', 'Codex Memory v2')
        t.send('\x1b'); t.drain()
        corrected = next(r for r in state()['records'] if case['corrected'] in r['body'])
        report['checks']['ui_correction_saved'] = case['marker'] not in corrected['body'] and corrected['kind'] == 'note'
        report['after_correction'] = state()
        t.fresh()
        report['corrected_recall'] = t.prompt(question)
        report['checks']['corrected_fresh_answer'] = case['corrected'] in report['corrected_recall']['answer'] and case['region'] in report['corrected_recall']['answer'] and case['marker'] not in report['corrected_recall']['answer']
        target_menu(corrected['path'])
        t.step('\x1b[B\x1b[B\r', '기억 잊기')
        t.step('\r', 'Codex Memory v2')
        t.send('\x1b'); t.drain()
        report['checks']['ui_forget_removed_record'] = all(r['path'] != corrected['path'] for r in state()['records'])
        # Allow real automatic rescanning; previously recalled prose must not resurrect the fact.
        until = time.monotonic() + 90
        while time.monotonic() < until: t.pump(0.2)
        report['after_forget_rescan'] = state()
        report['checks']['no_resurrection_after_rescan'] = not any(case['marker'] in r['body'] or case['corrected'] in r['body'] for r in state()['records'])
        t.fresh()
        report['forgotten_recall'] = t.prompt(question)
        answer = report['forgotten_recall']['answer']
        report['checks']['forgotten_fresh_answer_unknown'] = case['marker'] not in answer and case['corrected'] not in answer and bool(re.search('모르|없|알 수', answer))
        cancel_running_request(t, report)
        t.close(); t = None
    else:
        t = Terminal('seed')
        seed = f'이 검증 프로젝트에서 실제로 사용할 배포 표식은 {case["marker"]}, 지역 식별자는 {case["region"]}입니다. 두 문자열은 정확히 유지합니다. 이 프로젝트에만 적용되는 결정이지 일반 선호나 앞으로의 실행 승인이 아닙니다. 지금은 이 결정을 확인했다고만 답하세요. 노트 도구를 쓰거나 다른 작업을 실행하지 마세요.'
        report['seed'] = t.prompt(seed)
        t.wait(lambda: case['marker'] in state()['summary'] and any(case['marker'] in r['body'] for r in state()['records']), 360)
        report['generated'] = state()
        report['checks']['automatic_real_generation'] = True
        if mode == 'seed-only':
            t.close(); t = None
        else:
            t.fresh()
            report['positive'] = t.prompt(question)
            answer = report['positive']['answer']
            report['checks']['fresh_session_exact_facts'] = case['marker'] in answer and case['region'] in answer
            report['checks']['actual_memory_read'] = any(e.get('event') == 'tool_end' and e.get('name') == 'pi_codex_memory_read' and not e.get('isError') for e in report['positive']['events'])
            report['checks']['validated_citation_usage'] = any(r['usageCount'] > 0 for r in state()['records'])
            t.command('/codex-memory status')
            t.close(); t = None
            if mode == 'installed':
                report['control'] = {'status': 'not_repeated', 'reason': 'The independent empty-memory control is recorded in the source TUI proof.'}
            else:
                t = Terminal('control')
                report['control'] = t.prompt(question)
                report['checks']['no_memory_control_unknown'] = case['marker'] not in report['control']['answer'] and case['region'] not in report['control']['answer'] and bool(re.search('모르|없|알 수', report['control']['answer']))
                report['checks']['control_has_no_memory_records'] = not state('control-agent')['records']
                report['checks']['control_input_not_leaked'] = all(case['marker'] not in json.dumps(e.get('context', {}), ensure_ascii=False) for e in report['control']['events'] if e.get('event') == 'model_request')
                t.close(); t = None
    report['status'] = 'pass' if all(report['checks'].values()) else 'fail'
except Exception as error:
    report['status'] = 'fail'; report['error'] = str(error)
finally:
    if t: t.close()
    out = root / ('lifecycle-proof.json' if mode == 'lifecycle' else 'cancel-proof.json' if mode == 'cancel' else 'manage-proof.json' if mode == 'manage' else 'seed-proof.json' if mode == 'seed-only' else 'proof.json'); out.write_text(json.dumps(report, ensure_ascii=False, indent=2)); out.chmod(0o600)
    print(json.dumps({'status': report['status'], 'checks': report['checks'], 'error': report.get('error'), 'report': str(out)}, ensure_ascii=False))
    if report['status'] != 'pass': sys.exit(1)
