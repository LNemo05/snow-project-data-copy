// Project Data Copier — copies project memories and memos between projects.
//
// Verified field contract (probe, 2026-10-07) for memory.create:
//   accepted & round-tripped : directoryId, kind, title, content, importance, tags
//   NOT controllable         : source (always "user"), conversationId (empty),
//                              createdAt/updatedAt (ignored by the write API by design),
//                              memoryId (always regenerated)
// memos.create was verified to honour {directoryId, content, status} natively.
//
// Safety model:
//   - the source project is READ-ONLY: no update/remove is ever issued against it
//   - remove is only ever called on ids this plugin itself just created (undo)
//   - copying is a two-step action (arm, then confirm)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Display-only: memo bodies can contain HTML. Never used for copying.
function stripHtml(s) {
  return String(s == null ? "" : s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

const short = (s) => {
  const v = String(s == null ? "" : s);
  return v.length > 26 ? v.slice(0, 24) + "…" : v;
};

async function readPaged(api, domain, directoryId) {
  const all = [];
  const limit = 200;
  let offset = 0;
  for (let page = 0; page < 25; page++) {
    const res = await api.metadata.get(domain, { params: { directoryId, limit, offset } });
    const node = res && res.domains && res.domains[domain];
    const box = node && node.items;
    const items = box && box.items;
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) all.push(it);
    if (!box.hasMore) break;
    offset += items.length;
  }
  return all;
}

function createdId(data) {
  if (!data) return "";
  return data.memoryId || data.memoId || data.id || "";
}

// memos.create honours `status` natively (verified), but keep the repair path as a
// cheap safety net in case a future version changes that.
async function repairMemoStatus(api, dirId, item, data) {
  const got = data && data.status;
  if (got === item.status) return { ok: true, status: got, repaired: false };

  let memoId = createdId(data);
  if (!memoId) {
    const list = await readPaged(api, "memos", dirId);
    const hit = list.find((x) => x.content === item.content);
    memoId = hit ? hit.memoId : "";
  }
  if (!memoId) return { ok: false, lastStatus: got, error: "状态不符且无法定位新条目" };

  const u = await api.write.run("memos.updateStatus", {
    directoryId: dirId,
    memoId,
    status: item.status,
  });
  if (u && u.ok) {
    const after = u.data && u.data.status;
    return { ok: after === item.status, status: after, repaired: true, memoId };
  }
  return {
    ok: false,
    lastStatus: got,
    error: "状态修正失败: " + JSON.stringify((u && (u.error || u.denied)) || {}),
    memoId,
  };
}

// ---------------------------------------------------------------------------
// resource descriptors
// ---------------------------------------------------------------------------

const RESOURCES = {
  memory: {
    key: "memory",
    tab: "项目记忆",
    domain: "memory",
    createAction: "memory.create",
    removeAction: "memory.remove",
    removePayload: (dirId, id) => ({ directoryId: dirId, memoryId: id }),
    createPayload: (dirId, m) => ({
      directoryId: dirId,
      kind: m.kind,
      title: m.title,
      content: m.content,
      importance: m.importance,
      tags: Array.isArray(m.tags) ? m.tags : [],
    }),
    keyOf: (m) => (m.title || "") + "\u0000" + (m.content || ""),
    label: (m) => m.title || "(无标题)",
    badge: (m) => m.kind,
    badgeCls: (m) => "mc-kind mc-kind-" + String(m.kind || "").replace(/[^a-z_]/g, ""),
    sub: (m) => "imp " + m.importance,
    afterCreate: null,
    note:
      "字段保真：kind / title / content / importance / tags 完整复制；" +
      "source、conversationId 与创建时间由系统重新生成，无法保留。",
  },
  memo: {
    key: "memo",
    tab: "备忘录",
    domain: "memos",
    createAction: "memos.create",
    removeAction: "memos.remove",
    removePayload: (dirId, id) => ({ directoryId: dirId, memoId: id }),
    createPayload: (dirId, m) => ({
      directoryId: dirId,
      content: m.content,
      status: m.status,
    }),
    keyOf: (m) => m.content || "",
    label: (m) => stripHtml(m.content) || "(空)",
    badge: (m) => m.status,
    badgeCls: (m) => "mc-kind " + (m.status === "done" ? "mc-st-done" : "mc-st-pending"),
    sub: () => "",
    afterCreate: repairMemoStatus,
    note:
      "字段保真：content 原样复制（含 HTML 富文本）；" +
      "status 由插件在创建后自动校验，若未生效则用 updateStatus 修正。",
  },
};

// ---------------------------------------------------------------------------
// copier — one resource at a time; project selection is owned by the parent
// ---------------------------------------------------------------------------

function Copier({ api, resource, projects, srcId, dstId, setSrcId, setDstId, created, onCreatedChange }) {
  const { React } = window.SnowAppPlugin;
  const h = React.createElement;
  const R = resource;

  const [src, setSrc] = React.useState(null);
  const [dst, setDst] = React.useState(null);
  const [picked, setPicked] = React.useState({});
  const [skipExisting, setSkipExisting] = React.useState(true);
  const [busy, setBusy] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [log, setLog] = React.useState([]);
  const [armed, setArmed] = React.useState(false);

  const out = (line) => setLog((p) => [line, ...p].slice(0, 300));

  const idOf = (m) => m.memoryId || m.memoId || R.keyOf(m);

  async function scan() {
    if (!srcId || !dstId || srcId === dstId) {
      setSrc(null); setDst(null); setStatus(""); return;
    }
    setBusy("scan"); setStatus(""); setLog([]); setArmed(false);
    try {
      const [a, b] = await Promise.all([
        readPaged(api, R.domain, srcId),
        readPaged(api, R.domain, dstId),
      ]);
      setSrc(a); setDst(b);
      const existing = new Set(b.map(R.keyOf));
      const sel = {};
      for (const m of a) sel[idOf(m)] = !(skipExisting && existing.has(R.keyOf(m)));
      setPicked(sel);
      const dup = a.filter((m) => existing.has(R.keyOf(m))).length;
      setStatus(`源 ${a.length} 条 · 目标 ${b.length} 条 · 其中 ${dup} 条内容已存在`);
    } catch (e) {
      setStatus("扫描失败: " + String(e && e.message ? e.message : e));
    } finally { setBusy(""); }
  }

  // re-scan whenever the project pair changes (and once on mount)
  React.useEffect(() => { scan(); }, [srcId, dstId, R.key]);

  const dstKeys = React.useMemo(() => new Set((dst || []).map(R.keyOf)), [dst]);
  const selected = React.useMemo(
    () => (src || []).filter((m) => picked[idOf(m)]),
    [src, picked],
  );

  function applySkipExisting(next) {
    const existing = new Set((dst || []).map(R.keyOf));
    setSkipExisting(next);
    setPicked((prev) => {
      const o = {};
      for (const m of src || []) {
        o[idOf(m)] = existing.has(R.keyOf(m)) ? !next : !!prev[idOf(m)];
      }
      return o;
    });
  }

  async function doCopy() {
    if (selected.length === 0) return;
    setBusy("copy"); setArmed(false); setLog([]);
    const made = [];
    let ok = 0, fail = 0, repaired = 0, statusBad = 0;
    for (let i = 0; i < selected.length; i++) {
      const m = selected[i];
      setStatus(`复制中 ${i + 1}/${selected.length} …`);
      const r = await api.write.run(R.createAction, R.createPayload(dstId, m));
      if (!(r && r.ok)) {
        fail++;
        out("✗ " + R.label(m) + " → " +
          (r && r.denied ? "denied:" + JSON.stringify(r.denied) : (r && r.error) || "unknown"));
        continue;
      }
      const mid = createdId(r.data);
      if (mid) made.push({ id: mid, label: R.label(m) });

      if (R.afterCreate) {
        const fix = await R.afterCreate(api, dstId, m, r.data);
        if (fix.repaired) repaired++;
        if (!fix.ok) {
          statusBad++;
          out("△ " + R.label(m) + " → " + (fix.error || `状态未生效(仍为 ${fix.lastStatus})`));
        }
      }
      ok++;
    }
    onCreatedChange(made);
    try {
      const fresh = await readPaged(api, R.domain, dstId);
      setDst(fresh);
      let extra = "";
      if (R.afterCreate) extra = ` · 状态修正 ${repaired} 条 · 状态异常 ${statusBad} 条`;
      setStatus(`完成：成功 ${ok} 条，失败 ${fail} 条${extra}。目标现有 ${fresh.length} 条。`);
    } catch (e) {
      setStatus(`完成：成功 ${ok} 条，失败 ${fail} 条（复核目标时出错）`);
    }
    out(`复制完成 ok=${ok} fail=${fail} repaired=${repaired} statusBad=${statusBad}`);
    setBusy("");
  }

  async function undo() {
    if (created.length === 0) return;
    setBusy("undo");
    let ok = 0;
    for (const c of created) {
      const r = await api.write.run(R.removeAction, R.removePayload(dstId, c.id));
      if (r && r.ok) ok++;
      else out("撤销失败: " + c.label);
    }
    out(`撤销完成：删除 ${ok}/${created.length} 条`);
    onCreatedChange([]);
    try { setDst(await readPaged(api, R.domain, dstId)); } catch (e) { /* ignore */ }
    setBusy("");
  }

  const projName = (d) =>
    d.name + (d.kind === "ssh" ? "  [SSH]" : d.kind === "local" ? "  [本机]" : "");

  const row = (m) => {
    const dup = dstKeys.has(R.keyOf(m));
    const on = !!picked[idOf(m)];
    const sub = R.sub(m);
    return h("div", { key: idOf(m), className: "mc-row" + (on ? " mc-on" : "") },
      h("input", {
        type: "checkbox", checked: on,
        onChange: () => setPicked((p) => ({ ...p, [idOf(m)]: !p[idOf(m)] })),
      }),
      h("span", { className: R.badgeCls(m) }, R.badge(m)),
      sub ? h("span", { className: "mc-imp" }, sub) : null,
      h("span", { className: "mc-title", title: R.label(m) }, R.label(m)),
      dup ? h("span", { className: "mc-dup" }, "已存在") : null,
    );
  };

  const sameProject = !!srcId && !!dstId && srcId === dstId;
  const canScan = !!srcId && !!dstId && !sameProject && !busy;
  const dstProject = projects.find((d) => d.directoryId === dstId);
  const dstLabel = dstProject ? short(dstProject.name) : "";
  const toLabel = dstLabel || "目标项目";

  return h("div", { className: "mc-body" },
    h("div", { className: "mc-sec" },
      h("div", { className: "mc-lbl" }, "源项目（只读，不会被修改）"),
      h("select", { className: "mc-sel", value: srcId, onChange: (e) => setSrcId(e.target.value) },
        h("option", { value: "" }, "— 选择 —"),
        projects.map((d) => h("option", { key: d.directoryId, value: d.directoryId }, projName(d))))),
    h("div", { className: "mc-sec" },
      h("div", { className: "mc-lbl" }, "目标项目（数据将被写入这里）"),
      h("select", { className: "mc-sel", value: dstId, onChange: (e) => setDstId(e.target.value) },
        h("option", { value: "" }, "— 选择 —"),
        projects.map((d) => h("option", { key: d.directoryId, value: d.directoryId }, projName(d))))),
    h("div", { className: "mc-bar" },
      h("button", { className: "mc-btn", disabled: !canScan, onClick: scan },
        busy === "scan" ? "扫描中…" : "扫描"),
      h("label", { className: "mc-chk" },
        h("input", { type: "checkbox", checked: skipExisting, onChange: (e) => applySkipExisting(e.target.checked) }),
        "跳过目标已有的条目")),
    sameProject ? h("div", { className: "mc-warn" }, "源项目和目标项目相同，无法复制") : null,
    status ? h("div", { className: "mc-status" }, status) : null,
    src
      ? h("div", { className: "mc-sec" },
          h("div", { className: "mc-bar" },
            h("span", { className: "mc-lbl" }, `待复制 ${selected.length} / ${src.length} 条`),
            h("span", { className: "mc-sp" }),
            h("button", {
              className: "mc-btn mc-mini",
              onClick: () => { const s = {}; src.forEach((m) => { s[idOf(m)] = true; }); setPicked(s); },
            }, "全选"),
            h("button", { className: "mc-btn mc-mini", onClick: () => setPicked({}) }, "全不选")),
          h("div", { className: "mc-list" }, src.map(row)))
      : null,
    src && selected.length > 0 && !busy
      ? h("div", { className: "mc-bar" },
          armed
            ? h("span", { className: "mc-arm" },
                h("button", { className: "mc-btn mc-danger", onClick: doCopy },
                  `确认复制 ${selected.length} 条到 ${toLabel} →`),
                h("button", { className: "mc-btn mc-mini", onClick: () => setArmed(false) }, "取消"))
            : h("button", { className: "mc-btn mc-primary", onClick: () => setArmed(true) },
                `复制选中 ${selected.length} 条到 ${toLabel}`))
      : null,
    busy === "copy" ? h("div", { className: "mc-status" }, "复制进行中，请勿关闭面板…") : null,
    created.length > 0
      ? h("div", { className: "mc-sec mc-undo" },
          h("div", { className: "mc-lbl" }, `本次已创建 ${created.length} 条（仅在目标项目）`),
          h("button", { className: "mc-btn mc-mini", disabled: !!busy, onClick: undo },
            busy === "undo" ? "撤销中…" : "撤销本次复制（删除刚创建的条目）"))
      : null,
    log.length > 0
      ? h("details", { className: "mc-sec" },
          h("summary", null, "日志 (" + log.length + ")"),
          h("pre", { className: "mc-log" }, log.join("\n")))
      : null,
    h("div", { className: "mc-note" }, R.note),
  );
}

// ---------------------------------------------------------------------------
// merged panel: project pickers + resource tabs are shared, undo is kept per resource
// ---------------------------------------------------------------------------

export default function Panel({ api }) {
  const { React } = window.SnowAppPlugin;
  const h = React.createElement;

  const [resKey, setResKey] = React.useState("memory");
  const [projects, setProjects] = React.useState([]);
  const [srcId, setSrcId] = React.useState("");
  const [dstId, setDstId] = React.useState("");
  const [undoStore, setUndoStore] = React.useState({});

  React.useEffect(() => {
    (async () => {
      try {
        const res = await api.metadata.get("projects", { params: {} });
        const p = res && res.domains && res.domains.projects;
        setProjects((p && p.directories) || []);
        if (p && p.active && p.active.directoryId) setSrcId(p.active.directoryId);
      } catch (e) {
        api.log("load projects failed", e);
      }
    })();
  }, []);

  const resource = RESOURCES[resKey] || RESOURCES.memory;

  return h("div", { className: "mc-root" },
    h("div", { className: "mc-tabs" },
      ["memory", "memo"].map((k) =>
        h("button", {
          key: k,
          className: "mc-tab" + (resKey === k ? " mc-tab-on" : ""),
          onClick: () => setResKey(k),
        }, RESOURCES[k].tab))),
    h(Copier, {
      key: resKey,
      api,
      resource,
      projects,
      srcId,
      dstId,
      setSrcId,
      setDstId,
      created: undoStore[resKey] || [],
      onCreatedChange: (v) => setUndoStore((s) => ({ ...s, [resKey]: v })),
    }),
  );
}
