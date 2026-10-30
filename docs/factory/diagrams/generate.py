"""Generate the Factory vision atlas using only the Python standard library."""

import html
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import textwrap
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent


def edge_points(source, target):
    if source["y"] == target["y"]:
        return [
            (source["x"] + source["w"], source["y"] + source["h"] / 2),
            (target["x"], target["y"] + target["h"] / 2),
        ]
    x = source["x"] + source["w"] / 2
    y = source["y"] + source["h"]
    target_x = target["x"] + target["w"] / 2
    target_y = target["y"]
    middle = (y + target_y) / 2
    return [(x, y), (x, middle), (target_x, middle), (target_x, target_y)]


def render_view(view, drawio):
    nodes = {node["id"]: node for node in view["nodes"]}
    assert len(nodes) == len(view["nodes"]), "Duplicate node ID"
    assert not {"0", "1"}.intersection(nodes), "Reserved draw.io ID"
    title = html.escape(view["title"])
    description = html.escape(view["description"] + " " + view["notes"])
    marker = "arrow-" + view["id"]
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 {view["height"]}" role="img" aria-labelledby="{view["id"]}-title {view["id"]}-desc">',
        f'<title id="{view["id"]}-title">{title}</title>',
        f'<desc id="{view["id"]}-desc">{description}</desc>',
        f'<defs><marker id="{marker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto-start-reverse"><path d="M0 0L8 4L0 8" fill="#54718b"/></marker></defs>',
        f'<rect width="900" height="{view["height"]}" fill="#f6f8fb"/>',
        '<style>text{font-family:Arial,sans-serif;fill:#17334b}</style>',
    ]
    mermaid = [
        "flowchart TD",
        "  accTitle: " + view["title"],
        "  accDescr: " + view["description"] + " " + view["notes"],
    ]
    page = ET.SubElement(drawio, "diagram", id=view["id"], name=view["title"])
    model = ET.SubElement(page, "mxGraphModel", pageWidth="900", pageHeight=str(view["height"]))
    cells = ET.SubElement(model, "root")
    ET.SubElement(cells, "mxCell", id="0")
    ET.SubElement(cells, "mxCell", id="1", parent="0")
    for index, edge in enumerate(view["edges"]):
        source, target = nodes[edge["source"]], nodes[edge["target"]]
        points = edge_points(source, target)
        kind = edge.get("kind", "flow")
        dashed = kind in ("peer", "coordination")
        path = "M" + " L".join(f"{x:g} {y:g}" for x, y in points)
        decorations = ' stroke-dasharray="5 4"' if dashed else ""
        if kind == "peer":
            decorations += f' marker-start="url(#{marker})"'
        svg.append(f'<path d="{path}" fill="none" stroke="#54718b" stroke-width="2" marker-end="url(#{marker})"{decorations}/>')
        connector = "<-->" if kind == "peer" else "-.->" if dashed else "-->"
        mermaid.append(f'  {source["id"]} {connector} {target["id"]}')
        if kind == "peer":
            mermaid.append(f"  linkStyle {index} stroke-dasharray:5 4")
        ports = "exitX=1;exitY=0.5;entryX=0;entryY=0.5;" if len(points) == 2 else "exitX=0.5;exitY=1;entryX=0.5;entryY=0;"
        style = "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;strokeColor=#54718b;" + ports
        if dashed:
            style += "dashed=1;"
        if kind == "peer":
            style += "startArrow=block;"
        cell = ET.SubElement(cells, "mxCell", id=f"edge-{index}", source=source["id"], target=target["id"], edge="1", parent="1", style=style)
        geometry = ET.SubElement(cell, "mxGeometry", {"relative": "1", "as": "geometry"})
        if len(points) > 2:
            waypoints = ET.SubElement(geometry, "Array", {"as": "points"})
            for x, y in points[1:-1]:
                ET.SubElement(waypoints, "mxPoint", x=f"{x:g}", y=f"{y:g}")
    for node in view["nodes"]:
        x, y, width, height = (node[key] for key in ("x", "y", "w", "h"))
        assert x >= 0 and y >= 0 and x + width <= 900 and y + height <= view["height"]
        svg.append(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="8" fill="#e9f1f8" stroke="#527896"/>')
        lines = textwrap.wrap(node["text"], width=max(18, int(width / 8.5)), break_long_words=False)
        for index, line in enumerate(lines):
            baseline = y + height / 2 - (len(lines) - 1) * 10 + 6 + index * 20
            svg.append(f'<text x="{x + width / 2}" y="{baseline}" text-anchor="middle" font-size="17">{html.escape(line)}</text>')
        label = node["text"].replace('"', "#quot;")
        mermaid.append(f'  {node["id"]}["{label}"]')
        cell = ET.SubElement(cells, "mxCell", id=node["id"], value=node["text"], vertex="1", parent="1", style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e9f1f8;strokeColor=#527896;fontColor=#17334b;fontSize=17;")
        ET.SubElement(cell, "mxGeometry", {"x": str(x), "y": str(y), "width": str(width), "height": str(height), "as": "geometry"})
    svg.append("</svg>")
    output = "\n".join(svg) + "\n"
    ET.fromstring(output)
    (ROOT / (view["id"] + ".svg")).write_text(output, encoding="utf8")
    (ROOT / (view["id"] + ".mmd")).write_text("\n".join(mermaid) + "\n", encoding="utf8")
    return output


def render_atlas(data, svgs):
    parts = ["""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T3Factory vision atlas</title><style>
:root{font-family:var(--font-sans,Arial,sans-serif);color:var(--foreground,#17334b)}
body{margin:0}h2{font-size:20px}p,li{line-height:1.6}a{color:var(--primary,#164f84)}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0 8px}.tabs button{font:inherit;color:var(--foreground,#17334b);padding:8px 12px;border:1px solid var(--border,#bacad8);border-radius:var(--radius,6px);background:var(--secondary,#edf3f8);cursor:pointer}.tabs button[aria-selected="true"]{background:var(--primary,#164f84);color:var(--primary-foreground,#fff)}section{border:1px solid var(--border,#cad6e1);border-radius:var(--radius,10px);background:var(--card,#fff);padding:16px;margin:12px 0}.muted{color:var(--muted-foreground,#506477);font-size:14px}.stories{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.story{background:var(--secondary,#edf3f8);padding:16px;border-radius:var(--radius,6px)}.story strong{display:block}.graph{overflow-x:auto}svg{display:block;width:100%;min-width:650px;height:auto;max-height:660px}.formats{display:flex;gap:16px;flex-wrap:wrap}.view[hidden]{display:none}summary{cursor:pointer;font-weight:bold}a:focus-visible,button:focus-visible,summary:focus-visible,section:focus-visible{outline:3px solid var(--ring,#164f84);outline-offset:4px}@media print{.tabs{display:none}.view[hidden]{display:block}section{break-before:page;border:0}svg{min-width:0;max-height:800px}}
</style></head><body>
<p><strong>Launch a thread to settle an outcome.</strong> T3Factory brings agents, tools, and compute together for software, research, and knowledge work in one experience.</p>
<p class="muted">Product direction reviewed 2026-10-29. These views are design illustrations, not a working client or release checklist.</p>
<p><a href="../vision.md">Read the vision</a> · <a href="../sources.md">Sources and evidence</a> · <a href="t3factory.drawio">Editable five-page draw.io</a> · <a href="diagrams.json">Canonical graph data</a></p>
<details><summary>Five people, the same thread experience</summary><div class="stories">"""]
    for story in data["stories"]:
        parts.append(f'<p class="story"><strong>{html.escape(story["person"])}</strong>{html.escape(story["outcome"])}</p>')
    parts.append('</div><p class="muted">Illustrative examples only. No persona or work-type selector is required.</p></details><div class="tabs" role="tablist" aria-label="Architecture views">')
    for index, view in enumerate(data["views"]):
        parts.append(f'<button id="tab-{view["id"]}" role="tab" aria-selected="{str(index == 0).lower()}" aria-controls="{view["id"]}" tabindex="{0 if index == 0 else -1}">{html.escape(view["label"])}</button>')
    parts.append("</div>")
    for index, (view, svg) in enumerate(zip(data["views"], svgs)):
        hidden = " hidden" if index else ""
        parts.append(f'<section id="{view["id"]}" class="view" role="tabpanel" tabindex="0" aria-labelledby="tab-{view["id"]}"{hidden}><h2>{html.escape(view["title"])}</h2><p>{html.escape(view["description"])}</p><div class="graph">{svg}</div><p>{html.escape(view["notes"])}</p><p class="formats"><a href="{view["id"]}.svg">SVG</a><a href="{view["id"]}.mmd">Mermaid</a></p></section>')
    parts.append('''<footer><p class="muted">All formats derive from the same graph model. SVG geometry is generated directly; Mermaid renderers choose their own layout. The draw.io pages contain editable native shapes and connectors. See the vision for lifecycle and authority decisions.</p></footer>
<script>
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function selectTab(index, focus) {
  tabs.forEach((tab, i) => {
    const selected = i === index;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  });
  if (focus) tabs[index].focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(index, false));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(next, true); }
  });
});
const initial = tabs.findIndex(tab => '#' + tab.getAttribute('aria-controls') === location.hash);
if (initial >= 0) selectTab(initial, false);
</script></body></html>\n''')
    (ROOT / "index.html").write_text("\n".join(parts), encoding="utf8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", action="store_true", help="Format HTML/JSON with the repository's installed vp toolchain")
    args = parser.parse_args()
    data = json.loads((ROOT / "diagrams.json").read_text(encoding="utf8"))
    assert data["schemaVersion"] == 1
    assert len({view["id"] for view in data["views"]}) == len(data["views"])
    drawio = ET.Element("mxfile", host="app.diagrams.net")
    svgs = [render_view(view, drawio) for view in data["views"]]
    ET.indent(drawio)
    ET.ElementTree(drawio).write(ROOT / "t3factory.drawio", encoding="utf-8", xml_declaration=True)
    render_atlas(data, svgs)
    if args.format:
        formatter = shutil.which("vp")
        if formatter is None:
            parser.error("--format requires the repository's installed vp toolchain")
        subprocess.run([formatter, "fmt", str(ROOT / "index.html"), str(ROOT / "diagrams.json")], check=True, cwd=ROOT.parents[2])
    print(f"Generated {len(svgs)} SVGs, {len(svgs)} Mermaid sources, native draw.io pages, and HTML atlas.")


if __name__ == "__main__":
    main()
