import http from 'node:http';
import { readJsonBody, sendJson } from '../shared/http.js';
import { ApiError } from '../shared/errors.js';
import type { Coordinator } from './coordinator.js';
import type { ReleaseRecord } from '../shared/types.js';

function releaseView(release: ReleaseRecord) {
  const rolloutBatches = release.batches.map((serviceIds, index) => {
    const services = serviceIds.map((serviceId) => {
      const state = release.services[serviceId];
      return {
        serviceId,
        confirmed: state?.status === 'accepted',
        status: state?.status ?? 'pending',
        attempts: state?.attempts ?? 0,
        lastError: state?.lastError,
        serviceAcceptedAt: state?.serviceAcceptedAt,
        coordinatorConfirmedAt: state?.coordinatorConfirmedAt,
      };
    });
    return {
      index: index + 1,
      serviceIds,
      confirmed: services.every((service) => service.confirmed),
      services,
    };
  });

  const revokeBatches = release.revocation
    ? release.batches.map((serviceIds, index) => {
        const services = serviceIds.map((serviceId) => {
          const state = release.revocation?.services[serviceId];
          return {
            serviceId,
            removed: state?.status === 'revoked',
            status: state?.status ?? 'pending',
            attempts: state?.attempts ?? 0,
            lastError: state?.lastError,
          };
        });
        return {
          index: index + 1,
          serviceIds,
          confirmed: services.every((service) => service.removed),
          services,
        };
      })
    : undefined;

  return {
    ...release,
    progress: {
      totalBatches: release.batches.length,
      confirmedBatches: rolloutBatches.filter((batch) => batch.confirmed).length,
      batches: rolloutBatches,
    },
    revocationProgress: release.revocation
      ? {
          totalBatches: release.batches.length,
          confirmedBatches: revokeBatches?.filter((batch) => batch.confirmed).length ?? 0,
          batches: revokeBatches,
        }
      : undefined,
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>发布协调器</title>
<style>
  body { font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; margin: 24px; color: #172033; background: #f7f8fb; }
  h1 { margin-top: 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { background: white; border: 1px solid #dfe3ec; border-radius: 10px; padding: 16px; box-shadow: 0 1px 2px rgba(20,30,60,.05); }
  .full { grid-column: 1 / -1; }
  pre { background: #101828; color: #e6edf7; padding: 12px; border-radius: 8px; overflow: auto; max-height: 420px; font-size: 12px; }
  .ok { color: #067647; font-weight: 700; }
  .warn { color: #b54708; font-weight: 700; }
  .bad { color: #b42318; font-weight: 700; }
  button { border: 1px solid #c7d7fe; background: #eff4ff; color: #1d4ed8; border-radius: 6px; padding: 4px 9px; margin-right: 6px; cursor: pointer; }
  button:hover { background: #dbe7ff; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border-bottom: 1px solid #eaecf0; padding: 6px 8px; text-align: left; vertical-align: top; }
  .muted { color: #667085; }
</style>
</head>
<body>
<h1>发布协调器</h1>
<p class="muted">每 1.5 秒自动刷新。JSON API：<code>/api/releases</code>、<code>/api/dashboard</code>。</p>
<div class="grid">
  <section class="card full"><h2>发布与批次确认</h2><div id="releases">加载中…</div></section>
  <section class="card full"><h2>服务实际生效配置</h2><div id="configs">加载中…</div></section>
</div>
<script>
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function statusClass(status) { return ['completed','revoked','accepted','revoked'].includes(status) ? 'ok' : ['pausing','running','revoking','dispatched'].includes(status) ? 'warn' : 'bad'; }
async function act(id, action) {
  await fetch('/api/releases/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
  await refresh();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (button) act(button.dataset.id, button.dataset.action);
});
function renderReleases(data) {
  if (!data.releases.length) return '<p class="muted">暂无发布。</p>';
  return data.releases.map(r => {
    const p = r.progress;
    const batches = p.batches.map(b => '<li>批次 ' + b.index + ' [' + b.serviceIds.map(esc).join(', ') + ']: ' + (b.confirmed ? '<span class=ok>已确认</span>' : b.services.map(s => esc(s.serviceId + ':' + s.status + (s.attempts ? '(' + s.attempts + ')' : ''))).join('；')) + '</li>').join('');
    const actions = [];
    if (r.status === 'running' || r.status === 'pausing') actions.push('<button data-action="pause" data-id="'+esc(r.id)+'">暂停</button>');
    if (r.status === 'paused') actions.push('<button data-action="resume" data-id="'+esc(r.id)+'">继续</button>');
    if (r.status === 'completed') actions.push('<button data-action="revoke" data-id="'+esc(r.id)+'">撤销</button>');
    actions.push('<button data-action="reconcile" data-id="'+esc(r.id)+'">立即对账</button>');
    return '<div style="margin-bottom:18px"><h3>'+esc(r.id)+' <span class="'+statusClass(r.status)+'">'+esc(r.status)+'</span></h3>'
      + '<div>协调器受理顺序 #' + r.acceptedOrder + ' / ' + esc(r.coordinatorAcceptedAt) + '；批次 ' + p.confirmedBatches + '/' + p.totalBatches + '</div>'
      + '<div style="margin:8px 0">'+actions.join('')+'</div><ul>'+batches+'</ul>'
      + (r.revocationProgress ? '<div>撤销进度 '+r.revocationProgress.confirmedBatches+'/'+r.revocationProgress.totalBatches+'</div>' : '')
      + '</div>';
  }).join('');
}
function renderConfigs(data) {
  return '<div class="grid">' + Object.entries(data.actualConfigs).map(([id, value]) =>
    '<div class="card"><h3>'+esc(id)+'</h3><pre>'+esc(JSON.stringify(value, null, 2))+'</pre></div>'
  ).join('') + '</div>';
}
async function refresh() {
  try {
    const response = await fetch('/api/dashboard');
    const data = await response.json();
    document.getElementById('releases').innerHTML = renderReleases(data);
    document.getElementById('configs').innerHTML = renderConfigs(data);
  } catch (error) {
    document.getElementById('releases').textContent = '刷新失败: ' + error;
  }
}
window.act = act;
refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;

export function createCoordinatorServer(coordinator: Coordinator): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://coordinator.local');
      const segments = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, pid: process.pid });
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api') {
        sendJson(res, 200, {
          ok: true,
          endpoints: [
            'GET /api/releases',
            'POST /api/releases',
            'GET /api/releases/:id',
            'POST /api/releases/:id/pause',
            'POST /api/releases/:id/resume',
            'POST /api/releases/:id/revoke',
            'POST /api/releases/:id/reconcile',
            'POST /api/reconcile',
            'GET /api/dashboard',
            'GET /api/services/:serviceId/actual-config',
            'GET /api/services/:serviceId/timeline',
            'POST /api/services/:serviceId/timeline/sync',
            'GET /api/timeline?serviceId=:serviceId',
            'POST /api/timeline/sync',
          ],
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const actualConfigs: Record<string, unknown> = {};
        await Promise.all(
          coordinator.getServiceIds().map(async (serviceId) => {
            try {
              actualConfigs[serviceId] = await coordinator.getActualConfig(serviceId);
            } catch (error) {
              actualConfigs[serviceId] = { error: (error as Error).message };
            }
          }),
        );
        sendJson(res, 200, {
          releases: coordinator.listReleases().map(releaseView),
          actualConfigs,
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/releases') {
        sendJson(res, 200, { releases: coordinator.listReleases().map(releaseView) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/releases') {
        const body = await readJsonBody(req);
        const release = await coordinator.createRelease(body as never);
        sendJson(res, 201, releaseView(release));
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'releases' && segments[2]) {
        const id = decodeURIComponent(segments[2]);
        const action = segments[3];

        if (req.method === 'GET' && !action) {
          sendJson(res, 200, releaseView(coordinator.getRelease(id)));
          return;
        }

        if (req.method === 'POST' && action === 'pause') {
          sendJson(res, 200, releaseView(await coordinator.pauseRelease(id)));
          return;
        }
        if (req.method === 'POST' && action === 'resume') {
          sendJson(res, 200, releaseView(await coordinator.resumeRelease(id)));
          return;
        }
        if (req.method === 'POST' && action === 'revoke') {
          sendJson(res, 202, releaseView(await coordinator.revokeRelease(id)));
          return;
        }
        if (req.method === 'POST' && action === 'reconcile') {
          await coordinator.reconcileAll();
          sendJson(res, 200, releaseView(coordinator.getRelease(id)));
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/reconcile') {
        await coordinator.reconcileAll();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && segments[0] === 'api' && segments[1] === 'services' && segments[3] === 'actual-config') {
        const serviceId = decodeURIComponent(segments[2] ?? '');
        sendJson(res, 200, await coordinator.getActualConfig(serviceId));
        return;
      }

      if (segments[0] === 'api' && segments[1] === 'services' && segments[3] === 'timeline' && segments[2]) {
        const serviceId = decodeURIComponent(segments[2]);

        // GET /api/services/:serviceId/timeline — local collected view;
        // works while the target service is offline.
        if (req.method === 'GET' && !segments[4]) {
          const view = coordinator.getServiceTimeline(serviceId);
          const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
          let timeline = view.timeline;
          if (order === 'desc') timeline = [...timeline].reverse();
          const limitParam = url.searchParams.get('limit');
          if (limitParam !== null) {
            const limit = Number(limitParam);
            if (Number.isInteger(limit) && limit >= 0) timeline = timeline.slice(0, limit);
          }
          sendJson(res, 200, { ...view, timeline, order, queriedAt: new Date().toISOString() });
          return;
        }

        // POST /api/services/:serviceId/timeline/sync[?maxSegments=N]
        if (req.method === 'POST' && segments[4] === 'sync') {
          const maxSegmentsParam = url.searchParams.get('maxSegments');
          const maxSegments = maxSegmentsParam === null ? undefined : Number(maxSegmentsParam);
          const report = await coordinator.requestTimelineSync(serviceId, {
            maxSegments: Number.isInteger(maxSegments) && (maxSegments as number) > 0
              ? (maxSegments as number)
              : undefined,
          });
          const view = coordinator.getServiceTimeline(serviceId);
          sendJson(res, 200, { ...report, ...view });
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/timeline/sync') {
        const reports = await coordinator.syncAllTimelines();
        sendJson(res, 200, { ok: true, reports });
        return;
      }

      // Convenience alias: GET /api/timeline?serviceId=:id behaves like the
      // nested per-service route; without it, returns every collected timeline.
      if (req.method === 'GET' && url.pathname === '/api/timeline') {
        const serviceId = url.searchParams.get('serviceId');
        if (serviceId) {
          sendJson(res, 200, coordinator.getServiceTimeline(serviceId));
          return;
        }
        sendJson(res, 200, { timelines: coordinator.getAllServiceTimelines() });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not found', path: url.pathname });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(res, error.statusCode, { ok: false, error: error.message });
        return;
      }
      sendJson(res, 400, { ok: false, error: (error as Error).message });
    }
  });
}
