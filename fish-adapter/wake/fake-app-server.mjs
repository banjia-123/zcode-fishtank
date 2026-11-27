// fake app-server：模拟 ZCode Protocol 最小行为（wake 客户端离线测试用，保留供回归）
// 协议行为对齐 S2-A 实测：create 反问偏好 → 订阅 → send accepted → 事件流（text_delta×2 + 终止帧）
// 场景由 prompt 首部指令控制：
//   FAKE:OK     正常回复 "OK"（默认）
//   FAKE:SILENT 回复 "[SILENT]"
//   FAKE:FAIL   send 后发 turn-failed 错误事件
//   FAKE:HANG   accepted 后不发任何事件（测超时）
//   FAKE:CRASH  send 后进程直接退出（测崩溃重启）
//   FAKE:SLOW   处理延迟 400ms（测并发闸/串行排队的时间线）
// D6 补齐与真实协议的漂移面：
//   FAKE:ATT    回复带附件回执 [att:a.jpg|b.png]（测 attachments 通路——序列化漏没漏回执里见真章）
//   FAKE:THINK  先发 reasoning_delta 思考帧再回正文（测思考采集链路）
//   FAKE:ALT-SID 事件帧会话标识改放 payload.sessionId（真实协议的备选形状，测串线过滤兼容）
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let seq = 0;

rl.on('line', (line) => {
  let j;
  try { j = JSON.parse(line); } catch { return; }
  if (j.method === 'session/create') {
    // 服务端先反问偏好（真实协议行为；fake 不等应答直接回 create，客户端两个都处理）
    out({ id: 'srv-prefs-' + (++seq), method: 'session/requestRuntimePreferences', params: { scope: 'runtime-materialization' } });
    out({ id: j.id, result: { session: { sessionId: 'sess_fake_' + (++seq) }, protocol: { name: 'ZCode Protocol', version: 1 } } });
  } else if (j.method === 'session/subscribe') {
    out({ id: j.id, result: { ok: true } });
  } else if (j.method === 'session/send') {
    const sid = j.params.sessionId;
    out({ id: j.id, result: { accepted: true, sessionId: sid } });
    const content = String(j.params.content ?? '');
    const atts = Array.isArray(j.params.attachments) ? j.params.attachments : [];
    // 事件帧发送器：ALT-SID 场景把会话标识挪进 payload（真实协议备选形状），其余用 params.sessionId
    const emit = (payload) => {
      if (content.includes('FAKE:ALT-SID')) out({ method: 'session/event', params: { payload: { sessionId: sid, ...payload } } });
      else out({ method: 'session/event', params: { sessionId: sid, payload } });
    };
    setTimeout(() => {
      if (content.includes('FAKE:CRASH')) process.exit(1);
      if (content.includes('FAKE:HANG')) return; // 沉默到底
      if (content.includes('FAKE:FAIL')) {
        emit({ error: { type: 'unknown_error', message: 'fake turn failed' } });
        return;
      }
      let reply = content.includes('FAKE:SILENT') ? '[SILENT]' : 'OK';
      if (content.includes('FAKE:ATT')) {
        reply += '[att:' + (atts.length ? atts.map((a) => String(a.filename ?? a.localPath ?? '?')).join('|') : 'none') + ']';
      }
      if (content.includes('FAKE:THINK')) emit({ kind: 'reasoning_delta', delta: '思考内容' });
      emit({ kind: 'text_delta', delta: reply.slice(0, 1) });
      emit({ kind: 'text_delta', delta: reply.slice(1) });
      emit({ content: reply, stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } });
    }, content.includes('FAKE:SLOW') ? 400 : 30);
  } else if (j.method === 'session/close') {
    out({ id: j.id, result: { ok: true } });
  } else if (j.method != null && j.id != null) {
    out({ id: j.id, error: { code: -32601, message: 'Method not found: ' + j.method } });
  }
});

setInterval(() => {}, 60_000); // 保持存活
