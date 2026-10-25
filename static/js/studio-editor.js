/* One workspace for every Studio production. */
(async () => {
  "use strict";
  const S = StudioScene,
    $ = (id) => document.getElementById(id),
    boot = window.studioBoot;
  let d = S.clone(boot.record.document),
    revision = boot.record.revision,
    name = boot.record.name,
    selected = new Set(),
    scene,
    busy = false,
    zoom = 1,
    fitted = true,
    editing = true,
    time = 0,
    playing = null,
    space = false,
    drag = null,
    imageMode = "add",
    previewFrame = "",
    generationDraft = null,
    generationEntries = [],
    generationLoading = false,
    generationReady = false,
    generationTicket = 0,
    generationFocus = "",
    initialSetup = false,
    backgroundEditing = false;
  const variable = () => S.type(d) === "graphic" && !!d.dataset;
  let recipientID = "",
    recipientValues = {},
    pendingRecipients = null;
  const recipientCache = new Map();
  const includedRecipients = () =>
    (d.dataset?.rows || []).filter(
      (r) => !(d.dataset.excluded || []).includes(r.id),
    );
  const recipientSource = (r) => d.dataset?.overrides?.[r.id] || r.source;
  function recipientNumber(id) {
    const rows = includedRecipients(),
      i = rows.findIndex((r) => r.id === id);
    return i < 0
      ? "—"
      : String(i + 1).padStart(Math.max(2, String(rows.length).length), "0");
  }
  function rowWarning(row) {
    if (row.issue?.startsWith("Artwork:")) return row.issue;
    const key = row.name.trim().toLocaleLowerCase();
    return includedRecipients().filter(
      (r) => r.name.trim().toLocaleLowerCase() === key,
    ).length > 1
      ? "Same name appears more than once. Deselect any duplicate person."
      : row.identityIssue
        ? ""
        : row.issue || "";
  }
  function recipientError(id = "") {
    if (!d.dataset) return "Review variable data before exporting.";
    const rows = includedRecipients().filter((r) => !id || r.id === id);
    if (!rows.length) return "Select at least one recipient.";
    for (const r of rows) {
      if (
        nodes().some((n) => n.binding?.row === "artwork") &&
        (!recipientSource(r) ||
          (r.issue?.startsWith("Artwork:") && !d.dataset.overrides?.[r.id]))
      )
        return r.name + " needs artwork.";
    }
    return "";
  }
  async function dataPreview() {
    if (!variable()) return {};
    const rows = d.dataset?.rows || [];
    if (!rows.some((r) => r.id === recipientID))
      recipientID = rows[0]?.id || "";
    const row = rows.find((r) => r.id === recipientID);
    if (!row) return {};
    const source = recipientSource(row);
    const key =
      source +
      "#" +
      (d.dataset.overrides?.[row.id] ? "override" : row.hash || "");
    let value = recipientCache.get(key);
    if (source && nodes().some((n) => n.binding?.row === "artwork") && !value) {
      try {
        value = await (
          await request("recipient-preview", {
            document: d,
            recipientId: recipientID,
          })
        ).json();
        if (recipientCache.size >= 3) recipientCache.clear();
        recipientCache.set(key, value);
      } catch (e) {
        error(e);
        value = {};
      }
    }
    recipientValues = {
      ...value,
      number: recipientNumber(recipientID),
      values: { name: row.name, ...row.values },
    };
    return recipientValues;
  }
  function recipientPanel() {
    const entering = $("canvas-toolbar").hidden && variable();
    $("canvas-toolbar").hidden = !variable();
    $("data-view-toggle").hidden = !variable();
    if (!variable()) {
      showData(false);
      return;
    }
    if (entering) {
      showData(true);
    }
    const rows = d.dataset?.rows || [],
      included = includedRecipients();
    $("recipient-summary").textContent =
      included.length + " included · " + rows.length + " rows";
    $("recipient-status").textContent = recipientError() || "Ready to export.";
    $("recipient-select").replaceChildren(
      ...rows.map((r) => {
        const o = document.createElement("option");
        o.value = r.id;
        o.textContent = recipientNumber(r.id) + " · " + r.name;
        return o;
      }),
    );
    $("recipient-select").value = recipientID;
    $("recipient-list").replaceChildren(
      ...rows.map((r) => {
        const line = document.createElement("div");
        line.className = "recipient-row";
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = !(d.dataset.excluded || []).includes(r.id);
        check.setAttribute("aria-label", "Include " + r.name);
        check.disabled = busy;
        check.onchange = () =>
          run(async () => {
            const ids = new Set(d.dataset.excluded || []);
            check.checked ? ids.delete(r.id) : ids.add(r.id);
            d.dataset.excluded = [...ids];
            await scene.setRecipient(await dataPreview());
            render();
            recipientPanel();
            commit();
          });
        const pick = document.createElement("button");
        pick.className = "recipient-pick";
        pick.setAttribute("aria-pressed", r.id === recipientID);
        pick.disabled = busy;
        const source = recipientSource(r);
        if (source) {
          const img = document.createElement("img");
          img.src = source;
          img.alt = "";
          img.loading = "lazy";
          pick.append(img);
        }
        const name = document.createElement("span");
        name.textContent =
          recipientNumber(r.id) + " · " + r.name + (rowWarning(r) ? " ⚠" : "");
        pick.append(name);
        pick.onclick = () => chooseRecipient(r.id);
        line.append(check, pick);
        return line;
      }),
    );
    const row = rows.find((r) => r.id === recipientID);
    $("recipient-detail").hidden = !row;
    if (row) {
      const notes = [];
      const warning = rowWarning(row);
      if (warning)
        notes.push(
          warning.startsWith("Artwork:") && d.dataset.overrides?.[row.id]
            ? "Event artwork unavailable; using your replacement."
            : warning,
        );
      if (d.dataset.overrides?.[row.id])
        notes.push("Artwork override for this recipient.");
      const w = recipientValues.width || row.width,
        h = recipientValues.height || row.height,
        n = nodes().find((n) => n.binding?.row === "artwork");
      if (w && h && n) {
        const inches = S.unitFactor(d.page.unit) / 96;
        let scale = n.scale,
          p = parent(n.id);
        while (p) {
          scale *= p.scale;
          p = parent(p.id);
        }
        const ppi = Math.max(
          w / (n.width * scale * inches),
          h / (n.height * scale * inches),
        );
        notes.push(
          Math.round(ppi) +
            " ppi at print size" +
            (ppi < 150 ? " — low resolution" : ""),
        );
      }
      $("recipient-issue").textContent = notes.join("\n");
      $("recipient-reset").hidden = !d.dataset.overrides?.[row.id];
      $("recipient-replace").hidden = !nodes().some(
        (n) => n.binding?.row === "artwork",
      );
    }
  }
  async function chooseRecipient(id) {
    await run(async () => {
      recipientID = id;
      await scene.setRecipient(await dataPreview());
      render();
      recipientPanel();
    });
  }
  async function refreshRecipients() {
    if (d.dataset?.source === "csv") {
      $("document-setup").click();
      return;
    }
    const current = await (
      await request("recipient-data", {
        source: d.dataset?.source || "event_gifts",
      })
    ).json();
    reviewData(current);
  }
  function reviewData(current) {
    if (
      d.dataset?.fingerprint === current.fingerprint &&
      d.dataset.source === current.source &&
      (!d.dataset.columns ||
        JSON.stringify([
          d.dataset.columns,
          d.dataset.nameColumn,
          d.dataset.imageColumn,
        ]) ===
          JSON.stringify([
            current.columns,
            current.nameColumn,
            current.imageColumn,
          ]))
    ) {
      recipientPanel();
      return;
    }
    pendingRecipients = current;
    const old = new Map((d.dataset?.rows || []).map((r) => [r.id, r]));
    const changes = [];
    for (const row of current.rows) {
      const prev = old.get(row.id);
      changes.push(
        (!prev
          ? "Added: "
          : JSON.stringify(prev) !== JSON.stringify(row)
            ? "Changed: "
            : "Unchanged: ") + row.name,
      );
      old.delete(row.id);
    }
    for (const row of old.values()) changes.push("Removed: " + row.name);
    $("recipient-changes").replaceChildren(
      ...changes.map((t) => {
        const p = document.createElement("p");
        p.textContent = t;
        return p;
      }),
    );
    if (!changes.length)
      $("recipient-changes").textContent = "No eligible event recipients yet.";
    $("recipient-dialog").showModal();
  }
  $("recipient-refresh").onclick = () => run(refreshRecipients);
  $("recipient-review-cancel").onclick = () => $("recipient-dialog").close();
  $("recipient-review-apply").onclick = () =>
    run(async () => {
      const prior = d.dataset || {},
        ids = new Set(pendingRecipients.rows.map((r) => r.id));
      d.dataset = {
        ...pendingRecipients,
        excluded: (prior.excluded || []).filter((id) => ids.has(id)),
        overrides: Object.fromEntries(
          Object.entries(prior.overrides || {}).filter(([id]) => ids.has(id)),
        ),
      };
      S.walk(d.nodes, (n) => {
        if (
          n.binding?.row === "artwork" &&
          d.dataset.source === "csv" &&
          !d.dataset.imageColumn
        ) {
          if (recipientValues.source)
            d.assets[n.asset] = recipientValues.source;
          delete n.binding.row;
        }
        if (
          n.binding?.row === "field" &&
          !dataFields().includes(n.binding.column)
        ) {
          n.text = S.textValue(n, recipientValues);
          delete n.binding.row;
          delete n.binding.column;
        }
      });
      pendingRecipients = null;
      showData(true);
      $("recipient-dialog").close();
      await scene.setRecipient(await dataPreview());
      render();
      recipientPanel();
      commit();
    });
  $("recipient-select").onchange = () =>
    chooseRecipient($("recipient-select").value);
  for (const [id, step] of [
    ["recipient-prev", -1],
    ["recipient-next", 1],
  ])
    $(id).onclick = () => {
      const rows = d.dataset?.rows || [],
        i = rows.findIndex((r) => r.id === recipientID);
      if (rows.length)
        chooseRecipient(rows[(i + step + rows.length) % rows.length].id);
    };
  $("recipient-replace").onclick = () => {
    const n = nodes().find((n) => n.binding?.row === "artwork");
    if (n) {
      select(n.id);
      $("replace-image").click();
    }
  };
  $("recipient-reset").onclick = () =>
    run(async () => {
      delete d.dataset.overrides[recipientID];
      await scene.setRecipient(await dataPreview());
      render();
      recipientPanel();
      commit();
    });
  function showData(show) {
    show = !!show && variable();
    $("recipients-drawer").hidden = !show;
    $("studio-workspace").classList.toggle("with-recipients", show);
    for (const id of ["recipients-toggle", "data-view-toggle"])
      $(id).setAttribute("aria-expanded", show);
    $("data-view-toggle").querySelector("[data-check]").textContent = show
      ? "✓"
      : "";
    if (show) {
      $("layers-drawer").hidden = true;
      $("studio-workspace").classList.remove("with-layers");
      $("layers-toggle").setAttribute("aria-expanded", false);
      $("layers-toggle").querySelector("[data-check]").textContent = "";
    }
  }
  $("recipients-toggle").onclick = () => {
    showData($("recipients-drawer").hidden);
    if (fitted) fit();
  };

  const snapshot = () => ({ name, document: S.clone(d) });
  let saved = JSON.stringify(snapshot()),
    hist = S.history(snapshot());
  const dirty = () => JSON.stringify(snapshot()) !== saved,
    nodes = () => S.all(d),
    get = (id) => nodes().find((n) => n.id === id);
  const parent = (id) => {
      let result = null;
      S.walk(d.nodes, (n, p) => {
        if (n.id === id) result = p;
      });
      return result;
    },
    siblings = (id) => parent(id)?.children || d.nodes;
  const roots = () =>
    [...selected]
      .map(get)
      .filter(Boolean)
      .filter((n) => {
        let p = parent(n.id);
        while (p) {
          if (selected.has(p.id)) return false;
          p = parent(p.id);
        }
        return true;
      });
  const editable = (n) => {
    while (n) {
      if (n.locked) return false;
      n = parent(n.id);
    }
    return true;
  };
  const chosen = () => [...selected].map(get).filter(Boolean),
    single = () => (chosen().length === 1 ? chosen()[0] : null);
  function animationNode() {
    let n = single();
    while (n && !n.animation) n = parent(n.id);
    return n;
  }
  const error = (e) => {
    $("studio-error").hidden = !e;
    $("studio-error").textContent = e?.message || e || "";
  };
  async function request(action = "", body = {}) {
    const response = await fetch(
      location.pathname + (action ? "/" + action : ""),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, ...body }),
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw Error(
        response.headers.get("Content-Type")?.includes("text/html")
          ? `Request failed (${response.status}). Please try again.`
          : message,
      );
    }
    return response;
  }
  function state() {
    document
      .querySelectorAll(
        "#studio-editor input, #studio-editor textarea, #studio-editor select, #studio-editor button",
      )
      .forEach((el) => (el.disabled = busy));
    $("save-status").textContent = busy
      ? "Working…"
      : dirty()
        ? "Unsaved changes"
        : "Saved";
    $("save").disabled = busy;
    $("export-menu-toggle").disabled =
      busy || !!scene?.missing.length || !!d.needsArrange;
    $("batch-export-divider").hidden = !variable();
    document.querySelectorAll("[data-export]").forEach((button) => {
      const kind = S.type(d),
        format = button.dataset.export;
      if (format === "pdf")
        button.textContent = variable() ? "Selected row PDF…" : "PDF…";
      if (format === "png")
        button.textContent = variable() ? "Selected row PNG…" : "PNG…";
      if (format === "zip") button.textContent = "Batch PDFs ZIP…";
      button.hidden = variable()
        ? !["pdf", "png", "zip", "reference"].includes(format)
        : kind === "video"
          ? format !== "mp4"
          : ["mp4", "zip", "reference"].includes(format);
      button.disabled =
        $("export-menu-toggle").disabled ||
        (variable() &&
          (format === "zip" || format === "reference"
            ? !!recipientError()
            : recipientNumber(recipientID) === "—" ||
              !!recipientError(recipientID)));
    });
    $("undo").disabled = busy || !hist.canUndo;
    $("redo").disabled = busy || !hist.canRedo;
    $("artwork-warning").textContent = scene?.missing.length
      ? "Artwork needs attention: " + scene.missing.join(", ")
      : "";
    const crowded = S.layoutWarnings(d);
    $("layout-warning").hidden = !crowded.length;
    $("layout-warning").textContent = crowded.length
      ? "Crowded tiers: " +
        crowded.join(", ") +
        ". All sponsors are included; consider smaller spacing or adjust individual logos."
      : "";
    const ns = roots(),
      unlocked = ns.length && ns.every(editable);
    document.querySelectorAll("[data-command]").forEach((el) => {
      const command = el.dataset.command;
      el.disabled =
        busy ||
        !unlocked ||
        (command === "group" &&
          (ns.length < 2 ||
            ns.some((n) => parent(n.id) !== parent(ns[0].id)))) ||
        (command === "ungroup" && !ns.some((n) => n.kind === "group"));
    });
    $("align-command").disabled = busy || !unlocked;
    for (const id of ["object-opacity", "object-rotation"]) {
      $(id).disabled = busy || !unlocked;
    }
    $("generate-apply").disabled =
      busy || generationLoading || !generationReady;

    $("generate-options")
      .querySelectorAll("input")
      .forEach((el) => {
        el.disabled = busy || generationLoading;
      });
    document.querySelectorAll("[data-activate]").forEach((el) => {
      el.disabled = $(el.dataset.activate).disabled;
    });
  }
  function commit() {
    hist.push(snapshot());
    state();
  }
  async function run(fn) {
    if (busy) return;
    busy = true;
    state();
    error("");
    try {
      await fn();
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      state();
    }
  }
  function fit() {
    const vp = $("artboard-viewport"),
      w = d.page.width + 2 * d.page.bleed,
      h = d.page.height + 2 * d.page.bleed;
    zoom = Math.min((vp.clientWidth - 48) / w, (vp.clientHeight - 48) / h);
    fitted = true;
    size();
    vp.scrollTop = vp.scrollLeft = 0;
  }
  function size() {
    const w = d.page.width + 2 * d.page.bleed,
      h = d.page.height + 2 * d.page.bleed;
    $("artboard").style.width = w * zoom + "px";
    $("artboard").style.height = h * zoom + "px";
    $("zoom-value").textContent =
      Math.round((zoom / S.unitFactor(d.page.unit)) * 100) + "%";
    selectionBox();
  }
  function bounds(ns = roots()) {
    const boxes = ns.map((n) => scene.box(n.id)).filter(Boolean);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x)),
      y = Math.min(...boxes.map((b) => b.y));
    return {
      x,
      y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    };
  }
  function selectionBox() {
    const svg = $("selection-overlay");
    svg.replaceChildren();
    if (!scene || !editing) return;
    for (const n of chosen()) {
      const b = scene.box(n.id);
      if (b && !n.hidden)
        svg.append(
          S.element("rect", {
            ...b,
            fill: "none",
            stroke: "#cf7820",
            "stroke-width": 1.5,
          }),
        );
    }
    const b = bounds();
    if (b && roots().every(editable)) {
      const r = 8 / zoom;
      svg.append(
        S.element("rect", {
          x: b.x + b.width - r / 2,
          y: b.y + b.height - r / 2,
          width: r,
          height: r,
          fill: "#fff",
          stroke: "#b76a1f",
          "stroke-width": 1.5,
          "data-resize": "true",
        }),
      );
    }
  }
  function select(id, add = false) {
    if (id && !editing) layoutMode();
    if (add) {
      selected.has(id) ? selected.delete(id) : selected.add(id);
    } else selected = new Set(id ? [id] : []);
    inspector();
    layers();
    selectionBox();
    timeline();
    state();
  }
  function layers() {
    const list = $("layers-list");
    list.replaceChildren();
    function row(n, depth) {
      const line = document.createElement("div");
      line.className = "layer-row";
      line.style.setProperty("--indent", depth * 10 + "px");
      const label = document.createElement("button");
      label.className = "layer-label";
      label.textContent = (n.kind === "group" ? "▱ " : "") + n.name;
      label.title = n.name;
      label.setAttribute("aria-pressed", selected.has(n.id));
      label.onclick = (e) => select(n.id, e.shiftKey);
      line.append(label);
      for (const [key, on, off] of [
        ["hidden", "Show", "Hide"],
        ["locked", "Unlock", "Lock"],
      ]) {
        const b = document.createElement("button");
        b.className = "layer-toggle";
        const action = (n[key] ? on : off) + " " + n.name;
        b.title = action;
        b.setAttribute("aria-label", action);
        const icon = S.element("svg", {
          viewBox: "0 0 20 20",
          width: 15,
          height: 15,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": 1.5,
          "aria-hidden": "true",
        });
        if (key === "hidden") {
          icon.append(
            S.element("path", { d: "M2 10Q10 0 18 10Q10 20 2 10Z" }),
            S.element("circle", { cx: 10, cy: 10, r: 2.5 }),
          );
          if (n.hidden) icon.append(S.element("path", { d: "M3 3L17 17" }));
        } else {
          icon.append(
            S.element("rect", { x: 5, y: 9, width: 10, height: 8, rx: 1 }),
            S.element("path", {
              d: n.locked ? "M7 9V6a3 3 0 0 1 6 0v3" : "M7 9V6a3 3 0 0 1 6 0",
            }),
          );
        }
        b.append(icon);
        b.onclick = () => {
          if (busy) return;
          n[key] = !n[key];
          render();
          commit();
        };
        line.append(b);
      }
      list.append(line);
      for (const c of n.children || []) row(c, depth + 1);
    }
    [...d.nodes].reverse().forEach((n) => row(n, 0));
  }
  function dimension(n) {
    return Number(n.toFixed(d.page.unit === "in" ? 3 : 1));
  }
  function dataFields(dataset = d.dataset) {
    return dataset?.columns?.length
      ? dataset.columns
      : [
          ...new Set([
            "name",
            ...(dataset?.rows || []).flatMap((row) =>
              Object.keys(row.values || {}),
            ),
          ]),
        ].sort();
  }
  function bindingOptions(n) {
    const label = $("data-binding-label"),
      select = $("data-binding");
    label.hidden = !variable() || !n || !["text", "image"].includes(n.kind);
    if (label.hidden) return;
    const options = [["", "None (shared content)"]];
    if (n.kind === "text")
      options.push(
        ["number", "Batch number"],
        ...dataFields()
          .filter((c) => c !== d.dataset.imageColumn)
          .map((c) => ["field:" + c, c]),
      );
    else if (d.dataset.source !== "csv" || d.dataset.imageColumn)
      options.push(["artwork", d.dataset.imageColumn || "Recipient artwork"]);
    select.replaceChildren(
      ...options.map(([value, text]) => {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        return o;
      }),
    );
    select.value =
      n.binding?.row === "field"
        ? "field:" + n.binding.column
        : n.binding?.row || "";
  }
  $("data-binding").onchange = () =>
    run(async () => {
      const n = single();
      if (!n || !editable(n)) return;
      const value = $("data-binding").value;
      if (n.kind === "text") n.text = S.textValue(n, recipientValues);
      if (!value && n.binding?.row === "artwork" && recipientValues.source)
        d.assets[n.asset] = recipientValues.source;
      if (n.binding) {
        delete n.binding.row;
        delete n.binding.column;
      }
      if (value) {
        n.binding ||= {};
        n.binding.row = value.startsWith("field:") ? "field" : value;
        if (n.binding.row === "field") n.binding.column = value.slice(6);
        if (n.binding.row === "artwork") {
          const key = "row-" + n.id;
          d.assets[key] = d.assets[n.asset];
          n.asset = key;
        }
      }
      await mount();
      commit();
    });
  function inspector() {
    const ns = chosen(),
      n = single(),
      a = animationNode();
    if (backgroundEditing && (ns.length || !d.background.asset)) {
      backgroundEditing = false;
      viewport.classList.remove("background-editing");
    }
    $("selection-name").textContent = n
      ? n.name
      : ns.length
        ? `${ns.length} objects`
        : "Nothing selected";
    bindingOptions(n);
    const box = bounds();
    $("selection-help").textContent = box
      ? `${dimension(box.width)} × ${dimension(box.height)} ${d.page.unit} · drag to move`
      : "Select an object to edit it.";
    $("selection-properties").hidden = !ns.length;
    $("shadow-properties").hidden = !n || !["text", "image"].includes(n.kind);
    $("shadow-enabled").checked = !!n?.shadow;
    $("shadow-controls").hidden = !n?.shadow;
    if (n?.shadow) {
      for (const key of ["x", "y", "blur", "color", "opacity"])
        $("shadow-" + key).value = n.shadow[key];
      $("shadow-units").textContent = "Distances in " + d.page.unit + ".";
      $("shadow-blur").max = 50 / S.unitFactor(d.page.unit);
      for (const key of ["x", "y"]) {
        $("shadow-" + key).min = -200 / S.unitFactor(d.page.unit);
        $("shadow-" + key).max = 200 / S.unitFactor(d.page.unit);
      }
    }
    $("text-properties").hidden = n?.kind !== "text";
    $("image-properties").hidden = n?.kind !== "image";
    $("title-sponsor-property").hidden =
      n?.binding?.field !== "titleSponsor" || !boot.titleChoices?.length;
    $("title-sponsor").replaceChildren(
      ...(boot.titleChoices || []).map((choice) => {
        const option = document.createElement("option");
        option.value = choice.sponsor;
        option.textContent = choice.name;
        option.selected = choice.sponsor === n?.binding?.sponsor;
        return option;
      }),
    );
    $("timing-properties").hidden = !a;
    $("add-timing").hidden = S.type(d) !== "video" || !n || !!a;
    if (!n && ns.length) {
      $("object-rotation").value = "";
      $("object-opacity").value = ns[0].opacity;
    }
    if (n) {
      $("object-opacity").value = n.opacity;
      $("object-rotation").value = n.rotation;
      if (n.kind === "text") {
        $("text-content").value = S.textValue(n, recipientValues);
        $("text-content").readOnly = !!n.binding?.row;
        $("text-align").value = n.textAlign || "left";
        $("text-font").value = n.font;
        $("text-color").value = n.color;
      }
      if (n.kind === "image") {
        $("image-greyscale").value = n.greyscale;
        $("image-brightness").value = n.brightness;
      }
    }
    if (a)
      for (const key of ["start", "end", "fade", "rise"])
        $("timing-" + key).value = Number(a.animation[key].toFixed(3));
    $("inspector-heading").textContent = ns.length ? "Properties" : "Document";
    $("document-properties").hidden = !!ns.length;
    $("selection-name").hidden = !ns.length;
    $("selection-help").hidden = !ns.length;
    $("background-zoom").value = d.background.zoom || 1;
    $("background-zoom-value").textContent =
      Math.round((d.background.zoom || 1) * 100) + "%";
    $("adjust-background").hidden = !d.background.asset || backgroundEditing;
    $("background-edit-controls").hidden = !backgroundEditing;
    $("remove-background").hidden = !d.background.asset;
    $("background-color").value =
      d.background.color === "transparent" ? "#111917" : d.background.color;
    $("background-transparent").checked = d.background.color === "transparent";
    $("background-darkness").value = d.background.darkness;
  }
  function render(updateInspector = true) {
    scene.build();
    scene.render(editing ? null : time);
    selectionBox();
    layers();
    timeline();
    if (updateInspector) inspector();
    recipientPanel();
    state();
  }
  async function mount() {
    scene = S.mount($("scene-host"), d, {}, await dataPreview());
    await scene.ready();
    $("selection-overlay").setAttribute(
      "viewBox",
      scene.svg.getAttribute("viewBox"),
    );
    $("video-controls").hidden = S.type(d) !== "video";
    $("timeline-toggle").hidden = S.type(d) !== "video";
    $("overlay-preview-settings").hidden = d.template !== "overlay";

    $("page-size").textContent =
      `${dimension(d.page.width)} × ${dimension(d.page.height)} ${d.page.unit}`;
    $("design-name").value = name;
    $("scrub").max = d.duration;
    render();
    recipientPanel();
    if (fitted) fit();
    else size();
    backdrop();
  }
  async function restore(value) {
    if (!value) return;
    pause();
    zoom *= S.unitFactor(value.document.page.unit) / S.unitFactor(d.page.unit);
    d = value.document;
    name = value.name;
    selected = new Set([...selected].filter((id) => get(id)));
    await mount();
  }
  function mutate(fn) {
    if (busy) return;
    error("");
    try {
      fn();
      render();
      commit();
    } catch (e) {
      error(e);
    }
  }
  function ancestorMatrix(n) {
    const p = parent(n.id);
    return p
      ? scene.svg.getCTM().inverse().multiply(scene.node(p.id).getCTM())
      : new DOMMatrix();
  }
  function worldOrigin(n) {
    return new DOMPoint(n.x, n.y).matrixTransform(ancestorMatrix(n));
  }
  function moveWorld(n, dx, dy) {
    const inv = ancestorMatrix(n).inverse(),
      a = new DOMPoint(0, 0).matrixTransform(inv),
      b = new DOMPoint(dx, dy).matrixTransform(inv);
    n.x += b.x - a.x;
    n.y += b.y - a.y;
  }
  function position(e) {
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(
      scene.svg.getScreenCTM().inverse(),
    );
  }
  function pause() {
    if (playing) cancelAnimationFrame(playing);
    playing = null;
    $("play").textContent = "Play";
  }
  function layoutMode() {
    pause();
    editing = true;
    scene.render(null);
    selectionBox();
  }
  function seek(t) {
    time = Math.max(0, Math.min(d.duration, t));
    $("scrub").value = time;
    $("time").textContent = `${time.toFixed(2)} / ${d.duration.toFixed(2)} s`;
    $("timeline").style.setProperty(
      "--playhead",
      (time / d.duration) * 100 + "%",
    );
    if (!editing) scene.render(time);
  }
  function timeline() {
    const root = $("timeline");
    if (S.type(d) !== "video") return;
    root.replaceChildren();
    for (const n of nodes().filter((n) => n.animation)) {
      const a = n.animation,
        row = document.createElement("div");
      row.className = "timeline-row";
      const label = document.createElement("button");
      label.className = "timeline-label";
      label.textContent = n.name;
      label.title = n.name;
      label.onclick = () => {
        layoutMode();
        select(n.id);
      };
      const lane = document.createElement("div");
      lane.className = "timeline-lane";
      const bar = document.createElement("button");
      bar.className = "timeline-bar";
      bar.setAttribute("aria-pressed", selected.has(n.id));
      bar.setAttribute(
        "aria-label",
        `${n.name}, ${a.start.toFixed(2)} to ${a.end.toFixed(2)} seconds`,
      );
      bar.style.left = (a.start / d.duration) * 100 + "%";
      bar.style.width = ((a.end - a.start) / d.duration) * 100 + "%";
      bar.append(
        document.createTextNode(`${a.start.toFixed(1)}–${a.end.toFixed(1)}`),
      );
      for (const key of ["start", "end"]) {
        const h = document.createElement("span");
        h.className = "timeline-handle " + key;
        h.dataset.edge = key;
        bar.append(h);
      }
      lane.append(bar);
      row.append(label, lane);
      root.append(row);
      bar.onpointerdown = (e) => {
        if (busy || !editable(n) || e.button !== 0) return;
        e.preventDefault();
        pause();
        const initial = S.clone(a),
          x = e.clientX,
          width = lane.getBoundingClientRect().width,
          edge = e.target.dataset.edge;
        selected = new Set([n.id]);
        inspector();
        selectionBox();
        bar.setAttribute("aria-pressed", "true");
        bar.setPointerCapture(e.pointerId);
        bar.onpointermove = (e) => {
          const dt =
            Math.round(((e.clientX - x) / width) * d.duration * 30) / 30;
          if (edge === "start")
            a.start = Math.max(
              0,
              Math.min(initial.end - 2 * initial.fade, initial.start + dt),
            );
          else if (edge === "end")
            a.end = Math.min(
              d.duration,
              Math.max(initial.start + 2 * initial.fade, initial.end + dt),
            );
          else {
            const delta = Math.max(
              -initial.start,
              Math.min(d.duration - initial.end, dt),
            );
            a.start = initial.start + delta;
            a.end = initial.end + delta;
          }
          bar.style.left = (a.start / d.duration) * 100 + "%";
          bar.style.width = ((a.end - a.start) / d.duration) * 100 + "%";
          bar.firstChild.textContent = `${a.start.toFixed(1)}–${a.end.toFixed(1)}`;
          inspector();
          scene.render(editing ? null : time);
        };
        const end = (cancel) => {
          bar.onpointermove = null;
          bar.onpointerup = null;
          bar.onpointercancel = null;
          if (cancel) Object.assign(a, initial);
          else {
            inspector();
            commit();
          }
          timeline();
          inspector();
        };
        bar.onpointerup = () => end(false);
        bar.onpointercancel = () => end(true);
      };
      bar.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          layoutMode();
          select(n.id);
        }
      };
    }
    seek(time);
  }
  const viewport = $("artboard-viewport");
  viewport.onpointerdown = (e) => {
    if (busy || (e.button !== 0 && e.button !== 1)) return;
    if (space || e.button === 1) {
      e.preventDefault();
      drag = {
        pan: true,
        x: e.clientX,
        y: e.clientY,
        left: viewport.scrollLeft,
        top: viewport.scrollTop,
      };
      viewport.classList.add("panning");
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (backgroundEditing) {
      e.preventDefault();
      drag = {
        background: true,
        point: position(e),
        original: S.clone(d.background),
      };
      viewport.setPointerCapture(e.pointerId);
      return;
    }
    if (!editing) {
      layoutMode();
      return;
    }
    const resize = e.target.hasAttribute("data-resize"),
      hit = e.target.closest("[data-node]")?.dataset.node;
    if (!resize) {
      if (!hit) {
        select(null);
        return;
      }
      if (e.shiftKey) {
        select(hit, true);
        return;
      }
      if (!selected.has(hit)) select(hit);
    }
    const ns = roots();
    if (!ns.length || !ns.every(editable)) return;
    e.preventDefault();
    const box = bounds(),
      point = position(e);
    drag = {
      resize,
      point,
      box,
      items: ns.map((n) => ({
        id: n.id,
        original: S.clone(n),
        origin: worldOrigin(n),
        inverse: ancestorMatrix(n).inverse(),
      })),
    };
    viewport.setPointerCapture(e.pointerId);
  };
  viewport.onpointermove = (e) => {
    if (!drag) return;
    if (drag.pan) {
      viewport.scrollLeft = drag.left - (e.clientX - drag.x);
      viewport.scrollTop = drag.top - (e.clientY - drag.y);
      return;
    }
    if (drag.background) {
      const p = position(e);
      d.background.x = (drag.original.x || 0) + p.x - drag.point.x;
      d.background.y = (drag.original.y || 0) + p.y - drag.point.y;
      clampBackground();
      scene.build();
      return;
    }
    const p = position(e),
      dx = p.x - drag.point.x,
      dy = p.y - drag.point.y,
      b = drag.box,
      f = Math.max(
        0.02,
        Math.min(
          20,
          1 +
            (dx * b.width + dy * b.height) /
              (b.width * b.width + b.height * b.height),
        ),
      );
    for (const { id, original: o, origin, inverse } of drag.items) {
      const n = get(id);
      Object.assign(n, S.clone(o));
      let target;
      if (drag.resize) {
        target = new DOMPoint(
          b.x + (origin.x - b.x) * f,
          b.y + (origin.y - b.y) * f,
        );
        if (n.kind === "text") n.fontSize = o.fontSize * f;
        else if (n.kind === "image") {
          n.width = o.width * f;
          n.height = o.height * f;
        } else n.scale = o.scale * f;
      } else target = new DOMPoint(origin.x + dx, origin.y + dy);
      const local = target.matrixTransform(inverse);
      n.x = local.x;
      n.y = local.y;
    }
    scene.build();
    selectionBox();
    state();
  };
  function finish(cancel) {
    if (!drag) return;
    if (drag.background) {
      if (cancel) d.background = drag.original;
      drag = null;
      render();
      if (!cancel) commit();
      return;
    }
    if (drag.items && cancel)
      for (const { id, original } of drag.items)
        Object.assign(get(id), original);
    const changed = !!drag.items;
    drag = null;
    viewport.classList.remove("panning");
    if (changed) {
      render();
      if (!cancel) commit();
    }
  }
  viewport.onpointerup = () => finish(false);
  viewport.onpointercancel = () => finish(true);
  viewport.onlostpointercapture = () => finish(true);
  function removeNodes(ns) {
    for (const n of ns) {
      const list = siblings(n.id),
        i = list.indexOf(n);
      if (i >= 0) list.splice(i, 1);
    }
  }
  function command(key) {
    mutate(() => {
      const ns = roots().filter(editable);
      if (!ns.length) return;
      if (key === "remove") {
        removeNodes(ns);
        selected.clear();
        if (scene.missing.length)
          queueMicrotask(() =>
            run(async () => {
              await scene.ready();
              render();
            }),
          );
      }
      if (key === "duplicate") {
        const ids = [];
        for (const n of ns) {
          const copy = S.clone(n);
          S.walk([copy], (v) => {
            v.id = "n" + crypto.randomUUID();
            delete v.binding;
          });
          copy.x += 20 / S.unitFactor(d.page.unit);
          copy.y += 20 / S.unitFactor(d.page.unit);
          siblings(n.id).push(copy);
          ids.push(copy.id);
        }
        selected = new Set(ids);
      }
      if (key === "group") {
        if (ns.length < 2) return;
        const p = parent(ns[0].id);
        if (ns.some((n) => parent(n.id) !== p))
          throw Error(
            "Select objects in the same group to group them together.",
          );
        const g = S.item("group", "Group");
        g.children = ns;
        const list = siblings(ns[0].id),
          index = Math.max(...ns.map((n) => list.indexOf(n)));
        removeNodes(ns);
        list.splice(Math.min(index, list.length), 0, g);
        selected = new Set([g.id]);
      }
      if (key === "ungroup") {
        const ids = [];
        for (const n of ns.filter((n) => n.kind === "group")) {
          const list = siblings(n.id),
            index = list.indexOf(n),
            angle = (n.rotation * Math.PI) / 180,
            cos = Math.cos(angle),
            sin = Math.sin(angle);
          for (const child of n.children) {
            const x = child.x * n.scale,
              y = child.y * n.scale;
            child.x = n.x + x * cos - y * sin;
            child.y = n.y + x * sin + y * cos;
            child.scale *= n.scale;
            child.rotation += n.rotation;
            child.opacity *= n.opacity;
            child.hidden ||= n.hidden;
            child.locked ||= n.locked;
            if (n.animation && !child.animation)
              child.animation = S.clone(n.animation);
            ids.push(child.id);
          }
          list.splice(index, 1, ...n.children);
        }
        selected = new Set(ids);
      }
      if (key === "forward" || key === "backward") {
        for (const n of ns) {
          const list = siblings(n.id),
            i = list.indexOf(n),
            j = Math.max(
              0,
              Math.min(list.length - 1, i + (key === "forward" ? 1 : -1)),
            );
          [list[i], list[j]] = [list[j], list[i]];
        }
      }
    });
  }
  for (const b of document.querySelectorAll("[data-command]"))
    b.onclick = () => command(b.dataset.command);
  $("align-command").onchange = () => {
    const key = $("align-command").value;
    $("align-command").value = "";
    if (!key) return;
    mutate(() => {
      const ns = roots().filter(editable),
        box = bounds(ns);
      if (!box) return;
      const boxes = ns.map((n) => ({ n, b: scene.box(n.id) }));
      if (key.startsWith("space")) {
        if (ns.length < 3) return;
        const horizontal = key === "space-x",
          axis = horizontal ? "x" : "y",
          size = horizontal ? "width" : "height";
        boxes.sort((a, b) => a.b[axis] - b.b[axis]);
        const start = boxes[0].b[axis],
          end = boxes.at(-1).b[axis] + boxes.at(-1).b[size],
          gap =
            (end - start - boxes.reduce((s, x) => s + x.b[size], 0)) /
            (boxes.length - 1);
        let cursor = start;
        for (const { n, b } of boxes) {
          moveWorld(
            n,
            horizontal ? cursor - b[axis] : 0,
            horizontal ? 0 : cursor - b[axis],
          );
          cursor += b[size] + gap;
        }
        return;
      }
      const target =
        ns.length === 1
          ? { x: 0, y: 0, width: d.page.width, height: d.page.height }
          : box;
      for (const { n, b } of boxes) {
        let dx = 0,
          dy = 0;
        if (key === "left") dx = target.x - b.x;
        if (key === "right") dx = target.x + target.width - b.x - b.width;
        if (key === "center")
          dx = target.x + target.width / 2 - b.x - b.width / 2;
        if (key === "top") dy = target.y - b.y;
        if (key === "bottom") dy = target.y + target.height - b.y - b.height;
        if (key === "middle")
          dy = target.y + target.height / 2 - b.y - b.height / 2;
        moveWorld(n, dx, dy);
      }
    });
  };
  $("shadow-enabled").onchange = () =>
    mutate(() => {
      const n = single();
      if (!n || !editable(n) || !["text", "image"].includes(n.kind)) return;
      if ($("shadow-enabled").checked) {
        const f = S.unitFactor(d.page.unit);
        n.shadow = {
          x: 2 / f,
          y: 2 / f,
          blur: 3 / f,
          color: "#000000",
          opacity: 0.35,
        };
      } else delete n.shadow;
    });
  for (const key of ["x", "y", "blur", "color", "opacity"]) {
    const input = $("shadow-" + key);
    input.oninput = () => {
      const n = single();
      if (busy || !n?.shadow || !editable(n)) return;
      const value = key === "color" ? input.value : Number(input.value);
      if (key !== "color" && (!Number.isFinite(value) || !input.validity.valid))
        return;
      n.shadow[key] = value;
      render(false);
    };
    input.onchange = input.onblur = () => {
      inspector();
      commit();
    };
  }
  const properties = {
    "text-content": ["text", false],
    "text-font": ["font", false],
    "text-align": ["textAlign", false],
    "text-color": ["color", false],
    "image-greyscale": ["greyscale", true],
    "image-brightness": ["brightness", true],
    "object-opacity": ["opacity", true],
    "object-rotation": ["rotation", true],
  };
  for (const [id, [key, numeric]] of Object.entries(properties)) {
    const input = $(id);
    input.oninput = () => {
      if (busy) return;
      for (const n of chosen().filter(editable)) {
        if (n.binding?.row && key === "text") continue;
        const v = numeric ? Number(input.value) : input.value;
        if (numeric && !Number.isFinite(v)) return;
        n[key] = v;
      }
      render(false);
    };
    input.onchange = () => {
      if (id === "text-font")
        run(async () => {
          await scene.ready();
          render();
          commit();
        });
      else {
        inspector();
        commit();
      }
    };
  }
  for (const key of ["start", "end", "fade", "rise"]) {
    const input = $("timing-" + key);
    input.onchange = () =>
      mutate(() => {
        const n = animationNode();
        if (!n || !editable(n)) return;
        const a = n.animation,
          v = Number(input.value);
        if (!Number.isFinite(v)) return;
        if (key === "start")
          a.start = Math.max(0, Math.min(a.end - 2 * a.fade, v));
        if (key === "end")
          a.end = Math.min(d.duration, Math.max(a.start + 2 * a.fade, v));
        if (key === "fade")
          a.fade = Math.max(0, Math.min(3, (a.end - a.start) / 2, v));
        if (key === "rise") a.rise = Math.max(0, Math.min(300, v));
      });
  }
  $("add-timing").onclick = () =>
    mutate(() => {
      const n = single();
      if (n && editable(n))
        n.animation = {
          start: 1,
          end: d.duration - 1,
          fade: Math.min(0.45, (d.duration - 2) / 2),
          rise: 60,
        };
    });
  $("background-color").oninput = () => {
    if (busy) return;
    d.kind = S.type(d);
    d.background.color = $("background-color").value;
    render(false);
  };
  $("background-color").onchange = commit;
  $("background-transparent").onchange = () =>
    mutate(() => {
      d.kind = S.type(d);
      d.background.color = $("background-transparent").checked
        ? "transparent"
        : $("background-color").value;
    });
  $("background-darkness").oninput = () => {
    if (busy) return;
    d.kind = S.type(d);
    d.background.darkness = Number($("background-darkness").value);
    render(false);
  };
  $("background-darkness").onchange = commit;
  $("title-sponsor").onchange = () =>
    run(async () => {
      const n = single(),
        choice = boot.titleChoices.find(
          (c) => c.sponsor === $("title-sponsor").value,
        );
      if (!n || !choice) return;
      const id = "a" + crypto.randomUUID();
      d.assets[id] = choice.source;
      n.asset = id;
      n.name = choice.name;
      n.binding.sponsor = choice.sponsor;
      await scene.ready();
      render();
      commit();
    });
  function clampBackground() {
    const b = d.page.bleed,
      box = scene.backgroundBox();
    d.background.x = box.x + b - (d.page.width + 2 * b - box.width) / 2;
    d.background.y = box.y + b - (d.page.height + 2 * b - box.height) / 2;
  }
  function endBackground() {
    backgroundEditing = false;
    viewport.classList.remove("background-editing");
    inspector();
  }
  $("adjust-background").onclick = () => {
    layoutMode();
    select(null);
    backgroundEditing = true;
    viewport.classList.add("background-editing");
    inspector();
  };
  $("background-done").onclick = endBackground;
  $("background-zoom").oninput = () => {
    if (busy) return;
    d.background.zoom = Number($("background-zoom").value);
    $("background-zoom-value").textContent =
      Math.round(d.background.zoom * 100) + "%";
    clampBackground();
    scene.build();
    state();
  };
  $("background-zoom").onchange = commit;
  $("remove-background").onclick = () =>
    mutate(() => {
      d.background.asset = "";
      d.background.x = 0;
      d.background.y = 0;
      d.background.zoom = 1;
      endBackground();
      d.background.bound = false;
    });
  async function imageFile(file) {
    if (
      !file ||
      file.size > 10 * 1024 * 1024 ||
      !["image/svg+xml", "image/png", "image/jpeg"].includes(file.type)
    )
      throw Error("Choose an SVG, PNG or JPEG up to 10 MB.");
    const source = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(Error("Unable to read image"));
      r.readAsDataURL(file);
    });
    const bytes = new TextEncoder().encode(source),
      digest = await crypto.subtle.digest("SHA-256", bytes),
      id =
        "a" +
        Array.from(new Uint8Array(digest), (v) =>
          v.toString(16).padStart(2, "0"),
        ).join("");
    return { id, source };
  }
  $("add-text").onclick = () =>
    run(async () => {
      const n = S.item("text", "Text");
      n.x = d.page.width * 0.35;
      n.y = d.page.height * 0.4;
      n.fontSize = Math.min(
        (d.template === "banner" ? 96 : 64) / S.unitFactor(d.page.unit),
        d.page.width / 8,
      );
      d.nodes.push(n);
      selected = new Set([n.id]);
      await scene.ready();
      render();
      commit();
    });
  $("add-image").onclick = () => {
    imageMode = "add";
    $("image-file").click();
  };
  $("replace-image").onclick = () => {
    imageMode = single()?.id;
    $("image-file").click();
  };
  $("image-file").onchange = () =>
    run(async () => {
      try {
        const file = $("image-file").files[0];
        if (!file) return;
        const asset = await imageFile(file);
        let n =
          imageMode === "add" ? S.item("image", file.name) : get(imageMode);
        if (!n || !editable(n)) return;
        if (n.binding?.row === "artwork") {
          if (!d.dataset || !recipientID)
            throw Error("Review and select a recipient first.");
          d.dataset.overrides ||= {};
          d.dataset.overrides[recipientID] = asset.source;
          await scene.setRecipient(await dataPreview());
          render();
          recipientPanel();
          commit();
          return;
        }
        d.assets[asset.id] = asset.source;
        n.asset = asset.id;
        if (imageMode === "add") {
          n.x = d.page.width * 0.35;
          n.y = d.page.height * 0.4;
          n.width = d.page.width * 0.25;
          n.height = n.width / 3;
          d.nodes.push(n);
        }
        await scene.ready();
        n.height = n.width / scene.ratio(n);
        selected = new Set([n.id]);
        render();
        commit();
      } finally {
        $("image-file").value = "";
      }
    });
  $("replace-background").onclick = () => $("background-file").click();
  $("background-file").onchange = () =>
    run(async () => {
      try {
        const file = $("background-file").files[0];
        if (!file) return;
        const a = await imageFile(file);
        d.assets[a.id] = a.source;
        d.kind = S.type(d);
        d.background.asset = a.id;
        d.background.x = 0;
        d.background.y = 0;
        d.background.zoom = 1;
        d.background.bound = false;
        await scene.ready();
        render();
        commit();
      } finally {
        $("background-file").value = "";
      }
    });
  function backdrop() {
    const el = $("artboard"),
      mode = $("preview-background").value;
    el.style.background =
      mode === "dark"
        ? "#171717"
        : mode === "light"
          ? "#fff"
          : mode === "frame" && previewFrame
            ? `center / cover url("${previewFrame}")`
            : "";
  }
  $("preview-background").onchange = backdrop;
  $("preview-frame").onclick = () => $("frame-file").click();
  $("frame-file").onchange = () =>
    run(async () => {
      const file = $("frame-file").files[0];
      if (file) {
        previewFrame = (await imageFile(file)).source;
        $("preview-background").value = "frame";
        backdrop();
      }
      $("frame-file").value = "";
    });
  async function prepareLayout(next, resolve = true) {
    if (resolve) {
      const result = await (
        await request("prepare-layout", { document: next })
      ).json();
      next.assets = result.assets;
      if (next.artworkBounds)
        for (const id of Object.keys(next.artworkBounds))
          if (!next.assets[id]) delete next.artworkBounds[id];
    }
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-20000px;top:0";
    document.body.append(host);
    try {
      const prepared = S.mount(host, next);
      await prepared.ready();
      if (prepared.missing.length) throw Error(prepared.missing.join(", "));
      prepared.measureArtwork();
      S.arrange(next, (n) => prepared.ratio(n));
      prepared.build();
      prepared.render(null);
      return prepared.svg;
    } finally {
      host.remove();
    }
  }
  const sponsorLogo = (n) =>
    n.kind === "image" &&
    (n.binding?.sponsor || n.binding?.field === "sponsor");
  function generationCatalog() {
    generationEntries = [];
    for (const g of S.all(generationDraft).filter(
      (n) => n.kind === "group" && n.binding?.tier,
    )) {
      const entries = S.all({ nodes: g.children || [] })
        .filter(sponsorLogo)
        .map((n) => ({ id: n.id }));
      generationEntries.push({
        id: g.id,
        name: g.name,
        tier: g.binding.tier,
        entries,
      });
    }
  }
  function generationNode(id) {
    return S.all(generationDraft).find((n) => n.id === id);
  }
  function included(entry, group) {
    const node = generationNode(entry.id);
    if (!node || node.hidden || generationNode(group.id)?.hidden) return false;
    const parents = new Map();
    S.walk(generationDraft.nodes, (n, p) => parents.set(n.id, p));
    for (let p = parents.get(entry.id); p; p = parents.get(p.id))
      if (p.hidden) return false;
    return true;
  }
  function setIncluded(entry, group, checked) {
    let node = generationNode(entry.id),
      owner = generationNode(group.id);
    if (!node || !owner) return;
    if (checked) {
      if (
        owner.hidden &&
        !owner.animation &&
        generationDraft.template === "reel"
      ) {
        const regular = S.all(generationDraft).find(
          (n) => n.binding?.tier === "regular" && n.animation,
        );
        owner.animation = regular
          ? S.clone(regular.animation)
          : {
              start: 1,
              end: generationDraft.duration - 1,
              fade: 0.45,
              rise: 60,
            };
      }
      const parents = new Map();
      S.walk(generationDraft.nodes, (n, p) => parents.set(n.id, p));
      let p = parents.get(node.id);
      while (p) {
        if (p.hidden) {
          S.walk(p.children || [], (n) => {
            if (sponsorLogo(n)) n.hidden = true;
          });
          p.hidden = false;
        }
        p = parents.get(p.id);
      }
    }
    node.hidden = !checked;
    if (
      generationDraft.template === "overlay" &&
      owner.binding?.tier === "title"
    )
      owner.hidden = !checked;
  }
  function generationOptions() {
    const list = $("generate-options"),
      scroll = list.scrollTop;
    list.replaceChildren();
    for (const group of generationEntries) {
      if (!group.entries.length) continue;
      const fieldset = document.createElement("fieldset"),
        legend = document.createElement("legend");
      const label = document.createElement("label"),
        toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.id = "generation-tier-" + group.id;
      const count = group.entries.filter((e) => included(e, group)).length;
      toggle.checked = count === group.entries.length;
      toggle.indeterminate = count > 0 && count < group.entries.length;
      label.append(toggle, document.createTextNode(group.name));
      legend.append(label);
      fieldset.append(legend);
      toggle.onchange = () => {
        generationFocus = toggle.id;
        group.entries.forEach((entry) =>
          setIncluded(entry, group, toggle.checked),
        );
        generationOptions();
        updateGeneration();
      };
      for (const entry of group.entries) {
        const row = document.createElement("label"),
          input = document.createElement("input");
        row.className = "generation-logo";
        input.type = "checkbox";
        input.id = "generation-logo-" + entry.id;
        input.checked = included(entry, group);
        const node = generationNode(entry.id);
        row.append(input, document.createTextNode(node.name));
        input.onchange = () => {
          generationFocus = input.id;
          setIncluded(entry, group, input.checked);
          generationOptions();
          updateGeneration();
        };
        fieldset.append(row);
      }
      list.append(fieldset);
    }
    $("generate-options").parentElement.hidden = !generationEntries.some(
      (g) => g.entries.length,
    );
    list.scrollTop = scroll;
  }
  async function updateGeneration(resolve = false) {
    const ticket = ++generationTicket;
    generationLoading = true;
    generationReady = false;
    $("generate-status").textContent = "Preparing preview…";
    state();
    const next = S.clone(generationDraft);
    try {
      const remote = Object.values(next.assets).some(
        (source) => !source.startsWith("data:"),
      );
      const svg = await prepareLayout(next, resolve || remote);
      if (ticket !== generationTicket) return;
      generationDraft = next;
      if (resolve) generationCatalog();
      $("generate-preview").replaceChildren(svg);
      const warnings = S.layoutWarnings(next);
      const count = generationEntries.reduce(
        (sum, group) =>
          sum + group.entries.filter((e) => included(e, group)).length,
        0,
      );
      $("generate-status").textContent =
        next.template === "canvas"
          ? "Shared canvas layout. Recipient artwork and numbers are supplied by the reviewed data."
          : `${count} sponsor${count === 1 ? "" : "s"} selected.` +
            (warnings.length
              ? " Crowded tiers: " + warnings.join(", ") + "."
              : "");
      generationReady = true;
      generationOptions();
    } catch (e) {
      if (ticket === generationTicket)
        $("generate-status").textContent = e.message || String(e);
    } finally {
      if (ticket === generationTicket) {
        generationLoading = false;
        state();
        if (generationFocus) $(generationFocus)?.focus({ preventScroll: true });
      }
    }
  }
  function openTemplateSetup(document, creating) {
    pause();
    backgroundEditing = false;
    viewport.classList.remove("background-editing");
    initialSetup = creating;
    generationFocus = "";
    generationDraft = S.clone(document);
    generationDraft.generation = {
      ...generationDraft.generation,
      size: 1,
      spacing: 1,
    };
    generationCatalog();
    generationOptions();
    $("generate-title").textContent = creating
      ? "Set up design"
      : "Regenerate from template";
    $("generate-description").textContent = ["overlay", "canvas"].includes(
      document.template,
    )
      ? document.template === "canvas"
        ? "Review the shared canvas layout, then choose event recipients after applying."
        : "Review the template, then adjust sponsor artwork and appearance in the editor."
      : "Choose the sponsors to include. Sizes and spacing are automatic.";
    $("generate-notice").textContent = creating
      ? "Start with this template, then make any edits in the editor."
      : "Apply replaces your entire design, including manual edits and uploaded originals. Undo restores the previous design.";
    $("generate-preview").replaceChildren();
    $("generate-preview").style.background =
      document.background.color === "transparent" ? "#252525" : "";
    $("generate-dialog").showModal();
    updateGeneration(true);
  }
  $("regenerate-template").onclick = () => $("regenerate-dialog").showModal();
  $("regenerate-cancel").onclick = () => $("regenerate-dialog").close();
  $("regenerate-continue").onclick = () =>
    run(async () => {
      $("regenerate-dialog").close();
      const { defaults } = await (await request("refresh")).json();
      openTemplateSetup(defaults, false);
    });
  $("generate-cancel").onclick = () => $("generate-dialog").close();
  $("generate-dialog").addEventListener("close", () => {
    generationTicket++;
    generationDraft = null;
    generationReady = false;
    generationLoading = false;
    state();
    if (initialSetup) {
      leaving = true;
      location.href = $("studio-back").href;
    }
  });
  $("generate-apply").onclick = () => {
    if (!generationReady || generationLoading) return;
    const next = S.clone(generationDraft),
      creating = initialSetup;
    initialSetup = false;
    backgroundEditing = false;
    $("generate-dialog").close();
    run(async () => {
      d = next;
      selected.clear();
      await mount();
      layoutMode();
      if (creating) {
        hist = S.history(snapshot());
        state();
      } else commit();
      if (d.dataset?.source && d.dataset.source !== "csv")
        await refreshRecipients();
    });
  };
  $("layers-toggle").onclick = () => {
    const show = $("layers-drawer").hidden;
    $("layers-drawer").hidden = !show;
    if (show && variable()) {
      showData(false);
    }
    $("studio-workspace").classList.toggle("with-layers", show);
    $("layers-toggle").setAttribute("aria-expanded", show);
    $("layers-toggle").querySelector("[data-check]").textContent = show
      ? "✓"
      : "";
    if (fitted) fit();
  };
  $("timeline-toggle").onclick = () => {
    const show = $("timeline").hidden;
    $("timeline").hidden = !show;
    $("timeline-toggle").setAttribute("aria-expanded", show);
    $("timeline-toggle").querySelector("[data-check]").textContent = show
      ? "✓"
      : "";
    if (fitted) fit();
  };
  // Native popovers provide outside-click and Escape dismissal. Keep commands
  // in one place, and let both toolbar and menu entries invoke the same action.
  document.querySelectorAll("[data-activate]").forEach((el) => {
    el.onclick = () => $(el.dataset.activate).click();
  });
  // Main menus and the export submenu use the same list-navigation keys.
  function moveMenuFocus(e, buttons) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return false;
    e.preventDefault();
    e.stopPropagation();
    const at = buttons.indexOf(document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (at + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
    return true;
  }
  const menus = [...document.querySelectorAll(".studio-menubar button")];
  for (const [index, trigger] of menus.entries()) {
    const panel = $(trigger.getAttribute("popovertarget"));
    trigger.addEventListener("pointerenter", () => {
      if (trigger.disabled || panel.matches(":popover-open")) return;
      if (
        menus.some((menu) =>
          $(menu.getAttribute("popovertarget")).matches(":popover-open"),
        )
      )
        panel.showPopover();
    });
    const items = () =>
      [...panel.querySelectorAll("button:not(:disabled):not([hidden])")].filter(
        (button) =>
          button.getClientRects().length && !button.closest("#export-submenu"),
      );
    panel.addEventListener("beforetoggle", (e) => {
      if (e.newState !== "open") return;
      const box = trigger.getBoundingClientRect();
      panel.style.top = box.bottom + "px";
      panel.style.left = Math.min(box.left, window.innerWidth - 260) + "px";
    });
    panel.addEventListener("toggle", () => {
      trigger.setAttribute("aria-expanded", panel.matches(":popover-open"));
    });
    function switchMenu(key, open) {
      if (panel.matches(":popover-open")) panel.hidePopover();
      const next =
        menus[
          (index + (key === "ArrowRight" ? 1 : -1) + menus.length) %
            menus.length
        ];
      next.focus();
      if (open) $(next.getAttribute("popovertarget")).showPopover();
    }
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        panel.showPopover();
        const buttons = items();
        (e.key === "ArrowDown" ? buttons[0] : buttons.at(-1))?.focus();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        switchMenu(e.key, panel.matches(":popover-open"));
      }
    });
    panel.addEventListener("keydown", (e) => {
      if (moveMenuFocus(e, items())) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        switchMenu(e.key, true);
      }
    });
    panel.addEventListener(
      "click",
      (e) => {
        const action = e.target.closest("button");
        if (action && !action.disabled && action.id !== "export-menu-toggle")
          panel.hidePopover();
      },
      { capture: true },
    );
  }
  $("fit").onclick = fit;
  $("zoom-in").onclick = () => {
    zoom = Math.min(4 * S.unitFactor(d.page.unit), zoom * 1.25);
    fitted = false;
    size();
  };
  $("zoom-out").onclick = () => {
    zoom = Math.max(0.03 * S.unitFactor(d.page.unit), zoom / 1.25);
    fitted = false;
    size();
  };
  $("undo").onclick = () => run(() => restore(hist.undo()));
  $("redo").onclick = () => run(() => restore(hist.redo()));
  $("design-name").oninput = () => {
    name = $("design-name").value;
    state();
  };
  $("design-name").onchange = commit;
  $("design-name").onblur = commit;
  async function save() {
    const response = await request("", { name, document: d }),
      data = await response.json();
    revision = data.revision;
    if (data.document) {
      d.assets = data.document.assets;
      d.artworkBounds = data.document.artworkBounds;
      if (data.document.dataset) d.dataset = data.document.dataset;
      await scene.ready();
      render();
    }
    saved = JSON.stringify(snapshot());
    hist.replace(snapshot());
    state();
  }
  $("save").onclick = () => run(save);
  async function downloadExport(format) {
    pause();
    await save();
    const response = await request("export", {
        format,
        recipientId: variable() ? recipientID : undefined,
      }),
      blob = await response.blob(),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download =
      response.headers
        .get("Content-Disposition")
        ?.match(/filename="([^"]+)"/)?.[1] || "studio-export." + format;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  for (const button of document.querySelectorAll("[data-export]"))
    button.onclick = () => run(() => downloadExport(button.dataset.export));
  function exportSubmenu(show) {
    $("export-submenu").hidden = !show;
    $("export-menu-toggle").setAttribute("aria-expanded", show);
  }
  $("export-menu-toggle").onclick = (e) => {
    exportSubmenu(true);
    if (e.detail === 0)
      $("export-submenu")
        .querySelector("button:not([hidden]):not(:disabled)")
        ?.focus();
  };
  $("export-menu-toggle").onpointerenter = () => exportSubmenu(true);
  $("export-menu-toggle").addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      exportSubmenu(true);
      $("export-submenu")
        .querySelector("button:not([hidden]):not(:disabled)")
        ?.focus();
    }
  });
  $("export-submenu").addEventListener("keydown", (e) => {
    const buttons = [
      ...$("export-submenu").querySelectorAll(
        "button:not([hidden]):not(:disabled)",
      ),
    ];
    if (moveMenuFocus(e, buttons)) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      exportSubmenu(false);
      $("export-menu-toggle").focus();
    }
  });
  $("file-menu")
    .querySelectorAll(":scope > button")
    .forEach((button) =>
      button.addEventListener("pointerenter", () => exportSubmenu(false)),
    );
  $("file-menu").addEventListener("toggle", (e) => {
    if (e.newState === "closed") exportSubmenu(false);
  });
  let setupUnit = "px",
    setupCSV = "",
    setupDataset = null;
  function csvText(dataset) {
    const quote = (v) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
    return [
      dataset.columns,
      ...dataset.rows.map((r) =>
        dataset.columns.map((c) => r.values?.[c] || ""),
      ),
    ]
      .map((row) => row.map(quote).join(","))
      .join("\n");
  }
  function setupData() {
    const source = $("setup-source").value;
    $("setup-csv").hidden = source !== "csv";
    $("setup-kind").querySelector('option[value="video"]').disabled =
      source !== "none";
    $("setup-data-summary").textContent =
      source === "none"
        ? "Turning variable data off keeps the previewed row as shared artwork and text."
        : source === "event_gifts"
          ? "Use this event’s gift recipients, artwork, names, and event details. Changes are reviewed before applying."
          : "CSV row order is preserved. Map selected objects using Variable field in Properties.";
  }
  function csvColumns(dataset) {
    setupDataset = dataset;
    for (const id of ["setup-name-column", "setup-image-column"]) {
      const select = $(id);
      select.replaceChildren();
      if (id === "setup-image-column") {
        const o = document.createElement("option");
        o.value = "";
        o.textContent = "None (text only)";
        select.append(o);
      }
      for (const c of dataset.columns || []) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        select.append(o);
      }
      select.value =
        id === "setup-name-column"
          ? dataset.nameColumn
          : dataset.imageColumn || "";
    }
    $("setup-data-summary").textContent =
      dataset.rows.length + " CSV rows. Choose columns, then Apply to review.";
  }
  $("setup-source").onchange = setupData;
  $("setup-csv-file").onchange = () =>
    run(async () => {
      try {
        const file = $("setup-csv-file").files[0];
        if (!file) return;
        if (file.size > 1048576) throw Error("CSV exceeds 1 MB");
        setupCSV = await file.text();
        const ds = await (
          await request("recipient-data", {
            source: "csv",
            csv: setupCSV,
            imageColumn: "auto",
          })
        ).json();
        csvColumns(ds);
        $("setup-error").textContent = "";
      } catch (e) {
        setupCSV = "";
        setupDataset = null;
        $("setup-error").textContent = e.message;
      }
    });
  function setupType() {
    const kind = $("setup-kind").value;
    if (kind === "video" && $("setup-unit").value !== "px") {
      $("setup-unit").value = "px";
      convertSetupUnits();
    }
    $("setup-unit")
      .querySelectorAll("option")
      .forEach((o) => (o.disabled = kind === "video" && o.value !== "px"));
    $("setup-duration-label").hidden = kind !== "video";
    $("setup-variable-section").hidden = kind !== "graphic";
  }
  function convertSetupUnits() {
    const unit = $("setup-unit").value,
      factor = S.unitFactor(setupUnit) / S.unitFactor(unit);
    for (const key of ["width", "height"])
      $("setup-" + key).value = Number(
        (Number($("setup-" + key).value) * factor).toFixed(6),
      );
    setupUnit = unit;
  }
  $("document-setup").onclick = () => {
    pause();
    $("setup-kind").value = S.type(d);
    $("setup-kind").querySelector('option[value="video"]').disabled =
      !!d.dataset;
    setupUnit = d.page.unit;
    $("setup-unit").value = setupUnit;
    for (const key of ["width", "height"])
      $("setup-" + key).value = d.page[key];
    $("setup-duration").value = d.duration || 5;
    $("setup-error").textContent = "";
    $("setup-source").value = d.dataset?.source || "none";
    setupCSV = d.dataset?.source === "csv" ? csvText(d.dataset) : "";
    setupDataset = d.dataset?.source === "csv" ? d.dataset : null;
    $("setup-csv-file").value = "";
    setupData();
    if (setupDataset) csvColumns(setupDataset);
    setupType();
    $("document-dialog").showModal();
  };
  $("setup-kind").onchange = setupType;
  $("setup-unit").onchange = convertSetupUnits;
  $("setup-cancel").onclick = () => $("document-dialog").close();
  $("setup-apply").onclick = () =>
    run(async () => {
      try {
        const page = { unit: $("setup-unit").value };
        for (const key of ["width", "height"])
          page[key] = Number($("setup-" + key).value);
        const kind = $("setup-kind").value;
        // Preserve older graphic documents' trim padding without exposing it as a setting.
        page.bleed =
          kind === "video"
            ? 0
            : ((d.page.bleed || 0) * S.unitFactor(d.page.unit)) /
              S.unitFactor(page.unit);
        const duration =
          Math.round(Number($("setup-duration").value) * 30) / 30;
        const next = S.configure(d, page, kind, duration);
        const source = kind === "graphic" ? $("setup-source").value : "none";
        let reviewed = null;
        if (source === "none") {
          S.walk(next.nodes, (n) => {
            if (!n.binding?.row) return;
            if (n.kind === "text") n.text = S.textValue(n, recipientValues);
            if (n.binding.row === "artwork" && recipientValues.source)
              next.assets[n.asset] = recipientValues.source;
            delete n.binding.row;
            delete n.binding.column;
          });
          delete next.dataset;
        } else if (source === "csv") {
          if (!setupCSV || !setupDataset)
            throw Error("Choose a CSV file first.");
          reviewed = await (
            await request("recipient-data", {
              source,
              csv: setupCSV,
              nameColumn: $("setup-name-column").value,
              imageColumn: $("setup-image-column").value,
            })
          ).json();
        } else if (d.dataset?.source !== source) {
          reviewed = await (await request("recipient-data", { source })).json();
        }
        // Keep setup atomic: review row changes before replacing the saved source.
        if (reviewed) {
          next.dataset = d.dataset || null;
        }

        // Server validation gives setup the same bounds as saved documents and exports.
        await request("prepare-layout", { document: next });
        zoom *= S.unitFactor(next.page.unit) / S.unitFactor(d.page.unit);
        d = next;
        time = Math.min(time, d.duration);
        selected.clear();
        await mount();
        layoutMode();
        commit();
        $("document-dialog").close();
        if (reviewed) reviewData(reviewed);
      } catch (e) {
        $("setup-error").textContent = e.message || String(e);
      }
    });
  $("delete-design").onclick = () => {
    $("delete-description").textContent = `Remove “${name}” from Studio?`;
    $("delete-dialog").showModal();
  };
  $("delete-cancel").onclick = () => $("delete-dialog").close();
  $("delete-confirm").onclick = () =>
    run(async () => {
      $("delete-dialog").close();
      const result = await (await request("delete")).json();
      leaving = true;
      location.href =
        result.url +
        "?deleted=" +
        encodeURIComponent(boot.record.id) +
        "&revision=" +
        result.revision;
    });
  let leaving = false;
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
  const studioBack = $("studio-back");
  studioBack.onclick = (e) => {
    // A new tab does not leave this design or discard its edits.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (busy) return;
    if (dirty()) $("switch-dialog").showModal();
    else location.href = studioBack.href;
  };
  $("switch-cancel").onclick = () => $("switch-dialog").close();
  $("switch-discard").onclick = () => {
    leaving = true;
    location.href = studioBack.href;
  };
  $("switch-save").onclick = () =>
    run(async () => {
      $("switch-dialog").close();
      await save();
      location.href = studioBack.href;
    });
  $("duplicate-design").onclick = () =>
    run(async () => {
      await save();
      location.href = (await (await request("duplicate")).json()).url;
    });
  $("play").onclick = () => {
    if (playing) {
      pause();
      return;
    }
    editing = false;
    selectionBox();
    if (time >= d.duration) time = 0;
    const start = performance.now() - time * 1000;
    $("play").textContent = "Pause";
    const frame = (now) => {
      seek((now - start) / 1000);
      if (time >= d.duration) pause();
      else playing = requestAnimationFrame(frame);
    };
    playing = requestAnimationFrame(frame);
  };
  $("edit-layout").onclick = () => {
    layoutMode();
    seek(0);
  };
  $("scrub").oninput = () => {
    pause();
    editing = false;
    selectionBox();
    seek(Number($("scrub").value));
  };
  window.addEventListener("keydown", (e) => {
    // Let native dialogs/popovers handle Escape without changing canvas selection.
    if (document.querySelector("dialog[open], :popover-open")) return;
    const field =
      /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) ||
      e.target.isContentEditable;
    if (e.key === "Escape") {
      if (backgroundEditing) {
        finish(false);
        endBackground();
        return;
      }
      finish(true);
      select(null);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (!busy) {
        if (field) e.target.blur();
        run(save);
      }
      return;
    }
    if (field) return;
    if (e.code === "Space") {
      space = true;
      e.preventDefault();
    }
    if (busy) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      run(() => restore(e.shiftKey ? hist.redo() : hist.undo()));
    } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
      e.preventDefault();
      run(() => restore(hist.redo()));
    }
    if ((e.metaKey || e.ctrlKey) && ["d", "g"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      command(
        e.key.toLowerCase() === "d"
          ? "duplicate"
          : e.shiftKey
            ? "ungroup"
            : "group",
      );
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      command("remove");
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
      e.preventDefault();
      mutate(() => {
        const step = (e.shiftKey ? 10 : 1) / S.unitFactor(d.page.unit);
        for (const n of roots().filter(editable))
          moveWorld(
            n,
            e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0,
            e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0,
          );
      });
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") space = false;
  });
  window.addEventListener("blur", () => {
    space = false;
    finish(true);
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty() && !leaving) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  new ResizeObserver(() => {
    if (fitted && scene) fit();
  }).observe(viewport);
  if (d.template === "overlay") $("preview-background").value = "dark";
  if (variable()) showData(true);
  if (d.needsArrange) {
    openTemplateSetup(d, true);
  } else {
    await run(async () => {
      await mount();
      hist = S.history(snapshot());
      seek(0);
      if (variable() && d.dataset.source !== "csv") await refreshRecipients();
    });
  }
})();
