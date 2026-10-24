const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  S = require("./scene.js");
const image = (id, sponsor) => ({
  id,
  kind: "image",
  name: id,
  x: 1,
  y: 2,
  width: 30,
  height: 10,
  scale: 1,
  asset: id,
  binding: sponsor ? { sponsor } : undefined,
});
const group = (id, children) => ({
  id,
  kind: "group",
  name: id,
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  binding: { tier: id },
  children,
});
const doc = (nodes) => ({
  template: "reel",
  duration: 5,
  assets: {},
  background: { bound: true, asset: "old" },
  nodes,
});
test("history groups edits and clears redo after branching", () => {
  const h = S.history({ x: 0 });
  h.push({ x: 1 });
  h.push({ x: 2 });
  assert.deepEqual(h.undo(), { x: 1 });
  assert.deepEqual(h.redo(), { x: 2 });
  h.undo();
  h.push({ x: 3 });
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.undo(), { x: 1 });
});
test("animation is deterministic with one second at both ends", () => {
  const a = { start: 1, end: 4, fade: 0.45, rise: 60 };
  assert.equal(S.pose(0, a).opacity, 0);
  assert.equal(S.pose(1, a).opacity, 0);
  assert.equal(S.pose(2, a).opacity, 1);
  assert.equal(S.pose(4, a).opacity, 0);
  assert.deepEqual(S.pose(null, a), { opacity: 1, y: 0 });
});
test("absent title uses no vertical space and partial regular rows are centered", () => {
  const d = doc(
    ["headline", "workshop", "silver", "regular"].map((id, i) =>
      group(
        id,
        Array.from({ length: i === 3 ? 8 : 2 }, (_, j) =>
          image(id + j, "org" + j),
        ),
      ),
    ),
  );
  S.arrange(d, () => 3);
  const logos = d.nodes[3].children;
  const rows = new Map();
  for (const n of logos) {
    const y = n.y.toFixed(5);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(n);
  }
  for (const row of rows.values()) {
    const left = Math.min(...row.map((n) => n.x)),
      right = Math.max(...row.map((n) => n.x + n.width));
    assert(Math.abs((left + right) / 2 - 960) < 0.001);
  }
  assert(logos.every((n) => n.y + n.height <= 980));
  assert.equal(d.needsArrange, false);
});

test("arranging a legacy row reel restores five-tier hierarchy without losing originals", () => {
  const labels = [
    "HEADLINE SPONSORS",
    "TITLE SPONSORS",
    "WORKSHOP SPONSORS",
    "HACKATHON SPONSORS",
    "SILVER SPONSORS",
    "SILVER SPONSORS",
    "SPONSORS",
    "SPONSORS",
    "SPONSORS",
    "MEDIA SPONSORS",
  ];
  const rows = labels.map((label, i) => {
    const n = group(
      "legacy-" + i,
      Array.from({ length: [2, 1, 1, 1, 2, 1, 2, 2, 1, 2][i] }, (_, j) =>
        image(`logo-${i}-${j}`, `org-${i}-${j}`),
      ),
    );
    n.name = label;
    n.animation = { start: 1 + i * 0.6, end: 7.8, fade: 0.45, rise: 60 };
    return n;
  });
  const d = doc(rows);
  d.duration = 8.8;
  d.nodes.push({ id: "custom-caption", kind: "text", text: "Custom caption" });
  const original = S.clone(d),
    h = S.history(d);
  S.arrange(d, () => 3);
  h.push(d);
  const tiers = d.nodes.filter((n) => n.binding?.tier && !n.hidden);
  assert.deepEqual(
    tiers.map((n) => n.binding.tier),
    ["headline", "title", "workshop", "silver", "regular"],
  );
  assert.deepEqual(
    tiers.map((n) => n.children.length),
    [2, 1, 2, 3, 5],
  );
  const heights = tiers.map((n) => n.children[0].height);
  assert(
    heights.every((h, i) => !i || h < heights[i - 1]),
    String(heights),
  );
  assert.equal(d.duration, 8.8);
  assert.equal(tiers[0].animation.start, 1);
  assert.equal(tiers[2].animation.start, 2.2);
  assert.equal(S.all(d).find((n) => n.id === "logo-0-0").asset, "logo-0-0");
  assert(d.nodes.find((n) => n.name === "MEDIA SPONSORS").hidden);
  assert.equal(
    d.nodes.find((n) => n.id === "custom-caption").text,
    "Custom caption",
  );
  const arranged = S.clone(d);
  S.arrange(d, () => 3);
  assert.deepEqual(d, arranged);
  assert.deepEqual(h.undo(), original);
});

test("reel tier placement follows sponsorship priority rather than layer order", () => {
  const d = doc(
    ["regular", "silver", "workshop", "title", "headline"].map((tier) =>
      group(tier, [image(tier, "org-" + tier)]),
    ),
  );
  S.arrange(d, () => 3);
  const y = (tier) =>
    d.nodes.find((n) => n.binding.tier === tier).children[0].y;
  assert(
    y("headline") < y("title") &&
      y("title") < y("workshop") &&
      y("workshop") < y("silver") &&
      y("silver") < y("regular"),
  );
});

test("wordmarks become original vector objects while retaining transforms and identity", () => {
  const n = {
    ...S.item("text", "Wordmark"),
    id: "brand",
    font: "BannerBrand",
    text: "bitcoin++",
    color: "#ffffff",
    x: 100,
    y: 200,
    scale: 2,
    rotation: 90,
  };
  const d = { nodes: [n], assets: {} };
  const box = { x: 1, y: -50, width: 240, height: 60 };
  assert.equal(
    S.upgradeWordmarks(d, () => box),
    true,
  );
  assert.equal(n.kind, "image");
  assert.equal(n.id, "brand");
  assert.equal(n.asset, "btcpp-logo-white");
  assert.equal(n.width, 240);
  assert.equal(n.rotation, 90);
  assert.equal(n.scale, 2);
  assert.equal(n.text, undefined);
  assert.ok(Math.abs(n.y - 202) < 0.001);
  assert.equal(d.assets[n.asset], S.brandArtwork.white);
  assert.equal(
    S.upgradeWordmarks(d, () => {
      throw Error("should not measure twice");
    }),
    false,
  );
  const black = {
    ...S.item("text", "Wordmark"),
    font: "BannerBrand",
    text: "BITCOIN++",
    color: "#000000",
  };
  const other = {
    ...S.item("text", "Custom text"),
    text: "bitcoin++",
    font: "BannerMono",
  };
  d.nodes.push(black, other);
  S.upgradeWordmarks(d, () => box);
  assert.equal(black.asset, "btcpp-logo-black");
  assert.equal(other.kind, "text");
});
test("embedded logos exactly match the supplied SVG assets and have connected plus artwork", () => {
  const fs = require("node:fs"),
    path = require("node:path");
  for (const variant of ["white", "black"]) {
    const svg = Buffer.from(
      S.brandArtwork[variant].split(",")[1],
      "base64",
    ).toString();
    assert.equal(
      svg,
      fs.readFileSync(
        path.join(__dirname, "../../static/img/btcpp-logo-" + variant + ".svg"),
        "utf8",
      ),
    );
    assert.equal((svg.match(/<polygon/g) || []).length, 1);
    assert.ok(!svg.includes("<text"));
  }
});

test("adaptive fitting covers square, tall, wide, and crowded tiers without overlap", () => {
  for (const count of [0, 1, 2, 5, 17, 60, 120])
    for (const shape of [() => 3, () => 1, (n) => [0.25, 1, 3, 9][n.i % 4]]) {
      const logos = Array.from({ length: count }, (_, i) => ({ i }));
      const area = { x: 100, y: 60, width: 1320, height: 300 };
      const boxes = S.fitLogos(logos, area, shape, { gap: 24, maxHeight: 180 });
      assert.equal(boxes.length, count);
      assert.deepEqual(
        boxes,
        S.fitLogos(logos, area, shape, { gap: 24, maxHeight: 180 }),
      );
      boxes.forEach((b, i) => {
        assert(b.width > 0 && b.height > 0);
        assert(
          b.x >= area.x - 0.001 &&
            b.y >= area.y - 0.001 &&
            b.x + b.width <= area.x + area.width + 0.001 &&
            b.y + b.height <= area.y + area.height + 0.001,
        );
        for (const a of boxes.slice(i + 1))
          assert(
            b.x + b.width <= a.x + 0.001 ||
              a.x + a.width <= b.x + 0.001 ||
              b.y + b.height <= a.y + 0.001 ||
              a.y + a.height <= b.y + 0.001,
          );
      });
    }
});
test("measurement trims transparent padding and retains opaque images", () => {
  const pixels = new Uint8ClampedArray(100 * 100 * 4);
  for (let y = 30; y < 70; y++)
    for (let x = 10; x < 90; x++) pixels[(y * 100 + x) * 4 + 3] = 255;
  assert.deepEqual(S.visibleBounds(pixels, 100, 100), {
    x: 0.09,
    y: 0.29,
    width: 0.82,
    height: 0.42,
  });
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  assert.deepEqual(S.visibleBounds(pixels, 100, 100), {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  pixels.fill(0);
  assert.equal(S.visibleBounds(pixels, 100, 100), null);
});
test("crowding identifies affected tiers and never drops sponsors", () => {
  const d = doc([
    group("headline", [image("a", "a")]),
    group(
      "regular",
      Array.from({ length: 120 }, (_, i) => image("l" + i, "org" + i)),
    ),
  ]);
  d.page = { unit: "px" };
  d.nodes.forEach((n) => {
    n.name = n.id;
    n.scale = 1;
  });
  S.arrange(d, () => 3);
  assert.equal(d.nodes[1].children.length, 120);
  assert(S.layoutWarnings(d).includes("regular"));
});
test("size and spacing affect explicit generation, while empty banner tiers take no room", () => {
  const d = {
    ...doc([
      group("headline", [image("a", "a"), image("b", "b")]),
      group("silver", []),
    ]),
    template: "banner",
    page: { unit: "mm" },
  };
  d.nodes.push({
    id: "heading",
    kind: "text",
    binding: { field: "tier-heading:silver" },
    x: 20,
    y: 30,
  });
  const original = S.clone(d);
  S.arrange(d, () => 3);
  assert(d.nodes[2].hidden);
  const large = d.nodes[0].children[0].width;
  const small = S.clone(original);
  small.generation = { size: 0.7, spacing: 1.5 };
  S.arrange(small, () => 3);
  assert(small.nodes[0].children[0].width < large);
  assert.equal(original.nodes[0].children[0].width, 30);
});

test("generation fits in page coordinates even after a whole tier was transformed", () => {
  const reference = doc([group("headline", [image("logo", "org")])]);
  const transformed = S.clone(reference);
  Object.assign(transformed.nodes[0], {
    x: 80,
    y: 100,
    scale: 1.6,
    rotation: 30,
  });
  S.arrange(reference, () => 3);
  S.arrange(transformed, () => 3);
  const a = reference.nodes[0].children[0],
    b = transformed.nodes[0].children[0];
  const r = Math.PI / 6,
    c = Math.cos(r) * 1.6,
    s = Math.sin(r) * 1.6;
  assert(Math.abs(80 + c * b.x - s * b.y - a.x) < 0.001);
  assert(Math.abs(100 + s * b.x + c * b.y - a.y) < 0.001);
  assert(Math.abs(b.width * 1.6 - a.width) < 0.001);
  assert(Math.abs(b.rotation + 30) < 0.001);
  assert.equal(transformed.nodes[0].scale, 1.6);
});

test("reel hierarchy follows the final bucket reference rather than equalizing every logo", () => {
  // Measured against berlin26/recordings/assets/berlin26-sponsor-short.mp4,
  // fully revealed at 3.4 s. Aspect ratios and padding are from the originals.
  const shapes = {
    headline: [
      [3.53, 0.8182, 0.9533],
      [3.512, 0.8913, 0.96],
    ],
    title: [[3.9474, 1, 1]],
    workshop: [
      [3.76, 1, 1],
      [3.952, 0.9043, 0.974],
    ],
    silver: [
      [5.407, 0.871, 0.9733],
      [3.667, 1, 1],
      [4.965, 1, 0.9916],
    ],
    regular: [
      [5.076, 0.46, 0.9121],
      [3.947, 1, 0.9867],
      [7.475, 1, 0.9967],
      [1, 1, 1],
      [2.913, 1, 1],
    ],
  };
  const d = doc(
    Object.entries(shapes).map(([tier, ratios]) =>
      group(
        tier,
        ratios.map(([r], i) => ({
          ...image(tier + i, "org" + tier + i),
          aspect: r,
        })),
      ),
    ),
  );
  d.page = { unit: "px" };
  d.artworkBounds = {};
  d.nodes.forEach((g) =>
    g.children.forEach((n, i) => {
      const [, height, width] = shapes[g.id][i];
      d.artworkBounds[n.asset] = { x: 0, y: 0, width, height };
    }),
  );
  S.arrange(d, (n) => n.aspect);
  const [head, title, workshop, silver, regular] = d.nodes.map(
    (g) => g.children,
  );
  assert(
    head.every(
      (n) => n.width > 500 && n.width < 600 && n.height > 140 && n.height < 170,
    ),
  );
  assert(Math.abs(title[0].width - 510) < 15);
  assert(
    workshop.every(
      (n) => n.width > 420 && n.width < 490 && n.height > 100 && n.height < 125,
    ),
  );
  assert(silver.every((n) => n.width > 300 && n.width < 400));
  assert(
    regular[0].width > 130 && regular[0].width < 155,
    "padded Base58 must remain a small mark",
  );
  assert(
    regular[2].width > 360 && regular[2].width < 400,
    "wide wordmarks retain their width",
  );
  assert(
    regular[3].width < 65 && regular[4].width < 185,
    "compact bottom-row marks stay subordinate",
  );
  const centers = [head, title, workshop, silver].map(
    (ns) => ns.reduce((s, n) => s + n.y + n.height / 2, 0) / ns.length,
  );
  [211, 425, 600, 750].forEach((expected, i) =>
    assert(Math.abs(centers[i] - expected) < 15),
  );
  assert.deepEqual(S.layoutWarnings(d), []);
});

test("generation excludes unchecked logos and tiers, restores headings, and supports no sponsors", () => {
  const a = image("a", "org-a"),
    b = image("b", "org-b"),
    c = image("c", "org-c");
  b.hidden = true;
  const headline = group("headline", [a, b]),
    silver = group("silver", [c]);
  silver.hidden = true;
  const heading = {
    id: "heading",
    kind: "text",
    binding: { field: "tier-heading:silver" },
    x: 0,
    y: 0,
  };
  const d = doc([headline, silver, heading]);
  d.template = "banner";
  const beforeB = S.clone(b),
    beforeC = S.clone(c);
  S.arrange(d, () => 3);
  assert.deepEqual(b, beforeB, "excluded artwork keeps its manual placement");
  assert.deepEqual(c, beforeC, "excluded tier keeps its artwork");
  assert.equal(heading.hidden, true);
  assert.equal(
    a.x,
    290 + (480 - a.width) / 2,
    "single included logo is centered",
  );
  silver.hidden = false;
  S.arrange(d, () => 3);
  assert.equal(heading.hidden, false);
  a.hidden = true;
  c.hidden = true;
  S.arrange(d, () => 3);
  assert.equal(heading.hidden, true);
  assert.deepEqual(S.layoutWarnings(d), []);
});

test("extra legacy reel tiers default off but can subsequently be included explicitly", () => {
  const media = group("legacy-9", [image("podcast", "org-media")]);
  media.name = "Media sponsors";
  const d = doc([group("regular", [image("regular", "org-regular")]), media]);
  S.arrange(d, () => 3);
  assert.equal(media.hidden, true);
  assert.equal(media.binding.tier, "media");
  media.hidden = false;
  S.arrange(d, () => 3);
  assert.equal(media.hidden, false);
  assert.ok(media.children[0].y > 110);
});

test("document setup converts geometry and background units without discarding timing or identity", () => {
  const d = doc([group("headline", [image("logo", "org")])]);
  d.page = { width: 1920, height: 1080, unit: "px", bleed: 0 };
  d.nodes[0].animation = { start: 1, end: 4, fade: 0.4, rise: 60 };
  d.background.x = 96;
  const physical = S.configure(
    d,
    { width: 508, height: 285.75, unit: "mm", bleed: 0 },
    "print",
    5,
  );
  assert.equal(physical.template, "reel");
  assert.equal(physical.kind, "print");
  assert.equal(physical.duration, 5);
  assert.ok(Math.abs(physical.background.x - 25.4) < 1e-8);
  const roundtrip = S.configure(physical, d.page, "video", 5);
  assert.ok(Math.abs(roundtrip.nodes[0].children[0].width - 30) < 1e-8);
  assert.equal(roundtrip.nodes[0].animation.end, d.nodes[0].animation.end);
  assert.ok(Math.abs(roundtrip.nodes[0].animation.rise - 60) < 1e-8);
  assert.equal(d.page.unit, "px");
});
test("background framing covers and clips the page while zooming and clamping pan", () => {
  const d = { page: { width: 1920, height: 1080, bleed: 0 }, background: {} };
  assert.deepEqual(S.backgroundBox(d, 2), {
    x: -120,
    y: 0,
    width: 2160,
    height: 1080,
  });
  d.background = { zoom: 2, x: 100000, y: -100000 };
  const b = S.backgroundBox(d, 2);
  assert.equal(b.x, 0);
  assert.equal(b.y, -1080);
  assert.equal(b.width, 4320);
  assert.equal(b.height, 2160);
});
test("reference banner uses a corner title sponsor, stacked lead logos and no tier headings", () => {
  const headline = group("Headline", [
    image("hrf", "hrf"),
    image("nydig", "nydig"),
  ]);
  headline.weight = 1.8;
  const title = group("Title", [image("title", "title")]);
  const heading = {
    id: "heading",
    kind: "text",
    binding: { field: "tier-heading:Headline" },
  };
  const d = doc([headline, title, heading]);
  d.template = "banner";
  d.generation = {
    size: 1,
    spacing: 1,
    noHeadings: true,
    bannerReference: true,
  };
  S.arrange(d, () => 3);
  assert.equal(heading.hidden, true);
  assert.ok(title.children[0].x >= 570 && title.children[0].y >= 125);
  assert.ok(headline.children[1].y > headline.children[0].y);
  assert(
    headline.children.every((n) => n.y + n.height <= 1590),
    "sponsors must leave room for the footer and roll-up margin",
  );
});

test("crowding warnings are invariant when a print layout changes units", () => {
  const d = doc([group("headline", [image("logo", "org")])]);
  d.template = "banner";
  d.page = { width: 850, height: 2030, unit: "mm", bleed: 3 };
  d.nodes[0].children[0].width = 100;
  d.nodes[0].children[0].height = 30;
  const converted = S.configure(
    d,
    { width: 850 / 25.4, height: 2030 / 25.4, unit: "in", bleed: 3 / 25.4 },
    "print",
    0,
  );
  assert.deepEqual(S.layoutWarnings(d), []);
  assert.deepEqual(S.layoutWarnings(converted), []);
});

test("legacy print documents use graphic controls and export choices", () => {
  assert.equal(S.type({ template: "banner" }), "graphic");
  assert.equal(S.type({ template: "banner", kind: "print" }), "graphic");
  assert.equal(S.type({ template: "reel", kind: "graphic" }), "graphic");
});
test("background stays covered for tall/wide images, extreme pan, zoom and legacy fit", () => {
  for (const bleed of [0, 3])
    for (const ratio of [0.1, 0.5, 1, 2, 10])
      for (const zoom of [0.5, 1, 2, 8])
        for (const x of [-10000, 0, 10000])
          for (const y of [-10000, 0, 10000]) {
            const d = {
              page: { width: 200, height: 100, bleed },
              background: { fit: "fit", zoom, x, y },
            };
            const box = S.backgroundBox(d, ratio),
              epsilon = 1e-8;
            assert.ok(box.x <= -bleed + epsilon);
            assert.ok(box.y <= -bleed + epsilon);
            assert.ok(box.x + box.width >= 200 + bleed - epsilon);
            assert.ok(box.y + box.height >= 100 + bleed - epsilon);
          }
});
