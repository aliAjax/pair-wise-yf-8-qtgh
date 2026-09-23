/* ============================================================
 * 存档层：预置数据 + localStorage 同步（仅在事务成功后写入）
 * ============================================================ */

const storageKey = "zfl17-film-strip-desk";

const ROUTES = [
  { id: "R1", name: "一号主线", limit: 2 },
  { id: "R2", name: "二号副线", limit: 2 },
  { id: "R3", name: "三号机动线", limit: 1 }
];

const BOXES = [
  { id: "35mm", name: "35mm 标准盒", stock: 4 },
  { id: "16mm", name: "16mm 教学盒", stock: 5 },
  { id: "8mm", name: "8mm 家用盒", stock: 3 },
  { id: "trailer", name: "预告片盒", stock: 2 },
  { id: "spare", name: "备用备份盒", stock: 2 }
];

const defaultSpec = { maxSegments: 12, maxSegmentDuration: 30, maxReelDuration: 240 };

const REEL_STATUS = {
  active: { label: "放映中", cls: "ok" },
  frozen: { label: "缺盒冻结", cls: "frozen" },
  stopped: { label: "已停映", cls: "muted" },
  cancelled: { label: "已撤销", cls: "muted" }
};

const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

function seg(code, duration, shift, damage, note, thumb = "") {
  return { id: crypto.randomUUID(), code, duration, shift, damage, note, thumb };
}

function reel(r) {
  return {
    id: crypto.randomUUID(),
    title: r.title,
    routeId: r.routeId,
    status: r.status,
    boxes: Object.fromEntries(BOXES.map((box) => [box.id, 0])),
    segments: [],
    createdAt: Date.now(),
    ...r
  };
}

function buildSeedState() {
  const demo = reel({
    title: "春日试映A卷",
    routeId: "R1",
    status: "active",
    boxes: { "35mm": 2, "16mm": 1, "8mm": 0, trailer: 1, spare: 0 },
    segments: [
      seg("A-001", 18, "正常", "完好", "开场街景，节奏平稳，适合保留原顺序。"),
      seg("A-006", 9, "偏红", "轻微划痕", "人物近景左侧有划痕，试映时留意是否明显。"),
      seg("A-012", 14, "褪色", "接片松动", "接片位置靠近段尾，放映前建议重新压平。")
    ]
  });
  const frozen = reel({
    title: "周二早场B卷",
    routeId: "R2",
    status: "frozen",
    boxes: { "35mm": 3, "16mm": 0, "8mm": 1, trailer: 0, spare: 0 },
    segments: [seg("B-003", 11, "正常", "完好", "片盒未到齐，登记后冻结在二号副线。")]
  });
  const done = reel({
    title: "上周回顾C卷",
    routeId: "R3",
    status: "stopped",
    boxes: { "35mm": 0, "16mm": 2, "8mm": 0, trailer: 0, spare: 1 },
    segments: [seg("C-010", 20, "正常", "完好", "已停映，不再占用线路和片盒。")]
  });
  return { spec: { ...defaultSpec }, reels: [demo, frozen, done] };
}

function normalizeBoxes(boxes) {
  const source = boxes || {};
  return Object.fromEntries(BOXES.map((box) => [box.id, Math.max(0, Number(source[box.id]) || 0)]));
}

function normalizeSegment(item) {
  return {
    id: item && item.id ? String(item.id) : crypto.randomUUID(),
    code: String(item?.code ?? ""),
    duration: Number(item?.duration) || 0,
    shift: String(item?.shift ?? "正常"),
    damage: String(item?.damage ?? "完好"),
    note: String(item?.note ?? ""),
    thumb: String(item?.thumb ?? "")
  };
}

function normalizeReel(raw) {
  const status = REEL_STATUS[raw?.status] ? raw.status : "active";
  return {
    id: raw?.id ? String(raw.id) : crypto.randomUUID(),
    title: String(raw?.title ?? "未命名胶片卷"),
    routeId: ROUTES.some((route) => route.id === raw?.routeId) ? raw.routeId : ROUTES[0].id,
    status,
    boxes: normalizeBoxes(raw?.boxes),
    segments: Array.isArray(raw?.segments) ? raw.segments.map(normalizeSegment) : [],
    createdAt: Number(raw?.createdAt) || Date.now()
  };
}

const Archive = {
  key: storageKey,

  load() {
    const saved = localStorage.getItem(this.key);
    if (!saved) return buildSeedState();
    let parsed = null;
    try {
      parsed = JSON.parse(saved);
    } catch {
      return buildSeedState();
    }
    if (Array.isArray(parsed?.reels)) {
      return {
        spec: { ...defaultSpec, ...(parsed.spec || {}) },
        reels: parsed.reels.map(normalizeReel)
      };
    }
    // 兼容旧版「核对台」单卷存档：迁移为一条放映中卷
    return this.migrateLegacy(parsed) || buildSeedState();
  },

  migrateLegacy(parsed) {
    try {
      if (Array.isArray(parsed.segments)) {
        return {
          spec: { ...defaultSpec },
          reels: [
            reel({
              title: String(parsed.reelTitle || "迁移自核对台的胶片卷"),
              routeId: ROUTES[0].id,
              status: "active",
              segments: parsed.segments.map(normalizeSegment)
            })
          ]
        };
      }
    } catch {
      /* 忽略无法识别的存档 */
    }
    return null;
  },

  save(state) {
    localStorage.setItem(this.key, JSON.stringify({ spec: state.spec, reels: state.reels }));
  }
};

let state = Archive.load();

/* ============================================================
 * 占用层：纯查询 + 事务判定，不触碰 DOM
 * ============================================================ */

const Occupancy = {
  isOpen(status) {
    return status === "active" || status === "frozen";
  },

  routeUsage(reels, routeId, ignoreReelId = null) {
    return reels.filter((r) => r.status === "active" && r.routeId === routeId && r.id !== ignoreReelId).length;
  },

  boxUsage(reels, ignoreReelId = null) {
    const usage = Object.fromEntries(BOXES.map((box) => [box.id, 0]));
    for (const r of reels) {
      if (r.status !== "active" || r.id === ignoreReelId) continue;
      for (const box of BOXES) usage[box.id] += r.boxes[box.id] || 0;
    }
    return usage;
  },

  reelViolations(reel, spec) {
    const violations = [];
    if (reel.segments.length > spec.maxSegments) {
      violations.push(`片段数 ${reel.segments.length} > ${spec.maxSegments}`);
    }
    const overSegment = reel.segments.find((item) => Number(item.duration) > spec.maxSegmentDuration);
    if (overSegment) {
      violations.push(`片段 ${overSegment.code} 单段 ${overSegment.duration}秒 > ${spec.maxSegmentDuration}秒`);
    }
    const total = reel.segments.reduce((sum, item) => sum + Number(item.duration), 0);
    if (total > spec.maxReelDuration) {
      violations.push(`总时长 ${total}秒 > ${spec.maxReelDuration}秒`);
    }
    return violations;
  },

  anyOpenViolation(reels, spec) {
    for (const r of reels) {
      if (!this.isOpen(r.status)) continue;
      const violations = this.reelViolations(r, spec);
      if (violations.length) return { reel: r, violations };
    }
    return null;
  },

  // 开卷 / 恢复前的整卷校验：任一条件不满足即整卷拒绝
  evaluate(reels, { title, routeId, boxes, ignoreReelId = null }) {
    const errors = [];
    if (!String(title || "").trim()) errors.push("胶片卷名称不能为空。");

    const route = ROUTES.find((item) => item.id === routeId);
    if (!route) {
      errors.push("所选线路不存在。");
    } else if (this.routeUsage(reels, routeId, ignoreReelId) + 1 > route.limit) {
      errors.push(`线路「${route.name}」件数超限（上限 ${route.limit} 卷）。`);
    }

    const usage = this.boxUsage(reels, ignoreReelId);
    const busy = [];
    const short = [];
    for (const box of BOXES) {
      const need = boxes[box.id] || 0;
      if (need <= 0) continue;
      const occupied = usage[box.id] || 0;
      const free = box.stock - occupied;
      if (free <= 0) {
        busy.push(`「${box.name}」已被其他未结束卷占满（${occupied}/${box.stock}）`);
      } else if (need > free) {
        short.push(`「${box.name}」需 ${need}，空闲仅 ${free}`);
      }
    }
    if (busy.length) errors.push(`片盒占用：${busy.join("；")}。`);
    if (short.length) errors.push(`片盒不足：${short.join("；")}。`);

    return { ok: errors.length === 0, errors };
  },

  // 缺盒登记：冻结卷不占线路与片盒，只校验名称、线路存在与片段规格；恢复时再做完整占用校验
  evaluateShortage(reels, { title, routeId, segments, spec }) {
    const errors = [];
    if (!String(title || "").trim()) errors.push("胶片卷名称不能为空。");
    if (!ROUTES.some((item) => item.id === routeId)) errors.push("所选线路不存在。");
    const violations = this.reelViolations({ segments: segments || [] }, spec);
    if (violations.length) errors.push(`超出每卷片段规格：${violations.join("；")}。`);
    return { ok: errors.length === 0, errors };
  }
};

/* ============================================================
 * 状态事务：每个事务要么整体成功（存档+重绘），要么原样不动
 * ============================================================ */

let currentReelId = null;
let draggedId = null;

function getCurrentReel() {
  return state.reels.find((item) => item.id === currentReelId) || state.reels[0] || null;
}

function commit() {
  Archive.save(state);
  renderAll();
}

function readBoxQuantities() {
  return Object.fromEntries(BOXES.map((box) => [box.id, Number(document.querySelector(`#boxQtyList [data-box="${box.id}"]`)?.value) || 0]));
}

function openReel(allowShortage) {
  const title = els.openTitle.value.trim();
  const routeId = els.openRoute.value;
  const boxes = readBoxQuantities();

  if (allowShortage) {
    const result = Occupancy.evaluateShortage(state.reels, {
      title,
      routeId,
      boxes,
      segments: [],
      spec: state.spec
    });
    if (!result.ok) {
      pushNotice(result.errors.join(" "), "error");
      return;
    }
    const created = reel({ title, routeId, status: "frozen", boxes });
    state.reels.push(created);
    currentReelId = created.id;
    els.openForm.reset();
    pushNotice(`卷「${title}」已按缺盒登记并冻结，不占用线路与片盒，到齐后可恢复。`, "info");
    commit();
    return;
  }

  const result = Occupancy.evaluate(state.reels, { title, routeId, boxes });
  if (!result.ok) {
    // 整卷拒绝：现有排序与占用一律不变；片盒不够时提示走缺盒登记
    const hint = result.errors.some((message) => message.startsWith("片盒"))
      ? " 片盒未到齐可改用「缺盒登记（冻结）」。"
      : "";
    pushNotice(`整卷拒绝：${result.errors.join(" ")}${hint}`, "error");
    return;
  }

  const created = reel({ title, routeId, status: "active", boxes });
  state.reels.push(created);
  currentReelId = created.id;
  els.openForm.reset();
  pushNotice(`卷「${title}」已在${ROUTES.find((r) => r.id === routeId).name}开卷放映。`, "ok");
  commit();
}

function restoreReel(id) {
  const target = state.reels.find((item) => item.id === id);
  if (!target || target.status !== "frozen") return;
  const result = Occupancy.evaluate(state.reels, {
    title: target.title,
    routeId: target.routeId,
    boxes: target.boxes,
    ignoreReelId: target.id
  });
  if (!result.ok) {
    pushNotice(`恢复被拒绝（卷保持冻结，排序不变）：${result.errors.join(" ")}`, "error");
    return;
  }
  target.status = "active";
  pushNotice(`卷「${target.title}」片盒已到齐，恢复放映并占用线路与片盒。`, "ok");
  commit();
}

function releaseReel(id, status) {
  const target = state.reels.find((item) => item.id === id);
  if (!target || !Occupancy.isOpen(target.status)) return;
  target.status = status;
  if (currentReelId === target.id) {
    const next = state.reels.find((item) => Occupancy.isOpen(item.status)) || state.reels[0] || null;
    currentReelId = next ? next.id : null;
  }
  pushNotice(`卷「${target.title}」${REEL_STATUS[status].label}，线路件数与片盒已释放。`, "info");
  commit();
}

async function addSegment(event) {
  event.preventDefault();
  const current = getCurrentReel();
  if (!current) {
    pushNotice("请先开卷再录入片段。", "error");
    return;
  }
  if (!Occupancy.isOpen(current.status)) {
    pushNotice(`卷「${current.title}」已结束，不能再录入片段。`, "error");
    return;
  }
  const nextSegments = [
    ...current.segments,
    {
      id: crypto.randomUUID(),
      code: els.codeInput.value.trim(),
      duration: Number(els.durationInput.value),
      shift: els.shiftInput.value,
      damage: els.damageInput.value,
      note: els.noteInput.value.trim(),
      thumb: await readFileAsDataUrl(els.thumbInput.files[0])
    }
  ];
  const violations = Occupancy.reelViolations({ segments: nextSegments }, state.spec);
  if (violations.length) {
    // 单卷事务拒绝，现有排序保持不变
    pushNotice(`片段未加入：超出每卷片段规格（${violations.join("；")}）。`, "error");
    return;
  }
  current.segments = nextSegments;
  els.segmentForm.reset();
  els.durationInput.value = 12;
  commit();
}

function removeSegment(reelId, segmentId) {
  const target = state.reels.find((item) => item.id === reelId);
  if (!target || !Occupancy.isOpen(target.status)) return;
  target.segments = target.segments.filter((item) => item.id !== segmentId);
  commit();
}

function moveSegment(reelId, segmentId, direction) {
  const target = state.reels.find((item) => item.id === reelId);
  if (!target || !Occupancy.isOpen(target.status)) return;
  const index = target.segments.findIndex((item) => item.id === segmentId);
  const to = index + direction;
  if (index < 0 || to < 0 || to >= target.segments.length) return;
  const [item] = target.segments.splice(index, 1);
  target.segments.splice(to, 0, item);
  commit();
}

function applySpec(event) {
  event.preventDefault();
  const nextSpec = {
    maxSegments: Number(els.specSegments.value),
    maxSegmentDuration: Number(els.specSegmentDuration.value),
    maxReelDuration: Number(els.specReelDuration.value)
  };
  if (Object.values(nextSpec).some((value) => !Number.isFinite(value) || value < 1)) {
    pushNotice("规格必须全部为不小于 1 的数字。", "error");
    hydrateSpecForm();
    return;
  }
  // 重算全部未结束卷：任一超限，整组退回
  const over = Occupancy.anyOpenViolation(state.reels, nextSpec);
  if (over) {
    pushNotice(`规格未应用（整组退回）：卷「${over.reel.title}」超限 — ${over.violations.join("；")}。`, "error");
    hydrateSpecForm();
    return;
  }
  state.spec = nextSpec;
  pushNotice("片段规格已更新，全部未结束卷重算通过。", "ok");
  commit();
}

/* ============================================================
 * 页面层：渲染与事件，仅消费上面两层
 * ============================================================ */

const els = {
  routeBoard: document.querySelector("#routeBoard"),
  boxBoard: document.querySelector("#boxBoard"),
  reelSelect: document.querySelector("#reelSelect"),
  colorFilter: document.querySelector("#colorFilter"),
  searchInput: document.querySelector("#searchInput"),
  exportBtn: document.querySelector("#exportBtn"),
  openForm: document.querySelector("#openForm"),
  openTitle: document.querySelector("#openTitle"),
  openRoute: document.querySelector("#openRoute"),
  boxQtyList: document.querySelector("#boxQtyList"),
  segmentForm: document.querySelector("#segmentForm"),
  codeInput: document.querySelector("#codeInput"),
  durationInput: document.querySelector("#durationInput"),
  shiftInput: document.querySelector("#shiftInput"),
  damageInput: document.querySelector("#damageInput"),
  thumbInput: document.querySelector("#thumbInput"),
  noteInput: document.querySelector("#noteInput"),
  noticeList: document.querySelector("#noticeList"),
  reelList: document.querySelector("#reelList"),
  segmentListTitle: document.querySelector("#segmentListTitle"),
  segmentListHint: document.querySelector("#segmentListHint"),
  segmentList: document.querySelector("#segmentList"),
  specForm: document.querySelector("#specForm"),
  specSegments: document.querySelector("#specSegments"),
  specSegmentDuration: document.querySelector("#specSegmentDuration"),
  specReelDuration: document.querySelector("#specReelDuration"),
  warningList: document.querySelector("#warningList"),
  activeCount: document.querySelector("#activeCount"),
  frozenCount: document.querySelector("#frozenCount"),
  segmentCount: document.querySelector("#segmentCount")
};

const notices = [];

function pushNotice(message, kind = "info") {
  notices.unshift({ id: crypto.randomUUID(), message, kind });
  if (notices.length > 5) notices.pop();
  renderNotices();
}

function renderNotices() {
  els.noticeList.innerHTML = notices
    .map(
      (item) => `
        <div class="notice ${item.kind}">
          <span>${escapeHtml(item.message)}</span>
          <button type="button" title="关闭" data-dismiss-notice="${item.id}">×</button>
        </div>`
    )
    .join("");
}

function renderBoards() {
  els.routeBoard.innerHTML = ROUTES.map((route) => {
    const used = Occupancy.routeUsage(state.reels, route.id);
    const full = used >= route.limit;
    return `
      <div class="resource-card ${full ? "full" : ""}">
        <strong>${escapeHtml(route.name)}</strong>
        <span class="meter">${used} / ${route.limit} 卷</span>
      </div>`;
  }).join("");

  const usage = Occupancy.boxUsage(state.reels);
  els.boxBoard.innerHTML = BOXES.map((box) => {
    const used = usage[box.id] || 0;
    const full = used >= box.stock;
    return `
      <div class="resource-card ${full ? "full" : ""}">
        <strong>${escapeHtml(box.name)}</strong>
        <span class="meter">${used} / ${box.stock} 盒</span>
      </div>`;
  }).join("");
}

function renderSelect() {
  const current = getCurrentReel();
  els.reelSelect.innerHTML = state.reels
    .map(
      (item) => `
        <option value="${item.id}" ${current && current.id === item.id ? "selected" : ""}>
          ${escapeHtml(item.title)}（${REEL_STATUS[item.status].label}）
        </option>`
    )
    .join("");
}

function renderStats() {
  els.activeCount.textContent = state.reels.filter((item) => item.status === "active").length;
  els.frozenCount.textContent = state.reels.filter((item) => item.status === "frozen").length;
  els.segmentCount.textContent = state.reels.reduce((sum, item) => sum + item.segments.length, 0);
}

function boxSummary(r) {
  return BOXES.filter((box) => (r.boxes[box.id] || 0) > 0)
    .map((box) => `${box.name} ×${r.boxes[box.id]}`)
    .join("、");
}

function renderReels() {
  els.reelList.innerHTML = state.reels
    .map((item, order) => {
      const meta = REEL_STATUS[item.status];
      const routeName = ROUTES.find((route) => route.id === item.routeId)?.name || "未分配线路";
      const total = item.segments.reduce((sum, segItem) => sum + Number(segItem.duration), 0);
      const isCurrent = getCurrentReel()?.id === item.id;
      const actions = [];
      if (item.status === "frozen") actions.push(`<button type="button" data-action="restore" data-reel="${item.id}">恢复</button>`);
      if (Occupancy.isOpen(item.status)) {
        actions.push(`<button type="button" data-action="stop" data-reel="${item.id}">停映</button>`);
        actions.push(`<button type="button" class="danger" data-action="cancel" data-reel="${item.id}">撤销</button>`);
      }
      if (actions.length === 0) {
        actions.push(`<button type="button" disabled>${meta.label}归档</button>`);
      }
      return `
        <article class="reel-card ${item.status} ${isCurrent ? "current" : ""}" data-reel-card="${item.id}">
          <div class="reel-head">
            <div>
              <strong>${order + 1}. ${escapeHtml(item.title)}</strong>
              <div class="tag-row">
                <span class="tag">${escapeHtml(routeName)}</span>
                <span class="tag ${meta.cls}">${meta.label}</span>
                <span class="tag">${item.segments.length} 段 · ${formatDuration(total)}</span>
              </div>
            </div>
            <div class="reel-actions">${actions.join("")}</div>
          </div>
          <p class="reel-boxes">登记片盒：${escapeHtml(boxSummary(item) || "无")}</p>
        </article>`;
    })
    .join("") || `<p class="empty">还没有登记任何胶片卷。</p>`;
}

function getFilteredSegments(reel) {
  const color = els.colorFilter.value;
  const keyword = els.searchInput.value.trim();
  return reel.segments.filter((item) => {
    const matchesColor = color === "all" || item.shift === color;
    const matchesKeyword = !keyword || `${item.code}${item.note}${item.damage}`.includes(keyword);
    return matchesColor && matchesKeyword;
  });
}

function renderSegments() {
  const current = getCurrentReel();
  if (!current) {
    els.segmentListTitle.textContent = "放映顺序";
    els.segmentListHint.textContent = "请先开卷";
    els.segmentList.innerHTML = `<p class="empty">还没有胶片卷，先在左侧开卷登记。</p>`;
    return;
  }
  const meta = REEL_STATUS[current.status];
  els.segmentListTitle.textContent = `放映顺序 · ${current.title}`;
  els.segmentListHint.textContent = Occupancy.isOpen(current.status)
    ? `${meta.label} · 拖拽片段调整顺序`
    : `${meta.label} · 顺序已锁定`;

  const segments = getFilteredSegments(current);
  const draggable = Occupancy.isOpen(current.status);
  els.segmentList.innerHTML =
    segments
      .map((item) => {
        const realIndex = current.segments.findIndex((segItem) => segItem.id === item.id);
        const hasDamage = item.damage !== "完好";
        return `
          <article class="segment-card" ${draggable ? `draggable="true" data-reel="${current.id}"` : ""} data-id="${item.id}">
            <div class="thumb">
              ${
                item.thumb
                  ? `<img src="${item.thumb}" alt="${escapeHtml(item.code)}缩略图" />`
                  : `<div class="film-placeholder" style="background:${fallbackThumbs[realIndex % fallbackThumbs.length]}">${escapeHtml(item.code)}</div>`
              }
            </div>
            <div class="segment-main">
              <div class="segment-title">
                <strong>${realIndex + 1}. ${escapeHtml(item.code)}</strong>
                <span>${formatDuration(item.duration)}</span>
              </div>
              <div class="tag-row">
                <span class="tag">${escapeHtml(item.shift)}</span>
                <span class="tag ${hasDamage ? "damage" : "ok"}">${escapeHtml(item.damage)}</span>
              </div>
              <p class="segment-note">${escapeHtml(item.note || "没有备注。")}</p>
            </div>
            <div class="segment-actions">
              <button type="button" title="上移" data-move-up="${item.id}" ${draggable ? "" : "disabled"}>↑</button>
              <button type="button" title="下移" data-move-down="${item.id}" ${draggable ? "" : "disabled"}>↓</button>
              <button type="button" title="删除" data-delete="${item.id}" ${draggable ? "" : "disabled"}>×</button>
            </div>
          </article>`;
      })
      .join("") || `<p class="empty">没有符合筛选的片段。</p>`;
}

function renderWarnings() {
  const items = [];
  for (const r of state.reels) {
    if (Occupancy.isOpen(r.status)) {
      const violations = Occupancy.reelViolations(r, state.spec);
      if (violations.length) {
        items.push({
          title: r.title,
          cls: "damage",
          text: `超出片段规格：${violations.join("；")}`
        });
      }
    }
    for (const segmentItem of r.segments) {
      if (segmentItem.damage !== "完好" || segmentItem.shift !== "正常") {
        const reasons = [
          segmentItem.shift !== "正常" ? segmentItem.shift : "",
          segmentItem.damage !== "完好" ? segmentItem.damage : ""
        ]
          .filter(Boolean)
          .join(" · ");
        items.push({
          title: `${r.title} / ${segmentItem.code}`,
          cls: "damage",
          text: `${reasons}${segmentItem.note ? `：${segmentItem.note}` : ""}`
        });
      }
    }
  }
  els.warningList.innerHTML =
    items
      .map(
        (item) => `
          <div class="warning-item">
            <strong>${escapeHtml(item.title)}</strong>
            <span>${escapeHtml(item.text)}</span>
          </div>`
      )
      .join("") || `<p class="empty">当前没有缺盒、超限或破损提醒。</p>`;
}

function hydrateSpecForm() {
  els.specSegments.value = state.spec.maxSegments;
  els.specSegmentDuration.value = state.spec.maxSegmentDuration;
  els.specReelDuration.value = state.spec.maxReelDuration;
}

function hydrateOpenForm() {
  els.openRoute.innerHTML = ROUTES.map(
    (route) => `<option value="${route.id}">${escapeHtml(route.name)}（上限 ${route.limit} 卷）</option>`
  ).join("");
  els.boxQtyList.innerHTML = BOXES.map(
    (box) => `
      <label class="qty-item">
        ${escapeHtml(box.name)}
        <input type="number" min="0" step="1" value="0" data-box="${box.id}" />
      </label>`
  ).join("");
}

function renderAll() {
  if (!currentReelId || !state.reels.some((item) => item.id === currentReelId)) {
    currentReelId = state.reels[0]?.id || null;
  }
  renderBoards();
  renderSelect();
  renderStats();
  renderReels();
  renderSegments();
  renderWarnings();
}

function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  const minutes = Math.floor(value / 60);
  const rest = String(value % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function exportSchedule() {
  const lines = [
    `放映线路编排台排期（导出时间 ${new Date().toLocaleString()}）`,
    `片段规格：每卷 ≤${state.spec.maxSegments} 段，单段 ≤${state.spec.maxSegmentDuration} 秒，每卷 ≤${state.spec.maxReelDuration} 秒`,
    "",
    ...state.reels.flatMap((r, order) => {
      const routeName = ROUTES.find((route) => route.id === r.routeId)?.name || "未分配线路";
      const total = r.segments.reduce((sum, item) => sum + Number(item.duration), 0);
      return [
        `${order + 1}. ${r.title}｜${routeName}｜${REEL_STATUS[r.status].label}｜${r.segments.length}段｜${formatDuration(total)}｜片盒：${boxSummary(r) || "无"}`,
        ...r.segments.map(
          (item, index) =>
            `   ${index + 1}. ${item.code}｜${formatDuration(item.duration)}｜${item.shift}｜${item.damage}｜${item.note || "无备注"}`
        ),
        ""
      ];
    })
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "projection-schedule.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ---- 页面事件：只做转发，不含占用/存档规则 ---- */

els.openForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.openAction === "freeze" ? "freeze" : "open";
  openReel(action === "freeze");
});

els.segmentForm.addEventListener("submit", addSegment);
els.specForm.addEventListener("submit", applySpec);
els.exportBtn.addEventListener("click", exportSchedule);
els.colorFilter.addEventListener("change", renderSegments);
els.searchInput.addEventListener("input", renderSegments);

els.reelSelect.addEventListener("change", () => {
  currentReelId = els.reelSelect.value;
  renderReels();
  renderSegments();
});

els.noticeList.addEventListener("click", (event) => {
  const dismiss = event.target.closest("[data-dismiss-notice]");
  if (!dismiss) return;
  const index = notices.findIndex((item) => item.id === dismiss.dataset.dismissNotice);
  if (index >= 0) {
    notices.splice(index, 1);
    renderNotices();
  }
});

els.reelList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-reel-card]");
  const button = event.target.closest("[data-action]");
  if (!card) return;
  const reelId = card.dataset.reelCard;
  if (button) {
    if (button.dataset.action === "restore") restoreReel(reelId);
    if (button.dataset.action === "stop") releaseReel(reelId, "stopped");
    if (button.dataset.action === "cancel") releaseReel(reelId, "cancelled");
    return;
  }
  currentReelId = reelId;
  renderReels();
  renderSegments();
  renderSelect();
});

els.segmentList.addEventListener("click", (event) => {
  const current = getCurrentReel();
  if (!current || !Occupancy.isOpen(current.status)) return;
  const up = event.target.closest("[data-move-up]");
  const down = event.target.closest("[data-move-down]");
  const remove = event.target.closest("[data-delete]");
  if (up) moveSegment(current.id, up.dataset.moveUp, -1);
  if (down) moveSegment(current.id, down.dataset.moveDown, 1);
  if (remove) removeSegment(current.id, remove.dataset.delete);
});

els.segmentList.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-id]");
  if (!card || !card.dataset.reel) return;
  draggedId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
});

els.segmentList.addEventListener("dragend", (event) => {
  event.target.closest("[data-id]")?.classList.remove("dragging");
  draggedId = null;
});

els.segmentList.addEventListener("dragover", (event) => {
  const card = event.target.closest("[data-id]");
  const current = getCurrentReel();
  if (!card || !draggedId || card.dataset.id === draggedId) return;
  if (!current || !Occupancy.isOpen(current.status)) return;
  event.preventDefault();
  const fromIndex = current.segments.findIndex((item) => item.id === draggedId);
  const toIndex = current.segments.findIndex((item) => item.id === card.dataset.id);
  if (fromIndex < 0 || toIndex < 0) return;
  const [item] = current.segments.splice(fromIndex, 1);
  current.segments.splice(toIndex, 0, item);
  commit();
});

hydrateOpenForm();
hydrateSpecForm();
renderAll();
