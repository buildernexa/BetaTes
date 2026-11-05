// language: JavaScript (ES2022), file: patch.js
(function () {
  'use strict';

  window.addEventListener('error', function(e) { alert('Sistem Error: ' + e.message); });

  const qs = (s) => document.querySelector(s);
  const qsa = (s) => [...document.querySelectorAll(s)];
  const $ = qs, $$ = qsa;

  const fetchWithTimeout = (url, options = {}, timeout = 60000) => {
    return Promise.race([
      fetch(url, options),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Jaringan Timeout')), timeout))
    ]);
  };

  const stor = {
    get(k) { try { return sessionStorage.getItem(k) || localStorage.getItem(k) || ''; } catch (_) { return ''; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} try { sessionStorage.setItem(k, v); } catch (_) {} },
  };

  let CREDS = {
    owner: stor.get('gh_owner'),
    repo: stor.get('gh_repo') || 'apk-runner',
    pat: stor.get('gh_pat'),
  };

  if (!CREDS.owner) {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    if (m) CREDS.owner = m[1];
    const p = location.pathname.split('/').filter(Boolean)[0];
    if (p && !stor.get('gh_repo')) CREDS.repo = p;
  }

  const GH = 'https://api.github.com';
  const repoBase = () => `/repos/${CREDS.owner}/${CREDS.repo}`;
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const ghFetch = async (path, opts = {}, retries = 3) => {
    if (!CREDS.pat) throw new Error('PAT kosong');
    for (let i = 0; i < retries; i++) {
      try {
        const r = await fetchWithTimeout(GH + path, {
          ...opts,
          headers: { Authorization: `Bearer ${CREDS.pat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
        }, 60000); 
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          let msg = `GitHub ${r.status}`;
          try { const j = JSON.parse(body); if (j.message) msg += `: ${j.message}`; } catch (_) {}
          const e = new Error(msg); e.status = r.status;
          if (r.status >= 500) { await new Promise(res => setTimeout(res, 2000 * (i + 1))); continue; }
          throw e;
        }
        return r.status === 204 ? null : r.json();
      } catch (e) {
        if (i === retries - 1) throw e;
        await new Promise(res => setTimeout(res, 2000 * (i + 1)));
      }
    }
  };

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const ensureCredsModal = () => {
    if (document.getElementById('ghCredsModal')) { document.getElementById('ghCredsModal').hidden = false; return; }
    const d = document.createElement('div');
    d.id = 'ghCredsModal'; d.className = 'modal';
    d.innerHTML = `
      <div class="card" style="width:min(92vw,480px);margin:0">
        <div class="ct">Kredensial GitHub</div>
        <p class="hint" style="margin:0 0 14px">Buat fine-grained PAT dengan scope <b>Contents: RW</b>, <b>Actions: RW</b>, <b>Workflows: RW</b>.</p>
        <div class="fl"><input id="ghOwner" placeholder=" " autocomplete="off"><label for="ghOwner">Owner</label></div>
        <div class="fl"><input id="ghRepo" placeholder=" " autocomplete="off"><label for="ghRepo">Repo</label></div>
        <div class="fl"><input id="ghPat" type="password" placeholder=" " autocomplete="off"><label for="ghPat">PAT</label></div>
        <div style="display:flex;gap:10px;margin-top:18px;"><button type="button" class="btn lime" id="ghSave">Simpan</button><button type="button" class="btn alt" id="ghCancel">Batal</button></div>
      </div>`;
    document.body.appendChild(d);
    d.querySelector('#ghSave').onclick = () => {
      CREDS = { owner: d.querySelector('#ghOwner').value.trim(), repo: d.querySelector('#ghRepo').value.trim(), pat: d.querySelector('#ghPat').value.trim() };
      stor.set('gh_owner', CREDS.owner); stor.set('gh_repo', CREDS.repo); stor.set('gh_pat', CREDS.pat);
      d.hidden = true; updateConn(); pollOnce();
    };
    d.querySelector('#ghCancel').onclick = () => d.hidden = true;
    d.querySelector('#ghOwner').value = CREDS.owner || ''; d.querySelector('#ghRepo').value = CREDS.repo; d.querySelector('#ghPat').value = CREDS.pat || '';
    d.hidden = false;
  };

  const updateConn = () => {
    const c = qs('#conn'); if (c) c.textContent = CREDS.owner && CREDS.repo ? `github.com/${CREDS.owner}/${CREDS.repo}` : 'Kredensial belum diisi';
  };

  API.list = async () => {
    if (!CREDS.owner || !CREDS.pat) return [];
    const rel = await ghFetch(`${repoBase()}/releases?per_page=30`);
    return (rel || []).filter(r => (r.tag_name || '').startsWith('build-')).map(r => {
      const id = r.tag_name.slice(6); let meta = {}; try { meta = JSON.parse(r.body || '{}'); } catch (_) {}
      const m = meta.meta || {};
      return { id, name: m.name || r.name || `build-${id}`, pkg: m.pkg || '', ver: m.ver || '', type: m.type || 'debug', fmt: m.fmt || 'apk', st: 'ok', t: new Date(r.published_at || r.created_at).getTime(), pct: 100 };
    });
  };

  API.machine = async () => {
    let running = 0, queued = 0;
    try {
      const runs = await ghFetch(`${repoBase()}/actions/runs?per_page=20&event=workflow_dispatch`);
      for (const r of (runs.workflow_runs || [])) { if (r.status === 'in_progress') running++; if (r.status === 'queued') queued++; }
    } catch (_) {}
    return { cpu: 0, ram: 0, disk: 0, sdk: '35', gradle: '8.7', jdk: '17', runner: 'github-actions/ubuntu-latest', queue: queued, running };
  };

  API.artifact = (b) => {
    if (!b || !b.id || !CREDS.owner) return null;
    return `https://github.com/${CREDS.owner}/${CREDS.repo}/releases/tag/build-${b.id}`;
  };

  API.cancel = async (b) => {
    if (!b || !b.id) return;
    const runs = await ghFetch(`${repoBase()}/actions/runs?per_page=30&event=workflow_dispatch`);
    const run = (runs.workflow_runs || []).find(r => (r.display_title || '').includes(b.id));
    if (run && run.status !== 'completed') await ghFetch(`${repoBase()}/actions/runs/${run.id}/cancel`, { method: 'POST' }).catch(() => {});
  };

  API.startBuild = async (p, f) => {
    if (!CREDS.pat) { ensureCredsModal(); throw new Error('PAT belum diisi'); }
    const id = genId(); const branch = 'main';

    const refRes = await ghFetch(`${repoBase()}/git/ref/heads/${branch}`);
    const parentSha = refRes.object.sha;
    const commitRes = await ghFetch(`${repoBase()}/git/commits/${parentSha}`);
    const baseTreeSha = commitRes.tree.sha;
    const treeEntries = [];
    
    async function addBlobToTree(path, file) {
      if (!file) return;
      const b64 = await fileToBase64(file);
      const blobRes = await ghFetch(`${repoBase()}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: b64, encoding: 'base64' }) });
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: blobRes.sha });
    }

    if (f.zip) await addBlobToTree(`input/${id}.zip`, f.zip);
    if (f.icon) await addBlobToTree(`input/${id}.icon.png`, f.icon);
    if (f.keystore) await addBlobToTree(`input/${id}.jks`, f.keystore);
    if (f.gservices) await addBlobToTree(`input/${id}.gservices.json`, f.gservices);

    const metaDoc = {
      id, meta: p,
      source: f.zip ? { type: 'zip', path: `input/${id}.zip` } : { type: 'git', url: p.git.url, branch: p.git.branch || 'main', token: p.git.token || '' },
      icon: f.icon ? { path: `input/${id}.icon.png` } : null,
      keystore: f.keystore ? { path: `input/${id}.jks`, alias: p.keystore?.alias || '', storePassword: p.keystore?.password || '', keyPassword: p.keystore?.password || '' } : null,
      gservices: f.gservices ? { path: `input/${id}.gservices.json` } : null,
    };
    await addBlobToTree(`input/${id}.json`, new Blob([JSON.stringify(metaDoc)], { type: 'application/json' }));

    const treeRes = await ghFetch(`${repoBase()}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }) });
    const newCommitRes = await ghFetch(`${repoBase()}/git/commits`, { method: 'POST', body: JSON.stringify({ message: `input ${id}`, tree: treeRes.sha, parents: [parentSha] }) });
    await ghFetch(`${repoBase()}/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: newCommitRes.sha, force: false }) });

    await ghFetch(`${repoBase()}/actions/workflows/build.yml/dispatches`, {
      method: 'POST', body: JSON.stringify({ ref: branch, inputs: { build_id: id, timeout_minutes: String(p.options?.timeoutMin || 120) } }),
    });
    return { id };
  };

  // --- FUNGSI DOWNLOAD BARU (Bypass 404 & Private Repo) ---
  dl = async function (b) {
    if (!b || !b.id) { if (typeof toast === 'function') toast('Data build tidak valid'); return; }
    if (typeof toast === 'function') toast('Mengunduh APK, mohon tunggu...');
    try {
      const rel = await ghFetch(`${repoBase()}/releases/tags/build-${b.id}`);
      if (!rel || !rel.assets || rel.assets.length === 0) throw new Error('Rilis tidak ditemukan (404). Pastikan build sukses.');
      const asset = rel.assets.find(a => a.name.endsWith('.apk') || a.name.endsWith('.aab'));
      if (!asset) throw new Error('File APK tidak ada di rilis ini.');

      const res = await fetchWithTimeout(`https://api.github.com/repos/${CREDS.owner}/${CREDS.repo}/releases/assets/${asset.id}`, {
        headers: { Authorization: `Bearer ${CREDS.pat}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' }
      }, 120000);
      if (!res.ok) throw new Error(`Gagal unduh (Status: ${res.status})`);

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = asset.name;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
      
      setTimeout(() => {
        if (typeof toast === 'function') toast('Berhasil diunduh! Jika gagal install, uninstall versi lama dulu.');
        else alert('Berhasil diunduh! Jika gagal install, uninstall versi lama dulu.');
      }, 1500);
    } catch (e) {
      if (typeof toast === 'function') toast(e.message);
      else alert(e.message);
    }
  };

  const fetchLogChunk = async (buildId, n) => {
    const url = `https://github.com/${CREDS.owner}/${CREDS.repo}/releases/download/build-${buildId}/log-${n}.txt`;
    try {
      const r = await fetchWithTimeout(url, { cache: 'no-store' }, 10000);
      if (!r.ok) return null;
      return (await r.text()).split(/\r?\n/).filter(x => x.length > 0);
    } catch (_) { return null; }
  };

  const fetchFinalLog = async (buildId) => {
    try {
      const rel = await ghFetch(`${repoBase()}/releases/tags/build-${buildId}`).catch(() => null);
      if (!rel) return null;
      const asset = (rel.assets || []).find(a => a.name === 'build.log');
      if (!asset) return null;
      const r = await fetchWithTimeout(`https://api.github.com/repos/${CREDS.owner}/${CREDS.repo}/releases/assets/${asset.id}`, {
        headers: { Authorization: `Bearer ${CREDS.pat}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
      }, 15000);
      if (!r.ok) return null;
      return (await r.text()).split(/\r?\n/).filter(x => x.length > 0);
    } catch (_) { return null; }
  };

  API.live = (b, on) => {
    if (!CREDS.pat) return false;
    let stop = false;
    let runId = null;
    let lastPhase = -1;
    let polls = 0;

    const classOf = (line) => {
      if (/\b(error|failed|exception|FAILURE|FAILED)\b/i.test(line)) return 'e';
      if (/\b(warn|warning)\b/i.test(line)) return 'w';
      if (/\b(BUILD SUCCESSFUL|sukses|selesai|\[done\])\b/i.test(line)) return 'o';
      if (/^\[(prepare|deps|build|collect|upload|done|gh|poll)\]/.test(line)) return 'm';
      return '';
    };
    const emitLog = (line) => on({ type: 'log', text: line, c: classOf(line) });

    const tick = async () => {
      if (stop) return;
      polls++;
      try {
        if (!runId && polls <= 12) {
          const runs = await ghFetch(`${repoBase()}/actions/runs?per_page=10&event=workflow_dispatch`);
          const r = (runs.workflow_runs || []).find(x => (x.display_title || '').includes(b.id));
          if (r) { runId = r.id; emitLog(`[gh] run #${runId} ditemukan`); }
          else if (polls === 6) emitLog('[gh] menunggu runner…');
        }

        if (runId) {
          const run = await ghFetch(`${repoBase()}/actions/runs/${runId}`);
          try {
            const jobs = await ghFetch(`${repoBase()}/actions/runs/${runId}/jobs`);
            const job = (jobs.jobs || [])[0];
            if (job) {
              const total = (job.steps || []).length || 1;
              const done = (job.steps || []).filter(s => s.conclusion === 'success').length;
              const pct = Math.min(99, Math.round(done / total * 100));
              on({ type: 'progress', pct });
              on({ type: 'step', n: Math.min(4, Math.floor((done / total) * 5)) });
            }
          } catch (_) {}

          for (let n = lastPhase + 1; n < 30; n++) {
            const chunk = await fetchLogChunk(b.id, n);
            if (!chunk) break;
            for (const line of chunk) emitLog(line);
            lastPhase = n;
          }

          if (run.status === 'completed') {
            if (lastPhase < 0) {
              const full = await fetchFinalLog(b.id);
              if (full) for (const line of full) emitLog(line);
            }
            on({ type: 'status', st: run.conclusion === 'success' ? 'ok' : 'bad' });
            stop = true;
            return;
          }
        }
      } catch (e) {
        if (polls > 3) emitLog(`[poll] ${e.message}`);
      }
      setTimeout(tick, 4000);
    };
    tick();
    b._es = { close: () => { stop = true; } };
    return true;
  };

  onEvt = function (e) {
    if (!e || !e.type) return;
    if (e.type === 'log') addLog(e.text == null ? '' : String(e.text), e.c);
    if (e.type === 'step') drawSteps(Math.max(0, Math.min(4, Number(e.n) || 0)));
    if (e.type === 'progress') {
      const p = Math.max(0, Math.min(100, Number(e.pct) || 0));
      if (typeof cur !== 'undefined' && cur) cur.pct = p;
      const bar = qs('#liveBar'); if (bar) bar.style.width = p + '%';
    }
    if (e.type === 'status') {
      if (typeof cur === 'undefined' || !cur) return;
      cur.st = e.st;
      cur.pct = e.st === 'ok' ? 100 : (cur.pct || 0);
      if (typeof notifyDone === 'function') notifyDone(e.st);
      const sb = qs('#startBtn'); if (sb) { sb.disabled = false; sb.textContent = 'Mulai build'; }
      const cb = qs('#cancelBtn'); if (cb) cb.hidden = true;
      const pb = qs('#pb'); if (pb) pb.classList.remove('on');
      if (e.st === 'ok') {
        drawSteps(5);
        const bar = qs('#liveBar'); if (bar) bar.style.width = '100%';
        const dlb = qs('#dlBtn'); if (dlb) dlb.hidden = false;
        if (typeof toast === 'function') toast('Build selesai');
      } else {
        drawSteps(2, true);
        if (typeof toast === 'function') toast('Build gagal atau dibatalkan');
      }
      if (cur._es) { try { cur._es.close(); } catch (_) {} cur._es = null; }
      if (typeof renderAll === 'function') renderAll();
    }
  };

  renderAll = function () {
    const arr = typeof builds !== 'undefined' && Array.isArray(builds) ? builds : [];
    const n = (s) => arr.filter(b => b.st === s).length;
    const set = (id, v) => { const el = qs(id); if (el) el.textContent = v; };
    set('#sTot', arr.length); set('#sOk', n('ok')); set('#sBad', n('bad')); set('#sQ', n('run'));
    const card = (b) => '<div class="item"><span><b>' + esc(String(b.name || 'Tanpa nama')) + '</b><small>' + esc(String(b.ver || '?')) + ' · ' + ago(b.t || Date.now()) + '</small></span>' + sp(b.st || 'bad', b.pct) + '</div>';
    const recent = arr.slice(0, 4).map(card).join('') || '<div class="empty">Belum ada build.</div>';
    const r1 = qs('#recent'); if (r1) r1.innerHTML = recent;
    const r2 = qs('#recent2'); if (r2) r2.innerHTML = recent;

    const q = (qs('#q') ? qs('#q').value : '').toLowerCase();
    const f = qs('#fil') ? qs('#fil').value : '';
    const rows = arr.filter(b => {
      if (f && b.st !== f) return false;
      if (!q) return true;
      return (String(b.name || '') + String(b.pkg || '')).toLowerCase().includes(q);
    });
    const rowsEl = qs('#rows');
    if (rowsEl) {
      rowsEl.innerHTML = rows.map(b => {
        const id = esc(String(b.id));
        return '<div class="rw"><div><b>' + esc(String(b.name || 'Tanpa nama')) + '</b><small class="mono">' + esc(String(b.pkg || '')) + '</small></div>' +
          '<div class="mt">' + esc(String(b.ver || '?')) + ' · ' + esc(String(b.type || '?')) + ' · ' + String(b.fmt || 'apk').toUpperCase() + ' · ' + ago(b.t || Date.now()) + '</div>' +
          '<div class="ac">' + sp(b.st || 'bad', b.pct) + (b.st === 'ok' ? '<button class="btn mini" data-dl="' + id + '">Unduh</button>' : '') +
          '<button class="btn mini alt" data-rb="' + id + '">Ulangi</button><button class="btn mini alt" data-rm="' + id + '">Hapus</button></div></div>';
      }).join('') || '<div class="empty">Tidak ada build yang cocok.</div>';
    }
    const run = n('run') > 0;
    const ms = qs('#mSt'); if (ms) ms.className = 'sp ' + (run ? 'run' : '');
    const mt = qs('#mTxt');
    if (mt) mt.textContent = !CREDS.pat ? 'PAT belum diisi' : !CREDS.owner ? 'Owner belum diisi' : run ? 'Sedang membangun' : 'GitHub siap';
    updateConn();
  };

  const startBtn = qs('#startBtn');
  if (startBtn) startBtn.onclick = async () => {
    const originalText = startBtn.textContent;
    try {
      if (!CREDS.pat) { ensureCredsModal(); return; }
      
      const name = qs('#appName')?.value.trim();
      const pkg = qs('#pkg')?.value.trim();
      
      if (!name) { if (typeof toast === 'function') toast('Isi nama aplikasi dulu'); qs('#appName')?.focus(); return; }
      if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(pkg || '')) { if (typeof toast === 'function') toast('ID paket harus seperti com.contoh.app'); qs('#pkg')?.focus(); return; }
      
      const srcEl = qs('#srcSeg button.on');
      const src = srcEl ? srcEl.dataset.v : 'zip';
      if (src === 'zip' && !(qs('#zipIn')?.files?.length)) { if (typeof toast === 'function') toast('Pilih berkas ZIP proyek'); return; }
      if (src === 'git' && !qs('#gitUrl')?.value.trim()) { if (typeof toast === 'function') toast('Isi URL repositori'); return; }
      
      const vc = Number(qs('#vCode')?.value);
      if (!Number.isInteger(vc) || vc < 1) { if (typeof toast === 'function') toast('Kode versi harus bilangan bulat ≥ 1'); return; }
      
      if (!qsa('#arch .chip.on').length) { if (typeof toast === 'function') toast('Pilih minimal satu arsitektur'); return; }
      
      const typeEl = qs('#typeSeg button.on');
      const type = typeEl ? typeEl.dataset.v : 'debug';
      const fmtEl = qs('#fmtSeg button.on');
      const fmt = fmtEl ? fmtEl.dataset.v : 'apk';
      
      const ks = qs('#ksIn') || qsa('#signCard input[type=file]')[0];
      if (type === 'release' && (!ks || !ks.files[0])) { if (typeof toast === 'function') toast('Pilih berkas keystore untuk build release'); return; }

      const opts = {
        ...Object.fromEntries(qsa("[data-opt]").map(e => [e.dataset.opt, e.checked])),
        abis: qsa("#arch .chip.on").map(c => c.textContent),
        minSdk: +(qs("#minSdk")?.value) || 24,
        targetSdk: +(qs("#tgtSdk")?.value) || 34,
        jdk: (qs("#jdk")?.value) || '17',
        gradle: (qs("#grd")?.value) || '8.7',
        timeoutMin: +(qs("#tmo")?.value) || 120,
        subdir: (qs("#sub")?.value) || '',
        outputName: (qs("#outn")?.value) || '',
        gradleArgs: (qs("#gargs")?.value) || ''
      };

      const permissions = [...document.querySelectorAll('#perms [data-pk].on')].map(el => 'android.permission.' + el.dataset.pk);
      const features = { orientation: qs('#ori')?.value || 'auto', ...Object.fromEntries(qsa('[data-feat]').map(e => [e.dataset.feat, e.checked])) };

      startBtn.disabled = true;
      startBtn.textContent = 'Mengunggah...';

      const r = await API.startBuild({
        name, pkg, type, fmt,
        ver: qs('#vName')?.value || '1.0.0',
        vcode: vc,
        framework: qs('#framework')?.value || 'Android native (Gradle)',
        env: qs('#env')?.value || '',
        git: src === 'git' ? { url: qs('#gitUrl').value, branch: qs('#gitBr').value, token: qs('#gitTok').value } : null,
        keystore: type === 'release' ? { alias: qs('#alias')?.value || '', password: qs('#ksPw')?.value || '' } : null,
        permissions, features, options: opts,
      }, {
        zip: src === 'zip' ? qs('#zipIn').files[0] : null,
        icon: (qs('#iconIn') || qsa('input[accept="image/png"]')[0])?.files?.[0] || null,
        keystore: type === 'release' && ks ? ks.files[0] : null,
        gservices: qs('#gsv')?.files?.[0] || null,
      });

      if (typeof cur !== 'undefined') cur = { id: r.id, name, pkg, ver: qs('#vName')?.value, type, fmt, st: 'run', t: Date.now(), pct: 0 };
      if (typeof builds !== 'undefined') builds.unshift(cur);
      if (typeof renderAll === 'function') renderAll();
      if (typeof keepAwake === 'function') keepAwake(true);

      const logEl = qs('#log'); if (logEl) logEl.innerHTML = '';
      if (typeof logBuf !== 'undefined' && Array.isArray(logBuf)) logBuf.length = 0;
      
      const dlb = qs('#dlBtn'); if (dlb) dlb.hidden = true;
      const cb = qs('#cancelBtn'); if (cb) cb.hidden = false;
      const bar = qs('#liveBar'); if (bar) bar.style.width = '0';
      const pb = qs('#pb'); if (pb) pb.classList.add('on');
      const lt = qs('#liveTitle'); if (lt) lt.textContent = 'Membangun ' + name;
      
      if (typeof drawSteps === 'function') drawSteps(0);
      if (typeof addLog === 'function') { addLog(`[gh] memicu workflow...`, 'o'); addLog(`[gh] build_id=${r.id}`, 'm'); }
      if (logEl) logEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      if (API.live(cur, onEvt)) return;
      
    } catch (e) {
      console.error(e);
      if (typeof toast === 'function') toast(e.message || 'Gagal mulai build');
      else alert(e.message || 'Gagal mulai build');
      startBtn.disabled = false;
      startBtn.textContent = originalText;
    }
  };

  document.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.preventDefault(); e.stopPropagation();
      try { await API.remove(rm.dataset.rm); } catch (_) {}
      if (typeof builds !== 'undefined') builds = builds.filter(b => String(b.id) !== rm.dataset.rm);
      if (typeof renderAll === 'function') renderAll();
      return;
    }
    const clr = e.target.closest('#clr');
    if (clr) {
      const armed = clr.dataset.armed === '1';
      if (!armed) { clr.dataset.armed = '1'; if (typeof toast === 'function') toast('Tekan sekali lagi untuk hapus semua'); setTimeout(() => delete clr.dataset.armed, 3000); return; }
      delete clr.dataset.armed;
      try { await API.removeAll(); } catch (_) {}
      if (typeof builds !== 'undefined') builds = [];
      if (typeof renderAll === 'function') renderAll();
    }
  }, true);

  async function pollOnce() {
    if (!CREDS.pat || !CREDS.owner) return;
    try {
      const arr = await API.list();
      if (typeof builds !== 'undefined') {
        builds = arr;
        if (typeof cur !== 'undefined' && cur && cur.st === 'run') {
          const m = builds.find(b => String(b.id) === String(cur.id));
          if (m && m.st !== 'run' && typeof onEvt === 'function') onEvt({ type: 'status', st: m.st });
        }
      }
      if (typeof renderAll === 'function') renderAll();
    } catch (e) {
      const mt = qs('#mTxt'); if (mt) mt.textContent = `GitHub: ${e.message}`;
    }
  }
  async function pollMachine() {
    if (!CREDS.pat) return;
    try {
      const m = await API.machine();
      const info = qs('#mInfo');
      if (info) info.textContent = `GitHub Actions · runner ${m.runner.split('/')[1]} · queue ${m.queue} · running ${m.running}`;
    } catch (_) {}
  }

  const jdkEl = qs('#jdk');
  if (jdkEl) { [...jdkEl.options].forEach(o => { if (o.value === '11') o.disabled = true; }); if (!jdkEl.value) jdkEl.value = '17'; }
  const grdEl = qs('#grd');
  if (grdEl) { if (!grdEl.value) grdEl.value = '8.7'; }
  if (qs('#tmo')) { if (!qs('#tmo').value) qs('#tmo').value = '120'; qs('#tmo').min = '1'; qs('#tmo').max = '120'; }
  if (qs('#ret')) { if (!qs('#ret').value) qs('#ret').value = '7'; qs('#ret').min = '1'; qs('#ret').max = '30'; }
  if (qs('#vCode')) qs('#vCode').min = '1';

  const cbox = qs('#conn')?.parentElement;
  if (cbox && !cbox.querySelector('[data-creds]')) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn alt mini';
    delBtn.textContent = 'Ganti kredensial';
    delBtn.style.marginTop = '10px';
    delBtn.dataset.creds = '1';
    delBtn.onclick = ensureCredsModal;
    cbox.appendChild(delBtn);
  }

  if (!CREDS.owner || !CREDS.pat) setTimeout(ensureCredsModal, 400);

  updateConn();
  pollOnce();
  pollMachine();
  setInterval(pollOnce, 8000);
  setInterval(pollMachine, 15000);

  setInterval(() => {
    const l = qs('#log');
    if (l && l.childElementCount > 4000) { while (l.childElementCount > 3000) l.firstElementChild.remove(); }
    if (typeof logBuf !== 'undefined' && Array.isArray(logBuf) && logBuf.length > 6000) logBuf.splice(0, logBuf.length - 6000);
  }, 5000);

  if (typeof renderAll === 'function') renderAll();
})();
