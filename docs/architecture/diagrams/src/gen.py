"""Generate the idp-golden-path component relations diagram (drawio XML).

The diagram is close to a C4 System Context / Container diagram (not a cloud deployment diagram).
Source of truth for what is drawn: inventory.md in this directory.

- Each relationship is one arrow with a C4 label (purpose on line 1, [technology] on line 2).
  Responses are not drawn.
- Boundaries (dashed) are C4 boundaries of what this system owns (idp-golden-path = software system,
  Backstage = container). The four repositories are external software systems outside every boundary,
  enclosed in one C4 group (dotted, light fill, name at the top left like the boundaries; the boxes have the
  same size and equal gaps and sit below the name row) that carries
  their type once: "GitHub repositories [Software System]".
- Box colours: Backstage plugins = light blue, service-baseline (template that Backstage imports) = green,
  Reusable workflows (run on GitHub Actions) = orange. People and repositories keep the C4 colours.
  The colours have no legend entry (the type line of each box tells them apart).
- At terraform-hannibal / ticket-c2c-platform, the catalog-info.yaml line leaves from the left part of the
  box and the CI guardrail line enters the right part. With Software Catalog and Reusable workflows both
  above the repositories this order forces one crossing (ticket-c2c-platform -> Software Catalog crosses
  Reusable workflows -> terraform-hannibal); the sharing line stays straight and the catalog line bends.
- Legend: the numbered flow and other relationships only.
- Numbered flow ①-⑤: creating a repository with the Software Template and running its CI
  (①-④ follow the template.yaml steps; ⑤ happens on the first PR of the new repository).

usage: python3 gen.py <out.drawio> [<out.drawio> ...]
"""
import sys
from xml.sax.saxutils import escape

FONT = "Helvetica,Arial,IPAPGothic,Hiragino Sans,Yu Gothic,Meiryo,sans-serif"

# C4 notation colours (draw.io C4 library, Sidebar-C4.js)
C4 = {
    "person": ("#083F75", "#06315C", "#FFFFFF"),
    "container": ("#23A2D9", "#0E7DAD", "#FFFFFF"),
    "component": ("#63BEF2", "#2086C9", "#0B2540"),
    "external": ("#8C8496", "#736782", "#FFFFFF"),
    # not C4 library colours: distinguish what Backstage imports and what GitHub Actions runs
    "template": ("#9EDDB0", "#2F8F52", "#0B2E18"),
    "actions": ("#FFD3A3", "#C9853A", "#3B1A04"),
}
GROUP_STROKE = "#736782"  # C4 group of external repositories (dotted, colour of the external boxes)
GROUP_FILL = "#F1EFF4"    # light fill so the four grey boxes read as one group
FLOW = "#C2410C"   # numbered flow
OTHER = "#5A5A5A"  # other relationships
NAME_PX, TYPE_PX, DESC_PX = 20, 17, 17
PURPOSE_PX, TECH_PX = 18, 17

# ---- elements: id -> (kind, name, [type], description) ----
ELEMENTS = {
    "developer": ("person", "Developer", "Person", ""),
    "platformEngineer": ("person", "Platform engineer", "Person", ""),
    "templates": ("component", "Software Templates", "", ""),
    "catalog": ("component", "Software Catalog", "", ""),
    "techdocs": ("component", "TechDocs", "", ""),
    "serviceBaseline": ("template", "service-baseline", "Container: Software Template",
                        "caller workflow 7 本・<br>catalog-info.yaml など"),
    "reusable": ("actions", "Reusable workflows", "Container: GitHub Actions", "12 本の CI ガードレール"),
    "newRepo": ("external", "New repository", "", "テンプレートの生成物"),
    "hannibal": ("external", "terraform-hannibal", "", ""),
    "ticket": ("external", "ticket-c2c-platform", "", ""),
    "felis": ("external", "felis-ai-chatbot", "", ""),
}

# ---- boundaries: id -> (name, [type]) ----
BOUNDARIES = {
    "idp": ("idp-golden-path", "Software System"),
    "backstage": ("Backstage", "Container"),
}

# ---- C4 group (not an ownership boundary): id -> (name, type, members) ----
GROUPS = {
    "repos": ("GitHub repositories", "Software System", ("hannibal", "ticket", "felis", "newRepo")),
}

# ---- relationships: id -> (source, target, numbered, purpose, [means]) ----
EDGES = {
    "flow1": ("developer", "templates", True, "① テンプレートの<br>選択と実行", "Web browser"),
    "flow2": ("templates", "serviceBaseline", True, "② skeleton の展開", "fetch:template"),
    "flow3": ("templates", "newRepo", True, "③ リポジトリの<br>作成と push", "publish:github"),
    "flow4": ("templates", "catalog", True, "④ Component の登録", "catalog:register"),
    "flow5": ("reusable", "newRepo", True, "⑤ CI ガードレール<br>の共有", "uses: @v1"),
    "shareHannibal": ("reusable", "hannibal", False, "CI ガードレール<br>の共有", "uses: @v1"),
    "shareTicket": ("reusable", "ticket", False, "CI ガードレール<br>の共有", "uses: @v1, @v1.7.2"),
    "shareFelis": ("reusable", "felis", False, "CI ガードレール<br>の共有", "uses: @v1"),
    "ingestHannibal": ("hannibal", "catalog", False, "catalog-info.yaml<br>の取り込み", "url location"),
    "ingestTicket": ("ticket", "catalog", False, "catalog-info.yaml<br>の取り込み", "url location"),
    "openDocs": ("catalog", "techdocs", False, "docs の表示", "backstage.io/techdocs-ref"),
    "browse": ("developer", "catalog", False, "サービスと docs<br>の閲覧", "Web browser"),
    "maintain": ("platformEngineer", "idp", False, "保守", "Git"),
    "distribute": ("platformEngineer", "reusable", False, "タグでの配布", "Git tag v1.x.y, v1"),
}

LEGEND_FLOW = "①〜⑤ Software Template で<br>リポジトリを作り、CI を動かすまで"
LEGEND_OTHER = "その他の関係"
TITLE = "System Context / Container 図: idp-golden-path（Backstage と reusable workflow）"


def _q(s):
    return escape(s, {'"': "&quot;"})


class Diagram:
    def __init__(self):
        self.cells = []
        self.geo = {}

    def _vertex(self, cid, label, style, x, y, w, h):
        self.geo[cid] = (x, y, w, h)
        self.cells.append('<mxCell id="%s" value="%s" style="%s" vertex="1" parent="1">'
                          '<mxGeometry x="%s" y="%s" width="%s" height="%s" as="geometry"/></mxCell>'
                          % (cid, _q(label), style, x, y, w, h))

    def element(self, cid, x, y, w, h, extra=""):
        kind, name, typ, desc = ELEMENTS[cid]
        fill, stroke, font = C4[kind]
        label = '<b style="font-size:%dpx">%s</b>' % (NAME_PX, name)
        if typ:
            label += '<br><span style="font-size:%dpx">[%s]</span>' % (TYPE_PX, typ)
        if desc:
            label += '<br><span style="font-size:%dpx">%s</span>' % (DESC_PX, desc)
        if kind == "person":
            style = ("shape=mxgraph.c4.person2;whiteSpace=wrap;html=1;align=center;verticalAlign=bottom;spacingBottom=14;"
                     "points=[[0.5,0,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0]];")
        else:
            style = "rounded=1;arcSize=10;whiteSpace=wrap;html=1;align=center;verticalAlign=middle;"
        style += "fillColor=%s;strokeColor=%s;fontColor=%s;fontSize=%d;labelBackgroundColor=none;fontFamily=%s;" % (
            fill, stroke, font, TYPE_PX, FONT) + extra
        self._vertex(cid, label, style, x, y, w, h)

    def boundary(self, cid, x, y, w, h):
        name, typ = BOUNDARIES[cid]
        label = '<b style="font-size:%dpx">%s</b>' % (NAME_PX, name)
        if typ:
            label += ' <span style="font-size:%dpx">[%s]</span>' % (TYPE_PX, typ)
        style = ("rounded=1;arcSize=12;absoluteArcSize=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=8 4;fillColor=none;"
                 "strokeColor=#666666;strokeWidth=1.5;fontColor=#333333;align=left;verticalAlign=top;spacingLeft=12;"
                 "spacingTop=4;fontSize=%d;labelBackgroundColor=none;fontFamily=%s;" % (TYPE_PX, FONT))
        self._vertex(cid, label, style, x, y, w, h)

    def group(self, cid, x, y, w, h):
        """C4 group: dotted, light fill, name at the top left (same place and format as the boundaries)."""
        name, typ, members = GROUPS[cid]
        for m in members:
            mx, my, mw, mh = self.geo[m]
            assert x < mx and y < my and mx + mw < x + w and my + mh < y + h, (cid, m)
        # two lines (name / [type]) with the boundaries' font sizes, so the name ends left of the first line
        label = '<b style="font-size:%dpx">%s</b><br><span style="font-size:%dpx">[%s]</span>' % (NAME_PX, name, TYPE_PX, typ)
        style = ("rounded=1;arcSize=12;absoluteArcSize=1;whiteSpace=wrap;html=1;dashed=1;dashPattern=1 4;fillColor=%s;"
                 "strokeColor=%s;strokeWidth=2.5;fontColor=#333333;align=left;verticalAlign=top;spacingLeft=12;"
                 "spacingTop=4;fontSize=%d;labelBackgroundColor=none;fontFamily=%s;" % (GROUP_FILL, GROUP_STROKE, TYPE_PX, FONT))
        self._vertex(cid, label, style, x, y, w, h)

    def logo(self, cid, x, y, size):
        style = "shape=mxgraph.weblogos.github;dashed=0;outlineConnect=0;html=1;aspect=fixed;"
        self._vertex(cid, "", style, x, y, size, size)

    def text(self, cid, label, x, y, w, h, size=17, bold=False):
        style = ("text;html=1;whiteSpace=nowrap;align=left;verticalAlign=middle;fontSize=%d;fontColor=#1A1A1A;fontStyle=%d;"
                 "labelBackgroundColor=none;spacing=0;fontFamily=%s;" % (size, 1 if bold else 0, FONT))
        self._vertex(cid, label, style, x, y, w, h)

    def legend_frame(self, x, y, w, h):
        style = ("rounded=1;arcSize=6;absoluteArcSize=1;html=1;fillColor=#FFFFFF;strokeColor=#999999;strokeWidth=1;"
                 "verticalAlign=top;align=left;spacingLeft=10;fontSize=%d;fontStyle=1;fontColor=#333333;fontFamily=%s;" % (TYPE_PX, FONT))
        self._vertex("legend", "凡例", style, x, y, w, h)

    @staticmethod
    def _edge_style(numbered):
        if numbered:
            return "strokeColor=%s;strokeWidth=3;endArrow=block;endFill=1;endSize=8;html=1;" % FLOW
        return "strokeColor=%s;strokeWidth=1.6;endArrow=block;endFill=1;endSize=7;html=1;" % OTHER

    def sample(self, cid, x1, y, x2, numbered):
        self.cells.append('<mxCell id="%s" value="" style="%s" edge="1" parent="1"><mxGeometry relative="1" as="geometry">'
                          '<mxPoint x="%s" y="%s" as="sourcePoint"/><mxPoint x="%s" y="%s" as="targetPoint"/></mxGeometry></mxCell>'
                          % (cid, self._edge_style(numbered), x1, y, x2, y))

    def edge(self, cid, pts, at, offset=(0, 0)):
        """pts: absolute polyline from the source boundary to the target boundary. at: label anchor on the path."""
        src, tgt, numbered, purpose, means = EDGES[cid]
        sx, sy, sw, sh = self.geo[src]
        tx, ty, tw, th = self.geo[tgt]
        (x0, y0), (x1, y1) = pts[0], pts[-1]
        ex, ey = round((x0 - sx) / sw, 4), round((y0 - sy) / sh, 4)
        nx, ny = round((x1 - tx) / tw, 4), round((y1 - ty) / th, 4)
        for v in (ex, ey, nx, ny):
            assert -0.001 <= v <= 1.001, (cid, ex, ey, nx, ny)
        color = FLOW if numbered else "#1A1A1A"
        style = self._edge_style(numbered) + (
            "rounded=0;edgeStyle=none;jumpStyle=arc;jumpSize=10;"
            "exitX=%s;exitY=%s;exitDx=0;exitDy=0;exitPerimeter=0;entryX=%s;entryY=%s;entryDx=0;entryDy=0;entryPerimeter=0;"
            "fontSize=%d;fontColor=%s;fontStyle=%d;labelBackgroundColor=#FFFFFF;spacing=2;fontFamily=%s;"
            % (ex, ey, nx, ny, PURPOSE_PX, color, 1 if numbered else 0, FONT))
        label = purpose + '<br><span style="font-size:%dpx;font-weight:normal">[%s]</span>' % (TECH_PX, means)
        gx = self._frac(pts, at) * 2 - 1
        wp = "".join('<mxPoint x="%s" y="%s"/>' % p for p in pts[1:-1])
        arr = '<Array as="points">%s</Array>' % wp if wp else ""
        off = '<mxPoint x="%s" y="%s" as="offset"/>' % offset if offset != (0, 0) else ""
        self.cells.append('<mxCell id="%s" value="%s" style="%s" edge="1" parent="1" source="%s" target="%s">'
                          '<mxGeometry x="%s" relative="1" as="geometry">%s%s</mxGeometry></mxCell>'
                          % (cid, _q(label), style, src, tgt, round(gx, 4), arr, off))

    @staticmethod
    def _frac(pts, at):
        seg = list(zip(pts, pts[1:]))
        total = sum(abs(b[0] - a[0]) + abs(b[1] - a[1]) for a, b in seg)
        acc = 0
        for a, b in seg:
            on_h = a[1] == b[1] == at[1] and min(a[0], b[0]) <= at[0] <= max(a[0], b[0])
            on_v = a[0] == b[0] == at[0] and min(a[1], b[1]) <= at[1] <= max(a[1], b[1])
            if on_h or on_v:
                return (acc + abs(at[0] - a[0]) + abs(at[1] - a[1])) / total
            acc += abs(b[0] - a[0]) + abs(b[1] - a[1])
        raise ValueError("label point %s not on path %s" % (at, pts))

    def xml(self, name):
        return ('<mxfile host="drawio"><diagram id="components" name="%s"><mxGraphModel grid="0" gridSize="10" '
                'guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1400" pageHeight="1000" '
                'background="#FFFFFF" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>%s</root>'
                '</mxGraphModel></diagram></mxfile>\n' % (name, "".join(self.cells)))


def full():
    """Layout. Repository order (left to right): registered in Software Catalog (terraform-hannibal,
    ticket-c2c-platform, below Software Catalog), not registered (felis-ai-chatbot), then the template
    output (New repository, the end of ③)."""
    d = Diagram()
    # repositories: same size, equal gaps. The group name sits at the top left, above the boxes; the lines
    # into the boxes cross the band under the group's top edge, so the group reaches left of
    # terraform-hannibal only as far as the two-line name needs (it ends left of the first line, x=470)
    REPO_X, REPO_Y, REPO_W, REPO_H, REPO_GAP = 425, 855, 210, 100, 36
    repos = {cid: REPO_X + i * (REPO_W + REPO_GAP) for i, cid in enumerate(("hannibal", "ticket", "felis", "newRepo"))}
    group_cells = len(d.cells)
    d.boundary("idp", 400, 60, 980, 540)
    d.boundary("backstage", 425, 105, 680, 310)
    # people
    d.element("developer", 20, 150, 170, 150)
    d.element("platformEngineer", 20, 395, 170, 170)
    # idp-golden-path
    d.element("templates", 450, 150, 215, 100)
    d.element("catalog", 450, 315, 215, 85)
    d.element("techdocs", 900, 315, 180, 85)
    d.element("serviceBaseline", 1120, 85, 245, 110)
    d.element("reusable", 580, 485, 710, 90)
    # external software systems (repositories), each with a small GitHub logo, in one C4 group
    for cid, x in repos.items():
        d.element(cid, x, REPO_Y, REPO_W, REPO_H, extra="verticalAlign=top;spacingTop=28;")
        d.logo(cid + "Logo", x + 6, REPO_Y + 5, 22)
    GROUP_X = 255  # name (187px, starts 14px in) ends at 456, 14px left of the first line (x=470)
    right = repos["newRepo"] + REPO_W + REPO_GAP / 2
    d.group("repos", GROUP_X, 780, right - GROUP_X, REPO_Y + REPO_H + 18 - 780)
    d.cells.insert(group_cells, d.cells.pop())
    top = REPO_Y
    h, t, f, n = (repos[k] for k in ("hannibal", "ticket", "felis", "newRepo"))
    # numbered flow
    d.edge("flow1", [(190, 235), (450, 235)], (320, 235))
    d.edge("flow2", [(665, 170), (1120, 170)], (800, 170))
    d.edge("flow3", [(665, 240), (n + 175, 240), (n + 175, top)], (1240, 240))
    d.edge("flow4", [(557, 250), (557, 315)], (557, 282))
    d.edge("flow5", [(n + 70, 575), (n + 70, top)], (n + 70, 662))
    # CI guardrails: straight down into the right part of each repository; labels in one row under Reusable workflows
    d.edge("shareHannibal", [(h + 175, 575), (h + 175, top)], (h + 175, 662))
    d.edge("shareTicket", [(t + 175, 575), (t + 175, top)], (t + 175, 662))
    d.edge("shareFelis", [(f + REPO_W // 2, 575), (f + REPO_W // 2, top)], (f + REPO_W // 2, 662))
    # catalog-info.yaml: up from the left part of each repository; labels in one row just above the repositories
    d.edge("ingestHannibal", [(h + 45, top), (h + 45, 400)], (h + 45, 738))
    d.edge("ingestTicket", [(t + 45, top), (t + 45, 622), (560, 622), (560, 400)], (t + 45, 738))
    d.edge("openDocs", [(665, 357), (900, 357)], (782, 357))
    d.edge("browse", [(105, 300), (105, 360), (450, 360)], (285, 360))
    d.edge("maintain", [(190, 490), (400, 490)], (295, 490))
    d.edge("distribute", [(190, 545), (580, 545)], (295, 545))
    # legend and title
    d.legend_frame(20, 590, 365, 125)
    d.sample("lgFlow", 35, 648, 90, True)
    d.text("lgFlowText", LEGEND_FLOW, 100, 625, 275, 46)
    d.sample("lgOther", 35, 692, 90, False)
    d.text("lgOtherText", LEGEND_OTHER, 100, 679, 250, 26)
    d.text("title", TITLE, 20, 10, 1300, 36, size=26, bold=True)
    return d.xml("System Context / Container 図")


if __name__ == "__main__":
    args = sys.argv[1:]
    xml = full()
    for path in args or ["architecture.drawio"]:
        with open(path, "w", encoding="utf-8") as f:
            f.write(xml)
