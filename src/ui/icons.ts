import type { MainTab } from "../domain/navigation.ts";

// Each outline shares a 24-unit grid, stroke weight and optical margin.
const paths = {
  timeline: "M7 3v3m0 4v5m0 4v2 M9 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M9 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M13 8h7m-7 9h5",
  calendar: "M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14H4z M8 3v4m8-4v4M4 10h16m-12 4h2m3 0h2m-7 3h2",
  create: "m5 15 10.6-10.6a2.2 2.2 0 0 1 3.1 0l.9.9a2.2 2.2 0 0 1 0 3.1L9 19l-5 1z M14 6l4 4",
  museum: "m2.5 8 9.5-5 9.5 5z M4 20.5h16M5 18h14M6.5 10.5v5.5m5.5-5.5v5.5m5.5-5.5v5.5",
  mine: "M16 7.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M4 20c.3-4.1 3.5-6.5 8-6.5s7.7 2.4 8 6.5",
  search: "M16.5 10a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z M15 15l5.5 5.5",
  filters: "M3 7h4m5 0h9M3 17h9m5 0h4 M12 7a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M17 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  more: "M5 12h.25M12 12h.25M19 12h.25",
  next: "m9 6 6 6-6 6",
} satisfies Record<MainTab | "search" | "filters" | "more" | "next", string>;

export function icon(name: keyof typeof paths): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("data-icon", name);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
