import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ui = new URL("../src/ui/", import.meta.url);
const html = readFileSync(new URL("index.html", ui), "utf8");
const styles = readFileSync(new URL("styles.css", ui), "utf8") + readFileSync(new URL("museum.css", ui), "utf8");
const tokens = readFileSync(new URL("tokens.css", ui), "utf8");
const palettes = [...tokens.matchAll(/\{([^{}]*--surface-canvas:[^{}]*)\}/g)].map(match =>
  Object.fromEntries([...match[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()])));

type RGB = [number, number, number];
function rgb(hex: string): RGB {
  assert.match(hex, /^#[a-f\d]{6}([a-f\d]{2})?$/i);
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as RGB;
}
function luminance(channels: RGB): number {
  const linear = channels.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(a: RGB, b: RGB): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function composite(front: string, back: RGB): RGB {
  const alpha = front.length === 9 ? parseInt(front.slice(7), 16) / 255 : 1;
  return rgb(front).map((c, i) => c * alpha + back[i] * (1 - alpha)) as RGB;
}
function backgrounds(palette: Record<string, string>): Array<[string, RGB]> {
  const paints: Array<[string, RGB]> = Object.entries(palette).filter(([key]) => key.startsWith("surface-")).map(([key, value]) => [key, rgb(value)]);
  for (const key of ["canvas-wash", "nav-wash", "warm-wash", "exhibit-wash"]) {
    for (const hex of palette[key].match(/#[a-f\d]{6}\b/gi) ?? []) paints.push([`${key}:${hex}`, rgb(hex)]);
  }
  // Check base, both linen threads together, and lamp illumination, not just flat hex pairs.
  return paints.flatMap(([label, base]) => {
    const woven = (palette.texture.match(/#[a-f\d]{8}/gi) ?? []).reduce((color, overlay) => composite(overlay, color), base);
    const lamp = (palette["lamp-wash"].match(/#[a-f\d]{8}/gi) ?? []).reduce((color, overlay) => composite(overlay, color), woven);
    return [[label, base], [`${label}+linen`, woven], [`${label}+linen+lamp`, lamp]] as Array<[string, RGB]>;
  });
}

test("WCAG ratio reference and complete independent light/night token sets", () => {
  assert.equal(contrast(rgb("#000000"), rgb("#ffffff")), 21);
  assert.equal(contrast(rgb("#f0e0d0"), rgb("#f0e0d0")), 1);
  assert.equal(palettes.length, 2);
  assert.deepEqual(Object.keys(palettes[0]).sort(), Object.keys(palettes[1]).sort());
  for (const role of ["surface-canvas", "surface-raised", "surface-input", "text-primary", "text-secondary", "text-muted",
    "primary", "on-primary", "success", "error", "warning", "focus", "border-control", "elevation-card", "texture"]) {
    assert.ok(palettes[0][role], role);
    assert.notEqual(palettes[0][role], palettes[1][role], `${role} has its own night material/value`);
  }
});

for (const [i, palette] of palettes.entries()) {
  test(`${i === 0 ? "light" : "night"} actual CSS tokens: body/status/button text ≥4.5:1, controls/focus ≥3:1`, () => {
    const check = (fg: string, label: string, bg: RGB, minimum: number) => {
      const ratio = contrast(rgb(palette[fg]), bg);
      assert.ok(ratio >= minimum, `${fg} on ${label}: ${ratio.toFixed(3)} < ${minimum}`);
    };
    for (const [label, bg] of backgrounds(palette)) {
      for (const fg of ["text-primary", "text-secondary", "text-muted", "primary", "primary-hover", "success", "warning", "error"]) check(fg, label, bg, 4.5);
      check("focus", label, bg, 3);
    }
    for (const [fg, bg] of [["on-primary", "primary"], ["on-primary", "primary-hover"], ["on-danger", "danger-fill"],
      ["on-danger", "danger-hover"], ["on-media", "media-control"], ["on-media", "media-control-hover"],
      ["text-placeholder", "surface-input"], ["text-primary", "selection"]]) check(fg, bg, rgb(palette[bg]), 4.5);
    for (const bg of ["surface-input", "surface-raised", "surface-hover", "surface-canvas", "surface-accent", "surface-nav"]) check("border-control", bg, rgb(palette[bg]), 3);
    check("focus", "focus-inner", rgb(palette["focus-inner"]), 3);
    for (const fill of ["primary", "danger-fill"]) check("focus-inner", fill, rgb(palette[fill]), 3);
  });
}

test("component paint only references semantic tokens; relative type, visible focus and motion reduction are enforced", () => {
  for (const filename of readdirSync(ui).filter(name => /\.(css|html|ts)$/.test(name) && name !== "tokens.css")) {
    const source = readFileSync(new URL(filename, ui), "utf8");
    assert.doesNotMatch(source, /#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, `${filename} contains fixed paint`);
  }
  assert.doesNotMatch(styles, /font-size:\s*[\d.]+px|outline:\s*(none|0)\b|filter:\s*(invert|brightness|grayscale)/i);
  assert.match(styles, /button, input, select, textarea\s*\{\s*font: inherit;/);
  assert.match(styles, /:where\(button, a, input, select, textarea, \[tabindex\]\):focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--focus\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important; transition: none !important; scroll-behavior: auto !important/);
  assert.match(styles, /calendar-matrix\s*\{[^}]*overflow-x: auto/);
  assert.match(styles, /\.main\s*\{[^}]*8rem \+ env\(safe-area-inset-bottom/);
  const declared = new Set([...tokens.matchAll(/--([\w-]+):/g)].map(m => m[1]));
  for (const [, reference] of styles.matchAll(/var\(--([\w-]+)/g)) assert.ok(declared.has(reference), `undefined token ${reference}`);
});

function declarations(selector: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [, selectors, block] of styles.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(",").some(s => s.trim() === selector)) continue;
    for (const [, key, value] of block.matchAll(/([\w-]+):\s*([^;]+);/g)) values.set(key, value.trim());
  }
  return values;
}
test("touch geometry contract covers icon controls, calendar cells, inputs and checkboxes at 44–48px", () => {
  const min = Number(tokens.match(/--touch-min:\s*(\d+)px/)![1]);
  const comfort = Number(tokens.match(/--touch-comfort:\s*(\d+)px/)![1]);
  assert.ok(min >= 44); assert.ok(comfort >= 48);
  const base = declarations("button");
  assert.equal(base.get("min-height"), "var(--touch-comfort)");
  assert.equal(base.get("min-width"), "var(--touch-min)");
  for (const selector of [".photo-remove", ".favorite-toggle"]) {
    const control = declarations(selector);
    assert.equal(control.get("width"), "var(--touch-comfort)");
    assert.equal(control.get("height"), "var(--touch-comfort)");
  }
  assert.equal(declarations(".cal-day").get("min-width"), "var(--touch-min)");
  assert.match(declarations(".on-this-day .timeline-card").get("padding-inline-end")!, /var\(--touch-comfort\)/);
  assert.equal(declarations('input[type="checkbox"]').get("height"), "var(--touch-min)");
  for (const selector of ["select", 'input:not([type="checkbox"])', ".photo-pick", ".tag-option-row"]) {
    assert.equal(declarations(selector).get("min-height"), "var(--touch-comfort)", selector);
  }
});

// A structural audit only; actual layout, focus dispatch and screen readers need a browser/device.
interface Tag {name: string; attrs: Record<string, string>; parent: Tag | null; text: string; children: Tag[]}
function tags(): Tag[] {
  const result: Tag[] = [], stack: Tag[] = [];
  const source = html.replace(/<script[\s\S]*?<\/script>/g, "");
  for (const piece of source.matchAll(/<\/?([\w-]+)([^>]*)>|([^<]+)/g)) {
    if (piece[3]) { for (const open of stack) open.text += piece[3]; continue; }
    if (piece[0].startsWith("</")) { stack.pop(); continue; }
    const node: Tag = {name: piece[1], attrs: Object.fromEntries([...piece[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] ?? ""])), parent: stack.at(-1) ?? null, text: "", children: []};
    node.parent?.children.push(node); result.push(node);
    if (!["meta", "link", "input", "br", "img"].includes(node.name)) stack.push(node);
  }
  return result;
}
test("static controls have accessible names, dialogs have names/descriptions and previews expose selection", () => {
  const all = tags();
  const hasLabel = (node: Tag) => {
    for (let p = node.parent; p; p = p.parent) if (p.name === "label" && p.text.trim()) return true;
    return !!node.attrs["aria-label"] || !!node.attrs["aria-labelledby"];
  };
  const ids = all.filter(n => n.attrs.id).map(n => n.attrs.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate DOM IDs");
  for (const control of all.filter(n => ["input", "textarea", "select", "button"].includes(n.name))) {
    assert.ok(hasLabel(control) || (control.name === "button" && control.text.trim()), `${control.attrs["data-testid"] ?? control.name}: missing accessible name`);
    assert.notEqual(control.attrs.tabindex, "-1");
  }
  for (const dialog of all.filter(n => n.name === "dialog" || n.attrs.role === "dialog")) {
    assert.equal(dialog.attrs["aria-modal"], "true"); assert.ok(hasLabel(dialog));
    for (const id of (dialog.attrs["aria-labelledby"] ?? "").split(" ").filter(Boolean)) assert.ok(all.some(n => n.attrs.id === id && n.text.trim()));
  }
  const previews = all.filter(n => "data-theme-choice" in n.attrs);
  assert.equal(previews.length, 3); assert.equal(new Set(previews.map(n => n.attrs["data-theme-choice"])).size, 3);
  for (const preview of previews) assert.ok("aria-pressed" in preview.attrs);
  assert.ok(all.some(n => n.attrs.href === "#main-content"));
  assert.ok(all.some(n => n.attrs.id === "app-shell" && "inert" in n.attrs));
  assert.ok(all.some(n => n.name === "nav" && n.attrs["aria-label"]));
  assert.equal(all.filter(n => n.attrs.role === "tab").length, 0, "page navigation uses native buttons, no orphan ARIA tabs");
  const museum = all.find(n => n.attrs["data-testid"] === "museum-view")!;
  assert.equal(museum.attrs["aria-label"], "回忆博物馆");
  assert.ok(museum.children.some(n => n.attrs["data-testid"] === "museum-content"));
  assert.doesNotMatch(museum.text, /建设中|手工主题展/);
});

test("museum text, placards and month bars meet AA in both palettes including spotlight compositing", () => {
  for (const palette of palettes) {
    for (const bg of ["museum-wall", "museum-mat", "museum-placard"]) {
      const base = rgb(palette[bg]);
      const lit = (palette["museum-light"].match(/#[a-f\d]{8}/gi) ?? []).reduce((c, overlay) => composite(overlay, c), base);
      for (const background of [base, lit]) {
        for (const fg of ["text-primary", "text-secondary", "text-muted", "museum-label"]) {
          assert.ok(contrast(rgb(palette[fg]), background) >= 4.5, `${fg} on ${bg}`);
        }
        assert.ok(contrast(rgb(palette.focus), background) >= 3);
      }
    }
    assert.ok(contrast(rgb(palette["museum-bar"]), rgb(palette["museum-track"])) >= 3);
  }
});
