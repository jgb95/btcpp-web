/* Shared document operations and SVG scene. No editor chrome enters this tree. */
(() => {
  "use strict";
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const walk = (nodes, fn, parent = null) =>
    nodes.forEach((n) => {
      fn(n, parent);
      walk(n.children || [], fn, n);
    });
  const all = (d) => {
    const a = [];
    walk(d.nodes, (n) => a.push(n));
    return a;
  };
  const uid = () => "n" + crypto.randomUUID();
  const item = (kind, name) => ({
    id: uid(),
    kind,
    name,
    x: 0,
    y: 0,
    width: 160,
    height: 80,
    scale: 1,
    rotation: 0,
    opacity: 1,
    greyscale: 0,
    brightness: 1,
    font: "BannerMono",
    fontSize: 32,
    color: "#ffffff",
    text: "Text",
    children: [],
  });
  const pose = (t, a) => {
    if (t === null || !a) return { opacity: 1, y: 0 };
    if (t < a.start || t >= a.end) return { opacity: 0, y: 0 };
    const clamp = (v) => Math.max(0, Math.min(1, v)),
      ease = (v) => v * v * (3 - 2 * v),
      enter = a.fade ? clamp((t - a.start) / a.fade) : 1,
      exit = a.fade ? clamp((a.end - t) / a.fade) : 1;
    return {
      opacity: ease(enter) * ease(exit),
      y: a.rise * ((1 - enter) ** 3 - (1 - exit) ** 3),
    };
  };
  function history(initial, limit = 80) {
    let past = [],
      future = [],
      present = clone(initial);
    return {
      replace(value) {
        present = clone(value);
      },
      push(value) {
        if (JSON.stringify(value) === JSON.stringify(present)) return;
        past.push(present);
        if (past.length > limit) past.shift();
        present = clone(value);
        future = [];
      },
      undo() {
        if (!past.length) return null;
        future.push(present);
        present = past.pop();
        return clone(present);
      },
      redo() {
        if (!future.length) return null;
        past.push(present);
        present = future.pop();
        return clone(present);
      },
      get canUndo() {
        return !!past.length;
      },
      get canRedo() {
        return !!future.length;
      },
    };
  }
  const reelTiers = ["headline", "title", "workshop", "silver", "regular"];
  // Older drafts stored one group per visual row. Preserve them on load, but
  // consolidate their known labels when the user explicitly arranges.
  function normalizeReelRows(d) {
    if (d.template !== "reel") return;
    function normalize(list) {
      const result = [],
        merged = new Map();
      for (const n of list) {
        if (!n.binding?.tier?.startsWith("legacy-")) {
          if (n.children) n.children = normalize(n.children);
          result.push(n);
          continue;
        }
        const label = n.name
            .trim()
            .toLowerCase()
            .replace(/\s+sponsors?$/, ""),
          tier = {
            headline: "headline",
            diamond: "headline",
            title: "title",
            workshop: "workshop",
            hackathon: "workshop",
            silver: "silver",
            sponsors: "regular",
            sponsor: "regular",
            bronze: "regular",
            regular: "regular",
          }[label];
        if (!tier) {
          // Import extra tiers hidden once, but allow explicit inclusion later.
          n.binding.tier = label.replace(/[^a-z0-9]+/g, "-") || "other";
          n.hidden = true;
          n.animation = null;
          result.push(n);
          continue;
        }
        let g = merged.get(tier);
        if (!g) {
          g = item(
            "group",
            {
              headline: "Headline sponsors",
              title: "Title sponsors",
              workshop: "Workshop / hackathon",
              silver: "Silver sponsors",
              regular: "Regular sponsors",
            }[tier],
          );
          g.binding = { tier };
          g.animation = n.animation ? clone(n.animation) : null;
          merged.set(tier, g);
          result.push(g);
        } else if (n.animation) {
          if (!g.animation) g.animation = clone(n.animation);
          else {
            g.animation.start = Math.min(g.animation.start, n.animation.start);
            g.animation.end = Math.max(g.animation.end, n.animation.end);
          }
        }
        const plain =
          !n.x &&
          !n.y &&
          n.scale === 1 &&
          !n.rotation &&
          (n.opacity ?? 1) === 1 &&
          !n.hidden &&
          !n.locked;
        if (plain) g.children.push(...(n.children || []));
        else {
          delete n.binding;
          delete n.animation;
          g.children.push(n);
        }
      }
      return result;
    }
    d.nodes = normalize(d.nodes);
  }
  // Scan alpha only; opaque artwork retains the full original rectangle.
  function visibleBounds(pixels, width, height) {
    let left = width,
      top = height,
      right = -1,
      bottom = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] > 8) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    if (right < left) return null;
    left = Math.max(0, left - 1);
    top = Math.max(0, top - 1);
    right = Math.min(width, right + 2);
    bottom = Math.min(height, bottom + 2);
    return {
      x: left / width,
      y: top / height,
      width: (right - left) / width,
      height: (bottom - top) / height,
    };
  }
  // Compare centered grids. Print balances optical area; the reel uses the
  // reference's original-canvas height limits, keeping deliberately small marks small.
  function fitLogos(logos, area, ratio, options = {}) {
    if (!logos.length) return [];
    const size = options.size || 1,
      gap = options.gap ?? 20,
      rowGap = options.rowGap ?? gap;
    let best = null;
    for (
      let cols = 1;
      cols <= Math.min(logos.length, options.maxColumns || 12);
      cols++
    ) {
      const rows = Math.ceil(logos.length / cols);
      const cw = (area.width - gap * (cols - 1)) / cols;
      const rh = (area.height - rowGap * (rows - 1)) / rows;
      if (cw <= 0 || rh <= 0) continue;
      const target = Math.min(
        Math.sqrt(cw * rh) * 0.9,
        options.maxOptical || Infinity,
      );
      const boxes = logos.map((n) => {
        const r = Math.max(0.02, Math.min(100, ratio(n)));
        let h = options.canvasHeight
          ? options.canvasHeight(n)
          : target / Math.sqrt(r);
        let w = options.canvasHeight ? r * h : Math.sqrt(r) * target;
        const inset = options.canvasHeight ? 0.94 : 1;
        const f = Math.min(
          1,
          (cw * inset) / w,
          (rh * inset) / h,
          (options.maxHeight || rh) / h,
        );
        return { width: w * f, height: h * f };
      });
      // Harmonic mean favors balanced readable sizes over a single giant logo.
      const score =
        logos.length /
        boxes.reduce((sum, b) => sum + 1 / Math.sqrt(b.width * b.height), 0);
      if (!best || score > best.score + 0.00001)
        best = { score, cols, rows, cw, rh, boxes };
    }
    if (!best) {
      // Extreme counts still remain present, with a crowding warning.
      return fitLogos(logos, area, ratio, { ...options, gap: 0, rowGap: 0 });
    }
    return best.boxes.map((original, i) => {
      const f = Math.min(
        size,
        best.cw / original.width,
        best.rh / original.height,
        (options.maxHeight || best.rh) / original.height,
      );
      const b = { width: original.width * f, height: original.height * f };
      const row = Math.floor(i / best.cols),
        col = i % best.cols;
      const count = Math.min(best.cols, logos.length - row * best.cols);
      const rowWidth = count * best.cw + (count - 1) * gap;
      return {
        ...b,
        x:
          area.x +
          (area.width - rowWidth) / 2 +
          col * (best.cw + gap) +
          (best.cw - b.width) / 2,
        y: area.y + row * (best.rh + rowGap) + (best.rh - b.height) / 2,
      };
    });
  }
  function layoutWarnings(d) {
    if (d.template === "overlay") return [];
    const crowded = [];
    const minimum =
      (d.template === "banner" ? (14 * 96) / 25.4 : 64) /
      unitFactor(d.page?.unit || "px");
    walk(d.nodes, (g) => {
      if (g.kind !== "group" || !g.binding?.tier || g.hidden) return;
      const logos = [];
      walk(g.children || [], (n) => {
        if (
          n.kind === "image" &&
          !n.hidden &&
          (n.binding?.sponsor || n.binding?.field === "sponsor")
        )
          logos.push(n);
      });
      if (
        logos.some((n) => {
          const b = d.artworkBounds?.[n.asset];
          const occupancy = b ? Math.sqrt(b.width * b.height) : 1;
          const compact = n.width / n.height < 1.7 ? 0.65 : 1;
          return (
            Math.sqrt(n.width * n.height) * n.scale * g.scale <
            minimum * occupancy * compact
          );
        })
      )
        crowded.push(g.name);
    });
    return [...new Set(crowded)];
  }
  function arrange(d, ratio = () => 3) {
    normalizeReelRows(d);
    const sponsor = (n) =>
      n.kind === "image" &&
      !!(n.binding?.sponsor || n.binding?.field === "sponsor");
    const multiply = (a, b) => [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
    const parents = new Map();
    walk(d.nodes, (n, p) => parents.set(n, p));
    function worldMatrix(n) {
      if (!n) return [1, 0, 0, 1, 0, 0];
      const r = ((n.rotation || 0) * Math.PI) / 180,
        scale = n.scale || 1;
      return multiply(worldMatrix(parents.get(n)), [
        Math.cos(r) * scale,
        Math.sin(r) * scale,
        -Math.sin(r) * scale,
        Math.cos(r) * scale,
        n.x || 0,
        n.y || 0,
      ]);
    }
    const lists = new Map();
    for (const g of all(d).filter(
      (n) => n.kind === "group" && n.binding?.tier,
    )) {
      const entries = [];
      function collect(children, matrix) {
        for (const n of children) {
          if (n.hidden) continue;
          if (sponsor(n)) entries.push({ copy: clone(n), node: n, matrix });
          if (n.kind === "group") {
            const r = (n.rotation * Math.PI) / 180,
              c = Math.cos(r) * n.scale,
              s = Math.sin(r) * n.scale;
            collect(
              n.children || [],
              multiply(matrix, [c, s, -s, c, n.x, n.y]),
            );
          }
        }
      }
      if (!g.hidden) collect(g.children || [], worldMatrix(g));
      lists.set(g, entries);
    }
    const logosFor = (g) => lists.get(g).map((e) => e.copy);
    let groups = [...lists.keys()].filter((g) => lists.get(g).length);
    if (d.template === "overlay") {
      d.needsArrange = false;
      return;
    }
    const settings = d.generation || { size: 1, spacing: 1 };
    const reel = d.template === "reel";
    const reference = !reel && settings.bannerReference;
    const corner = reference
      ? groups.find((g) => g.binding.tier.toLowerCase() === "title")
      : null;
    if (corner) {
      const logos = logosFor(corner),
        boxes = fitLogos(
          logos,
          { x: 570, y: 125, width: 220, height: 85 },
          ratio,
          { maxColumns: 1, gap: 8 },
        );
      logos.forEach((n, i) => Object.assign(n, boxes[i], { scale: 1 }));
      groups = groups.filter((g) => g !== corner);
    }
    if (reel)
      groups.sort((a, b) => {
        const priority = (g) => {
          const i = reelTiers.indexOf(g.binding.tier);
          return i < 0 ? reelTiers.length : i;
        };
        return priority(a) - priority(b);
      });
    const styles = {
      // Band weight, width, original-canvas height, reference capacity.
      // Calibrated against the final berlin26/recordings/assets short reel.
      headline: [2.3, 1760, 180, 2],
      title: [1.8, 1300, 128, 1],
      workshop: [1.65, 1440, 120, 2],
      silver: [1.25, 1280, 90, 3],
      regular: [1.6, 1280, 60, 6],
    };
    const style = (g) =>
      reel
        ? styles[g.binding.tier] || styles.regular
        : [g.weight || 1, 480, Infinity];
    const demand = (g) =>
      style(g)[0] *
      (reel
        ? Math.max(1, Math.sqrt(logosFor(g).length / style(g)[3]))
        : Math.sqrt(logosFor(g).length));
    const total = groups.reduce((sum, g) => sum + demand(g), 0);
    const bandGap = (reel ? 28 : 20) * settings.spacing;
    const headingSpace = reel || settings.noHeadings ? 0 : 26;
    // Leave room for the footer above the banner's six-inch roll-up margin.
    const available =
      (reel ? 870 : 1330) -
      Math.max(0, groups.length - 1) * bandGap -
      groups.length * headingSpace;
    let top = reel ? 110 : 260;
    let opticalLimit = Infinity;
    for (const g of groups) {
      const [prominence, span, maxHeight] = style(g);
      const bandHeight = Math.max(
        1,
        (available * demand(g)) / Math.max(0.001, total),
      );
      if (!reel) {
        const heading = all(d).find(
          (n) =>
            n.binding?.field === "tier-heading:" + g.binding.tier ||
            n.id === "text-" + g.id,
        );
        if (heading) {
          heading.x = 290;
          heading.y = top + 16;
        }
      }
      const logos = logosFor(g);
      const boxes = fitLogos(
        logos,
        {
          x: reel ? (1920 - span) / 2 : 290,
          y: top + headingSpace,
          width: span,
          height: bandHeight,
        },
        ratio,
        {
          size: settings.size,
          maxColumns:
            reference && g.binding.tier.toLowerCase() !== "regular" ? 1 : 12,
          gap: (reel ? 32 : 20) * settings.spacing,
          rowGap: (reel ? 16 : 20) * settings.spacing,
          maxHeight,
          maxOptical: reel ? Infinity : opticalLimit * prominence,
          canvasHeight: reel
            ? (n) => maxHeight * (d.artworkBounds?.[n.asset]?.height || 1)
            : null,
        },
      );
      if (boxes.length) {
        const optical =
          boxes.length /
          boxes.reduce((sum, b) => sum + 1 / Math.sqrt(b.width * b.height), 0);
        opticalLimit = Math.min(
          opticalLimit,
          reel
            ? (optical * 0.94) / settings.size
            : optical / (prominence * settings.size),
        );
      }
      logos.forEach((n, i) => Object.assign(n, boxes[i], { scale: 1 }));
      top += headingSpace + bandHeight + bandGap;
    }
    // Empty tiers have no heading and take no space; custom text is untouched.
    if (!reel)
      for (const g of [...lists.keys()].filter((g) => !lists.get(g).length)) {
        const heading = all(d).find(
          (n) =>
            n.binding?.field === "tier-heading:" + g.binding.tier ||
            n.id === "text-" + g.id,
        );
        if (heading) heading.hidden = true;
      }
    if (!reel)
      for (const g of groups) {
        const heading = all(d).find(
          (n) =>
            n.binding?.field === "tier-heading:" + g.binding.tier ||
            n.id === "text-" + g.id,
        );
        if (heading) heading.hidden = !!settings.noHeadings;
      }
    if (settings.noHeadings)
      for (const n of all(d)) {
        if (n.binding?.field?.startsWith("tier-heading:")) n.hidden = true;
      }
    for (const entries of lists.values())
      for (const { copy: n, node, matrix: m } of entries) {
        const det = m[0] * m[3] - m[1] * m[2],
          x = n.x - m[4],
          y = n.y - m[5],
          scale = Math.hypot(m[0], m[1]);
        node.x = (m[3] * x - m[2] * y) / det;
        node.y = (-m[1] * x + m[0] * y) / det;
        node.width = n.width / scale;
        node.height = n.height / scale;
        node.rotation = (-Math.atan2(m[1], m[0]) * 180) / Math.PI || 0;
        node.scale = 1;
      }
    d.needsArrange = false;
  }
  // Supplied Berlin SVG, also available in static/img/btcpp-logo-{white,black}.svg.
  // Inline once per document so saved designs/export never depend on a font or URL.
  const brandArtwork = {
    white:
      "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iTGF5ZXJfMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCA2MDUuNiAxNTYiPgogIDwhLS0gR2VuZXJhdG9yOiBBZG9iZSBJbGx1c3RyYXRvciAzMC4xLjAsIFNWRyBFeHBvcnQgUGx1Zy1JbiAuIFNWRyBWZXJzaW9uOiAyLjEuMSBCdWlsZCAxMzYpICAtLT4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLnN0MCB7CiAgICAgICAgZmlsbDogI2ZmZjsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPHBhdGggY2xhc3M9InN0MCIgZD0iTTU1LjQsNTUuM2M0LjYsMCw4LjYuOCwxMiwyLjVzNi4yLDMuOSw4LjQsNi43YzIuMiwyLjgsMy44LDYuMSw0LjksOS45LDEuMSwzLjgsMS42LDcuOSwxLjYsMTIuMiwwLDYuNy0xLjIsMTMtMy43LDE5cy01LjgsMTEuMi0xMCwxNS42LTkuMiw3LjktMTUsMTAuNS0xMiwzLjktMTguOCwzLjktMi40LDAtNC41LDAtNC42LS4zLTcuNC0uN2MtMi44LS40LTUuOC0xLTguOS0xLjgtMy4xLS44LTYuMS0xLjgtOC45LTMuMkwzMCwyMy45bDIyLjQtMy41LTksMzcuNmMxLjktLjksMy44LTEuNiw1LjgtMiwxLjktLjUsNC0uNyw2LjItLjdaTTM2LjYsMTE3LjdjMy40LDAsNi41LS44LDkuNS0yLjVzNS42LTMuOSw3LjctNi42LDMuOS01LjksNS4xLTkuNCwxLjktNy4xLDEuOS0xMC45LS44LTguMy0yLjMtMTAuOWMtMS41LTIuNi00LjQtMy45LTguNS0zLjlzLTMuMS4yLTUuMy43Yy0yLjIuNS00LjEsMS41LTUuOCwzLjFsLTkuNSw0MGMuNiwwLDEuMS4yLDEuNS4zLjQsMCwuOS4yLDEuNC4yaDQuMywwWiIvPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xMDkuNCwxMzMuNmgtMjEuNGwxOC03Ni43aDIxLjVsLTE4LjIsNzYuN2gwWk0xMTkuOCw0Ny41Yy0zLDAtNS43LS45LTguMS0yLjdzLTMuNi00LjUtMy42LTguMi40LTQsMS4yLTUuOGMuOC0xLjgsMS45LTMuNCwzLjItNC43LDEuMy0xLjMsMi45LTIuNCw0LjctMy4xLDEuOC0uOCwzLjctMS4yLDUuNy0xLjIsMywwLDUuNy45LDguMSwyLjcsMi40LDEuOCwzLjYsNC41LDMuNiw4LjJzLS40LDQtMS4yLDUuOC0xLjksMy40LTMuMiw0LjdjLTEuMywxLjMtMi45LDIuNC00LjcsMy4xLTEuOC44LTMuNywxLjItNS43LDEuMloiLz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTQ5LjUsMzcuOGwyMi40LTMuNS01LjUsMjIuNmgyNGwtNC4zLDE3LjhoLTIzLjhsLTYuNCwyNi44Yy0uNiwyLjItLjksNC4zLTEuMSw2LjMtLjEsMS45LDAsMy42LjcsNSwuNiwxLjQsMS43LDIuNSwzLjIsMy4zczMuNywxLjIsNi40LDEuMiw0LjUtLjIsNi43LS43LDQuNC0xLDYuNi0xLjhsMS42LDE2LjZjLTIuOSwxLjEtNiwyLTkuNCwyLjhzLTcuNCwxLjItMTIsMS4yYy02LjYsMC0xMS44LTEtMTUuNC0zLTMuNy0yLTYuMy00LjctNy44LTguMnMtMi4yLTcuNC0yLTExLjkuOS05LjIsMi0xNC4xYzAsMCwxNC4xLTYwLjQsMTQuMS02MC40WiIvPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xOTEuMiwxMDIuOWMwLTYuNiwxLjEtMTIuOCwzLjItMTguNywyLjEtNS44LDUuMS0xMC45LDkuMS0xNS4zLDMuOS00LjQsOC43LTcuOCwxNC40LTEwLjQsNS42LTIuNSwxMS45LTMuOCwxOC44LTMuOHM4LjIuNCwxMS42LDEuMiw2LjUsMS45LDkuMywzLjNsLTcuNCwxNi45Yy0xLjktLjgtMy45LTEuNS02LTIuMXMtNC42LS45LTcuNi0uOWMtNy4yLDAtMTIuOSwyLjUtMTcsNy40cy02LjIsMTEuNi02LjIsMjAsMS4xLDksMy4yLDEyYzIuMSwzLjEsNiw0LjYsMTEuNyw0LjZzNS41LS4zLDguMS0uOSw0LjktMS4zLDYuOS0yLjJsMS42LDE3LjRjLTIuNywxLjEtNS43LDItOC45LDIuOHMtNy4xLDEuMi0xMS44LDEuMi0xMS0uOS0xNS4yLTIuNmMtNC4xLTEuNy03LjYtNC4xLTEwLjMtNy4xcy00LjYtNi40LTUuOC0xMC40LTEuOC04LjItMS44LTEyLjVoMFoiLz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMjg3LjEsMTM1LjZjLTUuMSwwLTkuNS0uOC0xMy4zLTIuMy0zLjgtMS42LTYuOS0zLjctOS4zLTYuNi0yLjUtMi44LTQuMy02LjEtNS42LTEwLTEuMy0zLjgtMS45LTguMS0xLjktMTIuOHMuOS0xMS43LDIuOC0xNy41LDQuNi0xMS4xLDguMy0xNS43YzMuNy00LjcsOC4xLTguNSwxMy40LTExLjQsNS4zLTMsMTEuNC00LjQsMTguMi00LjRzOS40LjgsMTMuMiwyLjNjMy44LDEuNiw2LjksMy43LDkuNCw2LjYsMi41LDIuOCw0LjMsNi4xLDUuNiwxMCwxLjIsMy44LDEuOSw4LjEsMS45LDEyLjhzLS45LDExLjctMi43LDE3LjVjLTEuOCw1LjgtNC41LDExLjEtOC4xLDE1LjctMy42LDQuNy04LDguNS0xMy40LDExLjQtNS4zLDMtMTEuNSw0LjQtMTguNiw0LjRoLjFaTTI5Ny44LDczLjJjLTMuMiwwLTYsLjktOC40LDIuOC0yLjQsMS44LTQuNCw0LjItNi4xLDctMS42LDIuOC0yLjksNS45LTMuNyw5LjMtLjgsMy40LTEuMiw2LjUtMS4yLDkuNiwwLDUsLjgsOC44LDIuMywxMS40LDEuNSwyLjcsNC4zLDQsOC40LDRzNi0uOSw4LjQtMi44YzIuNC0xLjgsNC40LTQuMiw2LjEtNywxLjYtMi44LDIuOS01LjksMy43LTkuMy44LTMuNCwxLjItNi41LDEuMi05LjYsMC01LS44LTguOC0yLjMtMTEuNC0xLjUtMi43LTQuMy00LTguNC00WiIvPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0zNTcsMTMzLjZoLTIxLjRsMTgtNzYuN2gyMS41bC0xOC4yLDc2LjdoLjFaTTM2Ny40LDQ3LjVjLTMsMC01LjctLjktOC4xLTIuN3MtMy42LTQuNS0zLjYtOC4yLjQtNCwxLjItNS44Yy44LTEuOCwxLjktMy40LDMuMi00LjcsMS4zLTEuMywyLjktMi40LDQuNy0zLjEsMS44LS44LDMuNy0xLjIsNS43LTEuMiwzLDAsNS43LjksOC4xLDIuNywyLjQsMS44LDMuNiw0LjUsMy42LDguMnMtLjQsNC0xLjIsNS44Yy0uOCwxLjgtMS45LDMuNC0zLjIsNC43LTEuMywxLjMtMi45LDIuNC00LjcsMy4xLTEuOC44LTMuNywxLjItNS43LDEuMloiLz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMzkzLjksNjAuNGMxLjYtLjUsMy40LTEsNS40LTEuNywyLS42LDQuMi0xLjIsNi42LTEuNywyLjUtLjUsNS4yLTEsOC4yLTEuM3M2LjUtLjUsMTAuMy0uNWMxMS40LDAsMTkuMiwzLjMsMjMuNCw5LjksNC4yLDYuNiw1LDE1LjcsMi4yLDI3LjFsLTkuOCw0MS40aC0yMS41bDkuNS00MC41Yy42LTIuNSwxLTUsMS40LTcuNC4zLTIuNC4zLTQuNSwwLTYuMy0uNC0xLjgtMS4zLTMuMy0yLjctNC40LTEuNC0xLjEtMy41LTEuNy02LjQtMS43cy01LjYuMy04LjUuOWwtMTQsNTkuM2gtMjEuNWwxNy41LTczLjJoLS4xWiIvPgogIDxwb2x5Z29uIGNsYXNzPSJzdDAiIHBvaW50cz0iNTc2LjQgODAuOSA1ODIuOCA1NCA1NjMuMSA1NCA1NTYuOCA4MC45IDUzNC4zIDgwLjkgNTMyLjcgODAuOSA1MTAuMSA4MC45IDUxNi41IDU0IDQ5Ni45IDU0IDQ5MC41IDgwLjkgNDY2LjQgODAuOSA0NjEuOSA5OS4yIDQ4NiA5OS4yIDQ3OS43IDEyNi4xIDQ5OS4zIDEyNi4xIDUwNS43IDk5LjIgNTI4LjIgOTkuMiA1MjkuOCA5OS4yIDU1Mi4zIDk5LjIgNTQ2IDEyNi4xIDU2NS42IDEyNi4xIDU3MS45IDk5LjIgNTk2IDk5LjIgNjAwLjUgODAuOSA1NzYuNCA4MC45Ii8+Cjwvc3ZnPg==",
    black:
      "data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyBpZD0iTGF5ZXJfMiIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB2ZXJzaW9uPSIxLjEiIHZpZXdCb3g9IjAgMCA2MDUuNiAxNTYiPgogIDwhLS0gR2VuZXJhdG9yOiBBZG9iZSBJbGx1c3RyYXRvciAzMC4xLjAsIFNWRyBFeHBvcnQgUGx1Zy1JbiAuIFNWRyBWZXJzaW9uOiAyLjEuMSBCdWlsZCAxMzYpICAtLT4KICA8ZGVmcz4KICAgIDxzdHlsZT4KICAgICAgLnN0MCB7CiAgICAgICAgZmlsbDogIzAwMDsKICAgICAgfQogICAgPC9zdHlsZT4KICA8L2RlZnM+CiAgPHBhdGggY2xhc3M9InN0MCIgZD0iTTU1LjQsNTUuM2M0LjYsMCw4LjYuOCwxMiwyLjVzNi4yLDMuOSw4LjQsNi43YzIuMiwyLjgsMy44LDYuMSw0LjksOS45LDEuMSwzLjgsMS42LDcuOSwxLjYsMTIuMiwwLDYuNy0xLjIsMTMtMy43LDE5cy01LjgsMTEuMi0xMCwxNS42LTkuMiw3LjktMTUsMTAuNS0xMiwzLjktMTguOCwzLjktMi40LDAtNC41LDAtNC42LS4zLTcuNC0uN2MtMi44LS40LTUuOC0xLTguOS0xLjgtMy4xLS44LTYuMS0xLjgtOC45LTMuMkwzMCwyMy45bDIyLjQtMy41LTksMzcuNmMxLjktLjksMy44LTEuNiw1LjgtMiwxLjktLjUsNC0uNyw2LjItLjdaTTM2LjYsMTE3LjdjMy40LDAsNi41LS44LDkuNS0yLjVzNS42LTMuOSw3LjctNi42LDMuOS01LjksNS4xLTkuNCwxLjktNy4xLDEuOS0xMC45LS44LTguMy0yLjMtMTAuOWMtMS41LTIuNi00LjQtMy45LTguNS0zLjlzLTMuMS4yLTUuMy43Yy0yLjIuNS00LjEsMS41LTUuOCwzLjFsLTkuNSw0MGMuNiwwLDEuMS4yLDEuNS4zLjQsMCwuOS4yLDEuNC4yaDQuMywwWiIvPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xMDkuNCwxMzMuNmgtMjEuNGwxOC03Ni43aDIxLjVsLTE4LjIsNzYuN2gwWk0xMTkuOCw0Ny41Yy0zLDAtNS43LS45LTguMS0yLjdzLTMuNi00LjUtMy42LTguMi40LTQsMS4yLTUuOGMuOC0xLjgsMS45LTMuNCwzLjItNC43LDEuMy0xLjMsMi45LTIuNCw0LjctMy4xLDEuOC0uOCwzLjctMS4yLDUuNy0xLjIsMywwLDUuNy45LDguMSwyLjcsMi40LDEuOCwzLjYsNC41LDMuNiw4LjJzLS40LDQtMS4yLDUuOC0xLjksMy40LTMuMiw0LjdjLTEuMywxLjMtMi45LDIuNC00LjcsMy4xLTEuOC44LTMuNywxLjItNS43LDEuMloiLz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTQ5LjUsMzcuOGwyMi40LTMuNS01LjUsMjIuNmgyNGwtNC4zLDE3LjhoLTIzLjhsLTYuNCwyNi44Yy0uNiwyLjItLjksNC4zLTEuMSw2LjMtLjEsMS45LDAsMy42LjcsNSwuNiwxLjQsMS43LDIuNSwzLjIsMy4zczMuNywxLjIsNi40LDEuMiw0LjUtLjIsNi43LS43LDQuNC0xLDYuNi0xLjhsMS42LDE2LjZjLTIuOSwxLjEtNiwyLTkuNCwyLjhzLTcuNCwxLjItMTIsMS4yYy02LjYsMC0xMS44LTEtMTUuNC0zLTMuNy0yLTYuMy00LjctNy44LTguMnMtMi4yLTcuNC0yLTExLjkuOS05LjIsMi0xNC4xYzAsMCwxNC4xLTYwLjQsMTQuMS02MC40WiIvPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0xOTEuMiwxMDIuOWMwLTYuNiwxLjEtMTIuOCwzLjItMTguNywyLjEtNS44LDUuMS0xMC45LDkuMS0xNS4zLDMuOS00LjQsOC43LTcuOCwxNC40LTEwLjQsNS42LTIuNSwxMS45LTMuOCwxOC44LTMuOHM4LjIuNCwxMS42LDEuMiw2LjUsMS45LDkuMywzLjNsLTcuNCwxNi45Yy0xLjktLjgtMy45LTEuNS02LTIuMXMtNC42LS45LTcuNi0uOWMtNy4yLDAtMTIuOSwyLjUtMTcsNy40cy02LjIsMTEuNi02LjIsMjAsMS4xLDksMy4yLDEyYzIuMSwzLjEsNiw0LjYsMTEuNyw0LjZzNS41LS4zLDguMS0uOSw0LjktMS4zLDYuOS0yLjJsMS42LDE3LjRjLTIuNywxLjEtNS43LDItOC45LDIuOHMtNy4xLDEuMi0xMS44LDEuMi0xMS0uOS0xNS4yLTIuNmMtNC4xLTEuNy03LjYtNC4xLTEwLjMtNy4xcy00LjYtNi40LTUuOC0xMC40LTEuOC04LjItMS44LTEyLjVoMFoiLz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMjg3LjEsMTM1LjZjLTUuMSwwLTkuNS0uOC0xMy4zLTIuMy0zLjgtMS42LTYuOS0zLjctOS4zLTYuNi0yLjUtMi44LTQuMy02LjEtNS42LTEwLTEuMy0zLjgtMS45LTguMS0xLjktMTIuOHMuOS0xMS43LDIuOC0xNy41LDQuNi0xMS4xLDguMy0xNS43YzMuNy00LjcsOC4xLTguNSwxMy40LTExLjQsNS4zLTMsMTEuNC00LjQsMTguMi00LjRzOS40LjgsMTMuMiwyLjNjMy44LDEuNiw2LjksMy43LDkuNCw2LjYsMi41LDIuOCw0LjMsNi4xLDUuNiwxMCwxLjIsMy44LDEuOSw4LjEsMS45LDEyLjhzLS45LDExLjctMi43LDE3LjVjLTEuOCw1LjgtNC41LDExLjEtOC4xLDE1LjctMy42LDQuNy04LDguNS0xMy40LDExLjQtNS4zLDMtMTEuNSw0LjQtMTguNiw0LjRoLjFaTTI5Ny44LDczLjJjLTMuMiwwLTYsLjktOC40LDIuOC0yLjQsMS44LTQuNCw0LjItNi4xLDctMS42LDIuOC0yLjksNS45LTMuNyw5LjMtLjgsMy40LTEuMiw2LjUtMS4yLDkuNiwwLDUsLjgsOC44LDIuMywxMS40LDEuNSwyLjcsNC4zLDQsOC40LDRzNi0uOSw4LjQtMi44YzIuNC0xLjgsNC40LTQuMiw2LjEtNywxLjYtMi44LDIuOS01LjksMy43LTkuMy44LTMuNCwxLjItNi41LDEuMi05LjYsMC01LS44LTguOC0yLjMtMTEuNC0xLjUtMi43LTQuMy00LTguNC00WiIvPgogIDxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik0zNTcsMTMzLjZoLTIxLjRsMTgtNzYuN2gyMS41bC0xOC4yLDc2LjdoLjFaTTM2Ny40LDQ3LjVjLTMsMC01LjctLjktOC4xLTIuN3MtMy42LTQuNS0zLjYtOC4yLjQtNCwxLjItNS44Yy44LTEuOCwxLjktMy40LDMuMi00LjcsMS4zLTEuMywyLjktMi40LDQuNy0zLjEsMS44LS44LDMuNy0xLjIsNS43LTEuMiwzLDAsNS43LjksOC4xLDIuNywyLjQsMS44LDMuNiw0LjUsMy42LDguMnMtLjQsNC0xLjIsNS44Yy0uOCwxLjgtMS45LDMuNC0zLjIsNC43LTEuMywxLjMtMi45LDIuNC00LjcsMy4xLTEuOC44LTMuNywxLjItNS43LDEuMloiLz4KICA8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMzkzLjksNjAuNGMxLjYtLjUsMy40LTEsNS40LTEuNywyLS42LDQuMi0xLjIsNi42LTEuNywyLjUtLjUsNS4yLTEsOC4yLTEuM3M2LjUtLjUsMTAuMy0uNWMxMS40LDAsMTkuMiwzLjMsMjMuNCw5LjksNC4yLDYuNiw1LDE1LjcsMi4yLDI3LjFsLTkuOCw0MS40aC0yMS41bDkuNS00MC41Yy42LTIuNSwxLTUsMS40LTcuNC4zLTIuNC4zLTQuNSwwLTYuMy0uNC0xLjgtMS4zLTMuMy0yLjctNC40LTEuNC0xLjEtMy41LTEuNy02LjQtMS43cy01LjYuMy04LjUuOWwtMTQsNTkuM2gtMjEuNWwxNy41LTczLjJoLS4xWiIvPgogIDxwb2x5Z29uIGNsYXNzPSJzdDAiIHBvaW50cz0iNTc2LjQgODAuOSA1ODIuOCA1NCA1NjMuMSA1NCA1NTYuOCA4MC45IDUzNC4zIDgwLjkgNTMyLjcgODAuOSA1MTAuMSA4MC45IDUxNi41IDU0IDQ5Ni45IDU0IDQ5MC41IDgwLjkgNDY2LjQgODAuOSA0NjEuOSA5OS4yIDQ4NiA5OS4yIDQ3OS43IDEyNi4xIDQ5OS4zIDEyNi4xIDUwNS43IDk5LjIgNTI4LjIgOTkuMiA1MjkuOCA5OS4yIDU1Mi4zIDk5LjIgNTQ2IDEyNi4xIDU2NS42IDEyNi4xIDU3MS45IDk5LjIgNTk2IDk5LjIgNjAwLjUgODAuOSA1NzYuNCA4MC45Ii8+Cjwvc3ZnPg==",
  };
  function upgradeWordmarks(d, measure) {
    let changed = false;
    walk(d.nodes, (n) => {
      if (
        n.kind !== "text" ||
        n.font !== "BannerBrand" ||
        n.text.trim().toLowerCase() !== "bitcoin++"
      )
        return;
      const b = measure(n);
      if (!b?.width || !b?.height) return;
      const variant = n.color?.toLowerCase() === "#000000" ? "black" : "white";
      const asset = "btcpp-logo-" + variant;
      const width = b.width,
        height = (width * 156) / 605.6;
      const dx = b.x,
        dy = b.y + (b.height - height) / 2;
      const angle = (n.rotation * Math.PI) / 180;
      n.x += n.scale * (dx * Math.cos(angle) - dy * Math.sin(angle));
      n.y += n.scale * (dx * Math.sin(angle) + dy * Math.cos(angle));
      Object.assign(n, {
        kind: "image",
        name: "bitcoin++",
        asset,
        width,
        height,
      });
      delete n.text;
      delete n.font;
      delete n.fontSize;
      d.assets[asset] = brandArtwork[variant];
      changed = true;
    });
    return changed;
  }
  const element = (tag, attrs = {}, text) => {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  let sceneSerial = 0;
  function mount(host, d, fontURLs = {}) {
    const effectPrefix = `effect-${++sceneSerial}-`;
    const svg = element("svg", {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: `${-d.page.bleed} ${-d.page.bleed} ${d.page.width + 2 * d.page.bleed} ${d.page.height + 2 * d.page.bleed}`,
      width: d.page.width + 2 * d.page.bleed,
      height: d.page.height + 2 * d.page.bleed,
    });
    host.replaceChildren(svg);
    const images = new Map(),
      nodes = new Map(),
      loadedSources = new Map();
    let missing = [];
    const fontFiles = {
      BannerMono: "CourierPrime-Regular.ttf",
      BannerBrand: "Ubuntu-BoldItalic.ttf",
      BannerMarker: "PermanentMarker-Regular.ttf",
      OverlayAeonik: "AeonikTRIAL-Regular.otf",
    };
    async function ready() {
      missing = [];
      const fonts = [
        ...new Set(
          all(d)
            .filter((n) => n.kind === "text")
            .map((n) => n.font),
        ),
      ];
      await Promise.all(
        fonts.map(async (name) => {
          try {
            const f = new FontFace(
              name,
              `url("${fontURLs[name] || "/static/fonts/" + fontFiles[name]}")`,
            );
            document.fonts.add(await f.load());
          } catch (e) {
            missing.push("Font: " + name);
          }
        }),
      );
      if (!missing.length)
        upgradeWordmarks(d, (n) => {
          const text = element(
            "text",
            { "font-family": n.font, "font-size": n.fontSize },
            n.text,
          );
          svg.append(text);
          const b = text.getBBox();
          text.remove();
          return b;
        });
      const used = new Set(
        [
          d.background.asset,
          ...all(d)
            .filter((n) => n.kind === "image")
            .map((n) => n.asset),
        ].filter(Boolean),
      );
      await Promise.all(
        [...used].map(async (id) => {
          if (images.has(id) && loadedSources.get(id) === d.assets[id]) return;
          try {
            const img = new Image();
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(Error("Timed out")), 15000);
              img.onload = () => {
                clearTimeout(timer);
                resolve();
              };
              img.onerror = () => {
                clearTimeout(timer);
                reject(Error("Unavailable"));
              };
              img.src = d.assets[id];
            });
            if (!img.naturalWidth) throw Error();
            images.set(id, img);
            loadedSources.set(id, d.assets[id]);
          } catch (e) {
            missing.push(
              all(d).find((n) => n.asset === id)?.name || "Background",
            );
          }
        }),
      );

      build();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return missing;
    }
    function ratio(n) {
      const img = images.get(n.asset);
      const b = d.artworkBounds?.[n.asset];
      return img
        ? (img.naturalWidth / img.naturalHeight) * (b ? b.width / b.height : 1)
        : 3;
    }
    function measureArtwork() {
      const bounds = { ...(d.artworkBounds || {}) };
      const sponsors = all(d).filter(
        (n) =>
          n.kind === "image" &&
          (n.binding?.sponsor || n.binding?.field === "sponsor"),
      );
      for (const n of sponsors) {
        if (bounds[n.asset]) continue;
        const img = images.get(n.asset);
        if (!img) throw Error("Artwork unavailable: " + n.name);
        const factor = Math.min(
          1,
          768 / Math.max(img.naturalWidth, img.naturalHeight),
        );
        const width = Math.max(1, Math.round(img.naturalWidth * factor));
        const height = Math.max(1, Math.round(img.naturalHeight * factor));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, width, height);
        let pixels;
        try {
          pixels = ctx.getImageData(0, 0, width, height).data;
        } catch {
          throw Error("Unable to measure original artwork: " + n.name);
        }
        bounds[n.asset] = visibleBounds(pixels, width, height);
        if (!bounds[n.asset]) throw Error("No visible artwork: " + n.name);
      }
      d.artworkBounds = bounds;
    }
    function build() {
      nodes.clear();
      svg.replaceChildren();
      const defs = element("defs");
      svg.append(defs);
      const b = d.page.bleed,
        p = d.page;
      if (d.background.color !== "transparent")
        svg.append(
          element("rect", {
            x: -b,
            y: -b,
            width: p.width + 2 * b,
            height: p.height + 2 * b,
            fill: d.background.color,
          }),
        );
      if (d.background.asset) {
        const img = images.get(d.background.asset),
          box = backgroundBox(
            d,
            img ? img.naturalWidth / img.naturalHeight : 1,
          );
        const crop = element("svg", {
          x: -b,
          y: -b,
          width: p.width + 2 * b,
          height: p.height + 2 * b,
          viewBox: `${-b} ${-b} ${p.width + 2 * b} ${p.height + 2 * b}`,
          overflow: "hidden",
        });
        crop.append(
          element("image", {
            ...box,
            href: d.assets[d.background.asset],
            preserveAspectRatio: "none",
          }),
        );
        svg.append(crop);
      }
      if (d.background.darkness)
        svg.append(
          element("rect", {
            x: -b,
            y: -b,
            width: p.width + 2 * b,
            height: p.height + 2 * b,
            fill: "#000",
            opacity: d.background.darkness,
          }),
        );
      function add(n, parent) {
        const g = element("g", { "data-node": n.id });
        nodes.set(n.id, g);
        parent.append(g);
        if (n.kind === "group") {
          for (const child of n.children || []) add(child, g);
        } else if (n.kind === "image") {
          const b = d.artworkBounds?.[n.asset],
            img = images.get(n.asset);
          if (b && img) {
            const crop = element("svg", {
              width: n.width,
              height: n.height,
              viewBox: `${b.x * img.naturalWidth} ${b.y * img.naturalHeight} ${b.width * img.naturalWidth} ${b.height * img.naturalHeight}`,
              preserveAspectRatio: (n.fit || "xMidYMid") + " meet",
              overflow: "hidden",
            });
            crop.append(
              element("image", {
                width: img.naturalWidth,
                height: img.naturalHeight,
                href: d.assets[n.asset],
              }),
            );
            g.append(crop);
          } else
            g.append(
              element("image", {
                width: n.width,
                height: n.height,
                href: d.assets[n.asset],
                preserveAspectRatio: (n.fit || "xMidYMid") + " meet",
              }),
            );
        } else {
          const t = element("text", {
            "font-family": n.font,
            "font-size": n.fontSize,
            fill: n.color,
            "xml:space": "preserve",
            style: "white-space:pre",
          });
          (n.text || "").split("\n").forEach((line, i) => {
            t.append(
              element("tspan", { x: 0, y: i * n.fontSize * 1.18 }, line),
            );
          });
          g.append(t);
        }
        if (n.greyscale || n.brightness !== 1 || n.white) {
          const filterID = effectPrefix + n.id,
            bounds = g.getBBox();
          const filter = element("filter", {
            id: filterID,
            filterUnits: "userSpaceOnUse",
            x: bounds.x - 2,
            y: bounds.y - 2,
            width: bounds.width + 4,
            height: bounds.height + 4,
            "color-interpolation-filters": "sRGB",
          });
          if (n.white)
            filter.append(
              element("feColorMatrix", {
                type: "matrix",
                values: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0",
              }),
            );
          filter.append(
            element("feColorMatrix", {
              type: "saturate",
              values: 1 - n.greyscale,
            }),
          );
          const transfer = element("feComponentTransfer");
          for (const channel of ["R", "G", "B"])
            transfer.append(
              element("feFunc" + channel, {
                type: "linear",
                slope: n.brightness,
              }),
            );
          filter.append(transfer);
          defs.append(filter);
          g.setAttribute("filter", `url(#${filterID})`);
        }
      }
      d.nodes.forEach((n) => add(n, svg));
      render(null);
    }
    function render(time = null) {
      walk(d.nodes, (n) => {
        const g = nodes.get(n.id);
        if (!g) return;
        const a = pose(time, n.animation);
        g.setAttribute(
          "transform",
          `translate(${n.x} ${n.y + a.y}) rotate(${n.rotation}) scale(${n.scale})`,
        );
        g.setAttribute("opacity", n.opacity * a.opacity);
        g.setAttribute("display", n.hidden ? "none" : "inline");
      });
    }
    function box(id) {
      const g = nodes.get(id);
      if (!g) return null;
      const n = all(d).find((n) => n.id === id);
      if (n.kind === "group") {
        const boxes = (n.children || [])
          .filter((c) => !c.hidden)
          .map((c) => box(c.id))
          .filter(Boolean);
        if (boxes.length) {
          const x = Math.min(...boxes.map((b) => b.x)),
            y = Math.min(...boxes.map((b) => b.y));
          return {
            x,
            y,
            width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
            height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
          };
        }
      }
      let b =
        n.kind === "image"
          ? { x: 0, y: 0, width: n.width, height: n.height }
          : g.getBBox();
      if (!b.width || !b.height) b = { x: 0, y: -12, width: 24, height: 24 };
      const m = svg.getCTM().inverse().multiply(g.getCTM());
      const pts = [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x, b.y + b.height],
        [b.x + b.width, b.y + b.height],
      ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
      const xs = pts.map((p) => p.x),
        ys = pts.map((p) => p.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    }
    return {
      svg,
      ready,
      build,
      render,
      box,
      ratio,
      measureArtwork,
      backgroundBox: () => {
        const img = images.get(d.background.asset);
        return backgroundBox(d, img ? img.naturalWidth / img.naturalHeight : 1);
      },
      get missing() {
        return missing;
      },
      node: (id) => nodes.get(id),
    };
  }
  const type = (d) =>
    d.kind === "print"
      ? "graphic"
      : d.kind ||
        { banner: "graphic", overlay: "graphic", reel: "video" }[d.template];
  const unitFactor = (unit) => ({ px: 1, mm: 96 / 25.4, in: 96 })[unit];
  function configure(source, page, kind, duration) {
    const d = clone(source),
      f = unitFactor(d.page.unit) / unitFactor(page.unit);
    walk(d.nodes, (n) => {
      for (const key of ["x", "y", "width", "height", "fontSize"])
        if (n[key] !== undefined) n[key] *= f;
      if (n.animation) n.animation.rise *= f;
    });
    d.background.x = (d.background.x || 0) * f;
    d.background.y = (d.background.y || 0) * f;
    d.page = clone(page);
    d.kind = kind;
    if (kind === "video") d.duration = duration || d.duration || 5;
    return d;
  }
  function backgroundBox(d, ratio = 1) {
    const p = d.page,
      b = p.bleed || 0,
      w = p.width + 2 * b,
      h = p.height + 2 * b,
      z = Math.max(1, d.background.zoom || 1);
    const iw = Math.max(w, h * ratio) * z,
      ih = iw / ratio,
      overflowX = Math.max(0, (iw - w) / 2),
      overflowY = Math.max(0, (ih - h) / 2);
    const dx = Math.max(-overflowX, Math.min(overflowX, d.background.x || 0));
    const dy = Math.max(-overflowY, Math.min(overflowY, d.background.y || 0));
    return {
      x: -b + (w - iw) / 2 + dx,
      y: -b + (h - ih) / 2 + dy,
      width: iw,
      height: ih,
    };
  }
  const api = {
    clone,
    type,
    unitFactor,
    configure,
    backgroundBox,
    walk,
    all,
    item,
    pose,
    history,
    arrange,
    fitLogos,
    visibleBounds,
    layoutWarnings,
    element,
    upgradeWordmarks,
    brandArtwork,
    mount,
  };
  if (typeof module !== "undefined") module.exports = api;
  else window.StudioScene = api;
})();
