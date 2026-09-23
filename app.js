/* =========================================================================
 * 放映线路编排台
 * 三层分离：
 *   Store     —— 存档同步（localStorage 读写、迁移），不做业务判断
 *   Scheduler —— 占用判断 / 规格判定（纯函数），不碰存档与 DOM
 *   UI        —— 页面事件与渲染，调用前两层，不直接推导占用
 * 无新增依赖、无新增页面。
 * ========================================================================= */

const STORAGE_KEY = "zfl17-screening-route-desk";
const STORAGE_VERSION = 2;
const LEGACY_KEY = "zfl17-film-strip-desk";

/* ---------------- 预置数据：三条线路、五种片盒、每卷规格 ---------------- */

const PRESET_LINES = [
  { id: "L1", name: "一号主线厅", maxReels: 3 },
  { id: "L2", name: "二号艺术厅", maxReels: 2 },
  { id: "L3", name: "三号流动线", maxReels: 2 }
];

const PRESET_BOXES = [
  { id: "std", name: "标准片盒", stock: 4 },
  { id: "long", name: "加长大盒", stock: 2 },
  { id: "short", name: "短卷小盒", stock: 3 },
  { id: "trailer", name: "预告贴片盒", stock: 2 },
  { id: "spool", name: "备用空片夹", stock: 1 }
];

const DEFAULT_SPEC = { maxSegments: 12, maxDuration: 600 };

const STATUS = {
  ACTIVE: "active",
  FROZEN: "frozen",
  STOPPED: "stopped",
  CANCELED: "canceled"
};

const STATUS_LABEL = {
  active: "放映中",
  frozen: "缺盒冻结",
  stopped: "已停映",
  canceled: "已撤销"
};

const fallbackThumbs = ["#d49b35", "#347d89", "#b54d48", "#4d7656", "#6d6378"];

function buildDefaultReels() {
  return [
    {
      id: crypto.randomUUID(),
      title: "春日试映A卷",
      lineId: "L1",
      status: STATUS.ACTIVE,
      boxes: { std: 2, long: 1, short: 0, trailer: 0, spool: 0 },
      createdAt: Date.now(),
      finishedAt: null,
      segments: [
        {
          id: crypto.randomUUID(),
          code: "A-001",
          duration: 18,
          shift: "正常",
          damage: "完好",
          note: "开场街景，节奏平稳，适合保留原顺序。",
          thumb: ""
        },
        {
          id: crypto.randomUUID(),
          code: "A-006",
          duration: 9,
          shift: "偏红",
          damage: "轻微划痕",
          note: "人物近景左侧有划痕，试映时留意是否明显。",
          thumb: ""
        },
        {
          id: crypto.randomUUID(),
          code: "A-012",
          duration: 14,
          shift: "褪色",
          damage: "接片松动",
          note: "接片位置靠近段尾，放映前建议重新压平。",
          thumb: ""
        }
      ]
    }
  ];
}

function buildDefaultState() {
  return {
    version: STORAGE_VERSION,
    spec: { ...DEFAULT_SPEC },
    boxes: PRESET_BOXES.map((box) => ({ id: box.id, name: box.name, stock: box.stock })),
    reels: buildDefaultReels(),
    archive: [],
    selectedReelId: null
  };
}

/* ================================= Store ================================
 * 只负责存档同步：读取、版本迁移、写入。业务规则一律不在这里判断。
 * ======================================================================= */

const Store = {
  key: STORAGE_KEY,

  load() {
    const saved = localStorage.getItem(this.key);
    if (saved) {
      try {
        return this.migrate(JSON.parse(saved));
      } catch {
        /* 存档损坏时继续尝试旧档，否则回落默认 */
      }
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      try {
        return this.fromLegacy(JSON.parse(legacy));
      } catch {
        /* 旧档损坏则回落默认 */
      }
    }
    const next = buildDefaultState();
    next.selectedReelId = next.reels[0]?.id ?? null;
    return next;
  },

  save(state) {
    localStorage.setItem(this.key, JSON.stringify(state));
  },

  migrate(parsed) {
    const base = buildDefaultState();
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.reels)) {
      return { ...base, ...parsed, version: STORAGE_VERSION };
    }
    return {
      version: STORAGE_VERSION,
      spec: { ...DEFAULT_SPEC, ...(parsed.spec || {}) },
      boxes: base.boxes.map((box) => {
        const found = (parsed.boxes || []).find((item) => item.id === box.id);
        return found ? { ...box, ...found } : box;
      }),
      reels: parsed.reels,
      archive: Array.isArray(parsed.archive) ? parsed.archive : [],
      selectedReelId: parsed.selectedReelId ?? null
    };
  },

  /* 旧版「分镜条核对台」单卷数据迁移为 L1 上的一卷放映中数据 */
  fromLegacy(legacy) {
    const next = buildDefaultState();
    const reel = {
      id: crypto.randomUUID(),
      title: legacy.reelTitle || "迁移胶片卷",
      lineId: "L1",
      status: STATUS.ACTIVE,
      boxes: { std: 1, long: 0, short: 0, trailer: 0, spool: 0 },
      createdAt: Date.now(),
      finishedAt: null,
      segments: Array.isArray(legacy.segments) ? legacy.segments : []
    };
    next.reels = [reel];
    next.selectedReelId = reel.id;
    return next;
  }
};

/* =============================== Scheduler ==============================
 * 占用判断、线路件数、规格判定全部是纯函数：只接收 state，返回结果对象，
 * 由调用方决定是否写回。与存档、DOM、事件完全解耦。
 * ======================================================================= */

const Scheduler = {
  isUnfinished(reel) {
    return reel.status === STATUS.ACTIVE || reel.status === STATUS.FROZEN;
  },

  unfinishedReels(state) {
    return state.reels.filter((reel) => this.isUnfinished(reel));
  },

  /* 线路件数：放映中与缺盒冻结卷都占件位（已登记但未结束） */
  lineCount(state, lineId) {
    return this.unfinishedReels(state).filter((reel) => reel.lineId === lineId).length;
  },

  lineLimit(state, lineId) {
    return PRESET_LINES.find((line) => line.id === lineId)?.maxReels ?? 0;
  },

  /* 片盒占用：只有放映中卷实际持盒；冻结卷不持盒，仅保留需求 */
  boxHeld(state, boxId, excludeReelId = null) {
    return state.reels
      .filter((reel) => reel.status === STATUS.ACTIVE && reel.id !== excludeReelId)
      .reduce((sum, reel) => sum + (Number(reel.boxes?.[boxId]) || 0), 0);
  },

  boxStock(state, boxId) {
    return Number(state.boxes.find((box) => box.id === boxId)?.stock) || 0;
  },

  reelSegmentCount(reel) {
    return reel.segments.length;
  },

  reelDuration(reel) {
    return reel.segments.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
  },

  /* 单卷是否符合片段规格；返回 { ok, reasons[] } */
  checkSpec(reel, spec) {
    const reasons = [];
    if (reel.segments.length > spec.maxSegments) {
      reasons.push(`片段数 ${reel.segments.length} 超过单卷上限 ${spec.maxSegments}`);
    }
    const duration = this.reelDuration(reel);
    if (duration > spec.maxDuration) {
      reasons.push(`总时长 ${formatDuration(duration)} 超过上限 ${formatDuration(spec.maxDuration)}`);
    }
    return { ok: reasons.length === 0, reasons };
  },

  /* 开卷占用判断。
   * 返回：
   *   { accepted:false, freeze:false, reasons }  整卷拒绝（排序保持不变）
   *   { accepted:true,  freeze:false }           开卷成功，直接放映
   *   { accepted:true,  freeze:true,  reasons }  缺盒登记，冻结待恢复
   */
  evaluateOpen(state, draft) {
    const line = PRESET_LINES.find((item) => item.id === draft.lineId);
    if (!line) {
      return { accepted: false, freeze: false, reasons: ["未知线路。"] };
    }

    const hardReasons = [];
    const shortageReasons = [];

    if (this.lineCount(state, line.id) >= this.lineLimit(state, line.id)) {
      hardReasons.push(`线路「${line.name}」件数已达上限 ${line.maxReels} 卷`);
    }

    for (const box of PRESET_BOXES) {
      const need = Math.max(0, Number(draft.boxes?.[box.id]) || 0);
      if (need === 0) continue;
      const stock = this.boxStock(state, box.id);
      const held = this.boxHeld(state, box.id);
      const free = stock - held;
      if (need > stock) {
        shortageReasons.push(`「${box.name}」需求 ${need} 盒，总库存仅 ${stock} 盒（属缺盒，登记后冻结）`);
      } else if (need > free) {
        hardReasons.push(`「${box.name}」需求 ${need} 盒，被其他放映中卷占用后仅剩 ${free} 盒可用`);
      }
    }

    if (hardReasons.length) {
      return { accepted: false, freeze: false, reasons: [...hardReasons, ...shortageReasons] };
    }
    if (shortageReasons.length) {
      return { accepted: true, freeze: true, reasons: shortageReasons };
    }
    return { accepted: true, freeze: false, reasons: [] };
  },

  /* 缺盒冻结卷能否恢复：线路件位仍保留，只需核对片盒是否到位、未被占用 */
  evaluateRecover(state, reel) {
    const reasons = [];
    for (const box of PRESET_BOXES) {
      const need = Math.max(0, Number(reel.boxes?.[box.id]) || 0);
      if (need === 0) continue;
      const stock = this.boxStock(state, box.id);
      const held = this.boxHeld(state, box.id, reel.id);
      const free = stock - held;
      if (need > stock) {
        reasons.push(`「${box.name}」仍缺 ${need - stock} 盒（总库存 ${stock}）`);
      } else if (need > free) {
        reasons.push(`「${box.name}」到位盒被其他放映中卷占用，仅剩 ${free} 盒可用`);
      }
    }
    return { ok: reasons.length === 0, reasons };
  },

  /* 按登记顺序逐个尝试自动恢复，先尝试者不占后来者的盒（同一轮内顺序锁定） */
  autoRecover(state) {
    const recovered = [];
    for (const reel of [...state.reels].sort((a, b) => a.createdAt - b.createdAt)) {
      if (reel.status !== STATUS.FROZEN) continue;
      const verdict = this.evaluateRecover(state, reel);
      if (verdict.ok) {
        reel.status = STATUS.ACTIVE;
        recovered.push(reel);
      }
    }
    return recovered;
  },

  /* 新规格重算全部未结束卷；返回全部超限卷（空数组 = 可应用） */
  checkSpecAgainstState(state, spec) {
    return this.unfinishedReels(state)
      .map((reel) => ({ reel, ...this.checkSpec(reel, spec) }))
      .filter((result) => !result.ok);
  }
};

/* 通用工具 */
function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  const minutes = Math.floor(value / 60);
  const rest = String(value % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ================================= UI ====================================
 * 页面事件与渲染。所有状态变更统一走 commit()：先经 Scheduler 判断，
 * 再由 Store 存档同步，最后渲染。刷新后状态由 localStorage 保留。
 * ======================================================================= */

let state = Store.load();
let draggedId = null;
let noticeTimer = null;

const els = {
  statUnfinished: document.querySelector("#statUnfinished"),
  statFrozen: document.querySelector("#statFrozen"),
  statSegments: document.querySelector("#statSegments"),
  notice: document.querySelector("#notice"),
  lineCards: document.querySelector("#lineCards"),
  boxRows: document.querySelector("#boxRows"),
  specForm: document.querySelector("#specForm"),
  specMaxSegments: document.querySelector("#specMaxSegments"),
  specMaxDuration: document.querySelector("#specMaxDuration"),
  specHint: document.querySelector("#specHint"),
  openForm: document.querySelector("#openForm"),
  openTitle: document.querySelector("#openTitle"),
  openLine: document.querySelector("#openLine"),
  openBoxRows: document.querySelector("#openBoxRows"),
  reelBoard: document.querySelector("#reelBoard"),
  archiveList: document.querySelector("#archiveList"),
  reelTitle: document.querySelector("#reelTitle"),
  colorFilter: document.querySelector("#colorFilter"),
  searchInput: document.querySelector("#searchInput"),
  exportBtn: document.querySelector("#exportBtn"),
  segmentForm: document.querySelector("#segmentForm"),
  segmentFields: document.querySelector("#segmentFields"),
  codeInput: document.querySelector("#codeInput"),
  durationInput: document.querySelector("#durationInput"),
  shiftInput: document.querySelector("#shiftInput"),
  damageInput: document.querySelector("#damageInput"),
  thumbInput: document.querySelector("#thumbInput"),
  noteInput: document.querySelector("#noteInput"),
  segmentList: document.querySelector("#segmentList"),
  listSub: document.querySelector("#listSub"),
  warningList: document.querySelector("#warningList")
};

function getSelectedReel() {
  return (
    state.reels.find((reel) => reel.id === state.selectedReelId) ||
    state.archive.find((reel) => reel.id === state.selectedReelId) ||
    null
  );
}

/* 统一提交入口：业务变更 -> 存档同步 -> 重绘。autoRecover 在释放/补盒后运行 */
function commit({ recover = false, message = "", kind = "ok" } = {}) {
  let recovered = [];
  if (recover) recovered = Scheduler.autoRecover(state);
  if (recovered.length) {
    const names = recovered.map((reel) => `「${reel.title}」`).join("、");
    message = [message, `缺盒卷 ${names} 片盒到位，已恢复放映。`].filter(Boolean).join(" ");
  }
  Store.save(state);
  renderAll();
  if (message) showNotice(message, kind);
}

function showNotice(message, kind = "ok") {
  els.notice.textContent = message;
  els.notice.className = `notice ${kind}`;
  els.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    els.notice.hidden = true;
  }, 5200);
}

/* ------------------------------- 渲染层 -------------------------------- */

function renderStats() {
  els.statUnfinished.textContent = Scheduler.unfinishedReels(state).length;
  els.statFrozen.textContent = state.reels.filter((reel) => reel.status === STATUS.FROZEN).length;
  els.statSegments.textContent = Scheduler.unfinishedReels(state).reduce(
    (sum, reel) => sum + reel.segments.length,
    0
  );
}

function renderLineCards() {
  els.lineCards.innerHTML = PRESET_LINES.map((line) => {
    const used = Scheduler.lineCount(state, line.id);
    const full = used >= line.maxReels;
    return `
      <div class="line-card ${full ? "full" : ""}">
        <strong>${escapeHtml(line.name)}</strong>
        <span class="line-meta">${line.id}</span>
        <div class="line-count">
          <b>${used}</b> / ${line.maxReels} 卷
        </div>
        <div class="line-bar"><i style="width:${Math.min(100, (used / line.maxReels) * 100)}%"></i></div>
        <span class="line-state">${full ? "件数已满" : "可登记"}</span>
      </div>
    `;
  }).join("");
}

function renderBoxRows() {
  els.boxRows.innerHTML = state.boxes.map((box) => {
    const held = Scheduler.boxHeld(state, box.id);
    const free = box.stock - held;
    return `
      <label class="box-row">
        <span class="box-name">${escapeHtml(box.name)}</span>
        <input type="number" min="0" step="1" value="${box.stock}" data-box-stock="${box.id}" aria-label="${escapeHtml(box.name)}库存" />
        <span class="box-usage">占用 <b>${held}</b> · 可用 <b class="${free === 0 ? "zero" : ""}">${free}</b></span>
      </label>
    `;
  }).join("");
}

function renderOpenBoxRows() {
  els.openBoxRows.innerHTML = state.boxes.map((box) => {
    const held = Scheduler.boxHeld(state, box.id);
    const free = box.stock - held;
    return `
      <label class="open-box-row">
        <span>${escapeHtml(box.name)}</span>
        <small>库存 ${box.stock} · 可用 ${free}</small>
        <input type="number" min="0" step="1" value="0" data-open-box="${box.id}" aria-label="${escapeHtml(box.name)}需求量" />
      </label>
    `;
  }).join("");
}

function renderLineOptions() {
  const current = els.openLine.value;
  els.openLine.innerHTML = PRESET_LINES.map((line) => {
    const used = Scheduler.lineCount(state, line.id);
    return `
      <option value="${line.id}" ${used >= line.maxReels ? "disabled" : ""}>
        ${line.name}（${used}/${line.maxReels}）
      </option>
    `;
  }).join("");
  if (current && PRESET_LINES.some((line) => line.id === current)) els.openLine.value = current;
}

function renderSpecForm() {
  els.specMaxSegments.value = state.spec.maxSegments;
  els.specMaxDuration.value = state.spec.maxDuration;
  els.specHint.textContent = `当前：每卷最多 ${state.spec.maxSegments} 段、总时长 ${formatDuration(state.spec.maxDuration)}。`;
}

function renderBoard() {
  const grouped = PRESET_LINES.map((line) => ({
    line,
    reels: state.reels.filter((reel) => reel.lineId === line.id)
  }));

  els.reelBoard.innerHTML = grouped.map(({ line, reels }) => `
    <section class="reel-lane">
      <h3>
        ${escapeHtml(line.name)}
        <span>${Scheduler.lineCount(state, line.id)}/${line.maxReels}</span>
      </h3>
      <div class="reel-cards">
        ${reels.map((reel) => renderReelCard(reel)).join("") || `<p class="empty lane-empty">该线路暂无未结束卷。</p>`}
      </div>
    </section>
  `).join("");

  els.archiveList.innerHTML =
    state.archive
      .map((reel) => {
        const line = PRESET_LINES.find((item) => item.id === reel.lineId);
        const selected = reel.id === state.selectedReelId ? "selected" : "";
        return `
          <article class="archive-item ${selected}" data-select="${reel.id}">
            <div>
              <strong>${escapeHtml(reel.title || "未命名胶片卷")}</strong>
              <span class="pill ${reel.status}">${STATUS_LABEL[reel.status]}</span>
            </div>
            <small>${escapeHtml(line?.name || reel.lineId)} · 结束于 ${formatTime(reel.finishedAt)} · ${reel.segments.length} 段</small>
            <button type="button" class="mini danger" data-delete-archive="${reel.id}">删除存档</button>
          </article>
        `;
      })
      .join("") || `<p class="empty">暂无存档；停映或撤销的卷会释放片盒并进入此处。</p>`;
}

function renderReelCard(reel) {
  const selected = reel.id === state.selectedReelId ? "selected" : "";
  const duration = Scheduler.reelDuration(reel);
  const boxText = PRESET_BOXES
    .filter((box) => (Number(reel.boxes?.[box.id]) || 0) > 0)
    .map((box) => `${box.name}×${reel.boxes[box.id]}`)
    .join("、") || "无片盒";
  const spec = Scheduler.checkSpec(reel, state.spec);
  return `
    <article class="reel-card ${reel.status} ${selected}" data-select="${reel.id}">
      <div class="reel-card-head">
        <strong>${escapeHtml(reel.title || "未命名胶片卷")}</strong>
        <span class="pill ${reel.status}">${STATUS_LABEL[reel.status]}</span>
      </div>
      <small class="reel-time">登记 ${formatTime(reel.createdAt)}</small>
      <p class="reel-boxes">${escapeHtml(boxText)}</p>
      <p class="reel-meta">${reel.segments.length}/${state.spec.maxSegments} 段 · ${formatDuration(duration)}/${formatDuration(state.spec.maxDuration)}</p>
      ${spec.ok ? "" : `<p class="reel-violation">${escapeHtml(spec.reasons.join("；"))}</p>`}
      <div class="reel-ops">
        ${
          reel.status === STATUS.FROZEN
            ? `<button type="button" class="mini" data-recover="${reel.id}">恢复放映</button>`
            : ""
        }
        <button type="button" class="mini" data-stop="${reel.id}" ${reel.status === STATUS.FROZEN ? "disabled title='冻结卷请先恢复或撤销'" : ""}>停映释放</button>
        <button type="button" class="mini danger" data-cancel="${reel.id}">撤销释放</button>
      </div>
    </article>
  `;
}

function renderEditor() {
  const reel = getSelectedReel();
  if (!reel) {
    els.reelTitle.value = "";
    els.reelTitle.disabled = true;
    els.segmentFields.disabled = true;
    els.listSub.textContent = "请先开卷或在上方点选一卷";
    return;
  }
  const line = PRESET_LINES.find((item) => item.id === reel.lineId);
  const archived = state.archive.includes(reel);
  els.reelTitle.disabled = archived;
  els.reelTitle.value = reel.title;
  els.segmentFields.disabled = archived;
  els.listSub.textContent = archived
    ? `存档卷（${STATUS_LABEL[reel.status]} · ${line?.name}），只读`
    : `${line?.name} · ${STATUS_LABEL[reel.status]} · 拖拽片段调整顺序`;
}

function getFilteredSegments(reel) {
  if (!reel) return [];
  const color = els.colorFilter.value;
  const keyword = els.searchInput.value.trim();
  return reel.segments.filter((item) => {
    const matchesColor = color === "all" || item.shift === color;
    const matchesKeyword = !keyword || `${item.code}${item.note}${item.damage}`.includes(keyword);
    return matchesColor && matchesKeyword;
  });
}

function renderSegmentList() {
  const reel = getSelectedReel();
  if (!reel) {
    els.segmentList.innerHTML = `<p class="empty">请先开卷或在上方点选一卷。</p>`;
    return;
  }
  const segments = getFilteredSegments(reel);
  const archived = state.archive.includes(reel);
  els.segmentList.innerHTML =
    segments
      .map((item) => {
        const realIndex = reel.segments.findIndex((segment) => segment.id === item.id);
        const hasDamage = item.damage !== "完好";
        const draggable = archived ? "false" : "true";
        return `
          <article class="segment-card" draggable="${draggable}" data-id="${item.id}">
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
              <button type="button" title="上移" data-move-up="${item.id}" ${archived ? "disabled" : ""}>↑</button>
              <button type="button" title="下移" data-move-down="${item.id}" ${archived ? "disabled" : ""}>↓</button>
              <button type="button" title="删除" data-delete="${item.id}" ${archived ? "disabled" : ""}>×</button>
            </div>
          </article>
        `;
      })
      .join("") || `<p class="empty">${archived ? "存档卷中没有片段。" : "没有符合筛选的片段。"}</p>`;
}

function renderWarnings() {
  const reel = getSelectedReel();
  if (!reel) {
    els.warningList.innerHTML = `<p class="empty">点选一卷后查看核对提醒。</p>`;
    return;
  }
  const spec = Scheduler.checkSpec(reel, state.spec);
  const warnings = reel.segments.filter((item) => item.damage !== "完好" || item.shift !== "正常");
  const frozenHint =
    reel.status === STATUS.FROZEN
      ? `<div class="warning-item frozen"><strong>${escapeHtml(reel.title)} 缺盒冻结中</strong><span>片盒到位并可用后可恢复；冻结不占片盒，但占线路件位。</span></div>`
      : "";
  const specHintHtml = spec.ok
    ? ""
    : `<div class="warning-item spec"><strong>规格超限</strong><span>${escapeHtml(spec.reasons.join("；"))}</span></div>`;
  els.warningList.innerHTML =
    frozenHint +
    specHintHtml +
    warnings
      .map((item) => {
        const index = reel.segments.findIndex((segment) => segment.id === item.id) + 1;
        const reasons = [item.shift !== "正常" ? item.shift : "", item.damage !== "完好" ? item.damage : ""].filter(Boolean).join(" · ");
        return `
          <div class="warning-item">
            <strong>${index}. ${escapeHtml(item.code)}</strong>
            <span>${escapeHtml(reasons)}${item.note ? `：${escapeHtml(item.note)}` : ""}</span>
          </div>
        `;
      })
      .join("") ||
    (frozenHint || specHintHtml ? "" : `<p class="empty">当前清单没有颜色偏移或破损提醒。</p>`);
}

function renderAll() {
  renderStats();
  renderLineCards();
  renderBoxRows();
  renderOpenBoxRows();
  renderLineOptions();
  renderSpecForm();
  renderBoard();
  renderEditor();
  renderSegmentList();
  renderWarnings();
}

/* ------------------------------ 页面事件 -------------------------------- */

/* 片盒库存调整：不得低于当前放映中卷的占用；调整后尝试恢复缺盒卷 */
els.boxRows.addEventListener("change", (event) => {
  const input = event.target.closest("[data-box-stock]");
  if (!input) return;
  const boxId = input.dataset.boxStock;
  const box = state.boxes.find((item) => item.id === boxId);
  const value = Math.floor(Number(input.value));
  if (!box || !Number.isFinite(value) || value < 0) {
    renderBoxRows();
    return;
  }
  const held = Scheduler.boxHeld(state, boxId);
  if (value < held) {
    showNotice(`「${box.name}」库存不能低于当前放映中卷占用的 ${held} 盒，已还原。`, "error");
    renderBoxRows();
    return;
  }
  if (value === box.stock) return;
  box.stock = value;
  commit({
    recover: true,
    message: `「${box.name}」库存已改为 ${value} 盒。`
  });
});

/* 片段规格改动：重算全部未结束卷，任一超限则整组退回（规格不生效） */
els.specForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const nextSpec = {
    maxSegments: Math.floor(Number(els.specMaxSegments.value)),
    maxDuration: Math.floor(Number(els.specMaxDuration.value))
  };
  if (!Number.isFinite(nextSpec.maxSegments) || nextSpec.maxSegments < 1 ||
      !Number.isFinite(nextSpec.maxDuration) || nextSpec.maxDuration < 1) {
    showNotice("规格必须是不小于 1 的整数。", "error");
    renderSpecForm();
    return;
  }
  const violations = Scheduler.checkSpecAgainstState(state, nextSpec);
  if (violations.length) {
    const detail = violations
      .map(({ reel, reasons }) => `「${reel.title}」${reasons.join("、")}`)
      .join("；");
    showNotice(`整组退回：${violations.length} 卷超限，规格维持 ${state.spec.maxSegments} 段 / ${formatDuration(state.spec.maxDuration)}。${detail}`, "error");
    renderSpecForm();
    return;
  }
  state.spec = nextSpec;
  commit({ message: `规格已更新并重算，全部未结束卷符合新规格（${nextSpec.maxSegments} 段 / ${formatDuration(nextSpec.maxDuration)}）。` });
});

/* 开卷：选线路 + 登记片盒数量；占用/超限整卷拒绝，缺盒则登记冻结 */
els.openForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const boxes = {};
  els.openBoxRows.querySelectorAll("[data-open-box]").forEach((input) => {
    boxes[input.dataset.openBox] = Math.max(0, Math.floor(Number(input.value)) || 0);
  });
  const draft = {
    title: els.openTitle.value.trim(),
    lineId: els.openLine.value,
    boxes
  };
  const verdict = Scheduler.evaluateOpen(state, draft);
  if (!verdict.accepted) {
    showNotice(`整卷拒绝，现有排序保持不变：${verdict.reasons.join("；")}`, "error");
    return;
  }
  const reel = {
    id: crypto.randomUUID(),
    title: draft.title || "未命名胶片卷",
    lineId: draft.lineId,
    status: verdict.freeze ? STATUS.FROZEN : STATUS.ACTIVE,
    boxes,
    createdAt: Date.now(),
    finishedAt: null,
    segments: []
  };
  state.reels.push(reel);
  state.selectedReelId = reel.id;
  els.openForm.reset();
  if (verdict.freeze) {
    commit({ kind: "warn", message: `「${reel.title}」已登记但缺盒冻结：${verdict.reasons.join("；")}。片盒到位后可恢复。` });
  } else {
    commit({ message: `「${reel.title}」开卷成功，已占用登记片盒进入放映。` });
  }
  renderOpenBoxRows();
});

/* 线路编排区事件：点选 / 恢复 / 停映 / 撤销 / 删存档（事件委托统一维护） */
els.reelBoard.addEventListener("click", (event) => {
  const recoverBtn = event.target.closest("[data-recover]");
  const stopBtn = event.target.closest("[data-stop]");
  const cancelBtn = event.target.closest("[data-cancel]");
  const card = event.target.closest("[data-select]");

  if (recoverBtn) {
    const reel = state.reels.find((item) => item.id === recoverBtn.dataset.recover);
    if (!reel) return;
    const verdict = Scheduler.evaluateRecover(state, reel);
    if (!verdict.ok) {
      showNotice(`「${reel.title}」暂不能恢复：${verdict.reasons.join("；")}`, "error");
      return;
    }
    reel.status = STATUS.ACTIVE;
    commit({ message: `「${reel.title}」片盒已到位，恢复放映。` });
    return;
  }

  if (stopBtn) {
    finishReel(stopBtn.dataset.stop, STATUS.STOPPED, "停映");
    return;
  }
  if (cancelBtn) {
    finishReel(cancelBtn.dataset.cancel, STATUS.CANCELED, "撤销");
    return;
  }
  if (card) {
    state.selectedReelId = card.dataset.select;
    Store.save(state);
    renderBoard();
    renderEditor();
    renderSegmentList();
    renderWarnings();
  }
});

els.archiveList.addEventListener("click", (event) => {
  const del = event.target.closest("[data-delete-archive]");
  if (del) {
    state.archive = state.archive.filter((item) => item.id !== del.dataset.deleteArchive);
    if (state.selectedReelId === del.dataset.deleteArchive) state.selectedReelId = null;
    commit({ message: "存档记录已删除（资源此前已释放）。" });
    return;
  }
  const item = event.target.closest("[data-select]");
  if (item) {
    state.selectedReelId = item.dataset.select;
    Store.save(state);
    renderBoard();
    renderEditor();
    renderSegmentList();
    renderWarnings();
  }
});

/* 停映 / 撤销：释放片盒（移出未结束队列），进入存档，并尝试自动恢复缺盒卷 */
function finishReel(reelId, status, verb) {
  const index = state.reels.findIndex((item) => item.id === reelId);
  if (index < 0) return;
  const [reel] = state.reels.splice(index, 1);
  reel.status = status;
  reel.finishedAt = Date.now();
  state.archive.unshift(reel);
  if (state.selectedReelId === reel.id) state.selectedReelId = null;
  commit({
    recover: true,
    message: `「${reel.title}」已${verb}，占用片盒与线路件位已释放。`
  });
}

/* 当前卷题名（失焦/输入即同步，存档保留） */
els.reelTitle.addEventListener("input", () => {
  const reel = getSelectedReel();
  if (!reel || state.archive.includes(reel)) return;
  reel.title = els.reelTitle.value;
  Store.save(state);
  renderBoard();
  renderStats();
});

els.colorFilter.addEventListener("change", renderSegmentList);
els.searchInput.addEventListener("input", renderSegmentList);

/* 录入片段：未结束卷且符合规格才允许加入；超限直接拒绝，不改排序 */
els.segmentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const reel = getSelectedReel();
  if (!reel || state.archive.includes(reel)) return;
  const candidate = {
    id: crypto.randomUUID(),
    code: els.codeInput.value.trim(),
    duration: Number(els.durationInput.value),
    shift: els.shiftInput.value,
    damage: els.damageInput.value,
    note: els.noteInput.value.trim(),
    thumb: await readFileAsDataUrl(els.thumbInput.files[0])
  };
  reel.segments.push(candidate);
  const verdict = Scheduler.checkSpec(reel, state.spec);
  if (!verdict.ok) {
    reel.segments.pop();
    showNotice(`片段未加入：${verdict.reasons.join("；")}（当前排序不变）`, "error");
    return;
  }
  els.segmentForm.reset();
  els.durationInput.value = 12;
  commit();
});

els.segmentList.addEventListener("click", (event) => {
  const reel = getSelectedReel();
  if (!reel || state.archive.includes(reel)) return;
  const up = event.target.closest("[data-move-up]");
  const down = event.target.closest("[data-move-down]");
  const remove = event.target.closest("[data-delete]");
  if (up) moveSegment(reel, up.dataset.moveUp, -1);
  if (down) moveSegment(reel, down.dataset.moveDown, 1);
  if (remove) {
    reel.segments = reel.segments.filter((item) => item.id !== remove.dataset.delete);
    commit();
  }
});

function moveSegment(reel, id, direction) {
  const index = reel.segments.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= reel.segments.length) return;
  const [item] = reel.segments.splice(index, 1);
  reel.segments.splice(target, 0, item);
  commit();
}

els.segmentList.addEventListener("dragstart", (event) => {
  const reel = getSelectedReel();
  if (!reel || state.archive.includes(reel)) {
    event.preventDefault();
    return;
  }
  const card = event.target.closest("[data-id]");
  if (!card) return;
  draggedId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
});

els.segmentList.addEventListener("dragend", (event) => {
  event.target.closest("[data-id]")?.classList.remove("dragging");
  draggedId = null;
});

els.segmentList.addEventListener("dragover", (event) => {
  const reel = getSelectedReel();
  if (!reel || state.archive.includes(reel) || !draggedId) return;
  const card = event.target.closest("[data-id]");
  if (!card || card.dataset.id === draggedId) return;
  event.preventDefault();
  const fromIndex = reel.segments.findIndex((item) => item.id === draggedId);
  const toIndex = reel.segments.findIndex((item) => item.id === card.dataset.id);
  if (fromIndex < 0 || toIndex < 0) return;
  const [item] = reel.segments.splice(fromIndex, 1);
  reel.segments.splice(toIndex, 0, item);
  commit();
});

/* 导出排期：按线路汇总未结束卷，附存档；纯只读操作 */
els.exportBtn.addEventListener("click", () => {
  const lines = PRESET_LINES.map((line) => {
    const reels = state.reels.filter((reel) => reel.lineId === line.id);
    const head = `【${line.name}】 ${Scheduler.lineCount(state, line.id)}/${line.maxReels} 卷`;
    const body = reels.length
      ? reels.map((reel) => {
          const boxes = PRESET_BOXES.filter((box) => (Number(reel.boxes?.[box.id]) || 0) > 0)
            .map((box) => `${box.name}×${reel.boxes[box.id]}`).join("、") || "无片盒";
          const segs = reel.segments
            .map((item, index) => `   ${index + 1}. ${item.code}｜${formatDuration(item.duration)}｜${item.shift}｜${item.damage}`)
            .join("\n");
          return ` - ${reel.title}［${STATUS_LABEL[reel.status]}］盒：${boxes}｜${reel.segments.length}段｜${formatDuration(Scheduler.reelDuration(reel))}\n${segs || "   （暂无片段）"}`;
        }).join("\n")
      : " （暂无未结束卷）";
    return `${head}\n${body}`;
  });
  const archived = state.archive.length
    ? state.archive.map((reel) => ` - ${reel.title}［${STATUS_LABEL[reel.status]}］${formatTime(reel.finishedAt)}`).join("\n")
    : " 无";
  const blob = new Blob(
    [`放映线路排期 导出 ${formatTime(Date.now())}\n规格：每卷≤${state.spec.maxSegments}段、≤${formatDuration(state.spec.maxDuration)}\n\n${lines.join("\n\n")}\n\n【存档】\n${archived}\n`],
    { type: "text/plain;charset=utf-8" }
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "screening-schedule.txt";
  link.click();
  URL.revokeObjectURL(link.href);
});

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

renderAll();
