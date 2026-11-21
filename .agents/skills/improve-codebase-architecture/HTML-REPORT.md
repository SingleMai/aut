<!-- Adapted from mattpocock/skills (MIT) at abeeaf95660ba9e8b7c753eb38f441ca707a8823:
     skills/engineering/improve-codebase-architecture/HTML-REPORT.md. -->

# HTML 报告格式

报告是一个自包含 HTML 文件，放在系统临时目录。Tailwind 和 Mermaid 从 CDN 加载。Mermaid 画图状结构；手写 div 和内联 SVG 画更有表现力的图（质量图、截面图）。两者混用，避免所有图都长得一样。

## 骨架

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>aut 架构评审</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict" });
    </script>
    <style>
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
  </body>
</html>
```

页面只有 Tailwind CDN 和 Mermaid ESM 两个脚本，其余全是静态内容。

## 页头

仓库名、日期和图例：实线框 = module，虚线 = seam，红色箭头 = 泄漏，深色粗框 = deep module。页头之后直接进入候选。

## 候选卡片

图承担主要信息，文字简短。每个候选是一个 `<article>`：

- **标题**：点出这次 deepening，例如"合并回包门槛 module"。
- **标签行**：推荐强度（`Strong` = emerald，`Worth exploring` = amber，`Speculative` = slate），加依赖类别标签（`in-process`、`local-substitutable`、`ports & adapters`、`mock`）。
- **文件**：等宽列表，`font-mono text-sm`。
- **前后对比图**：核心内容，左右两栏，模式见下文。
- **问题**：一句话，痛在哪。
- **方案**：一句话，改什么。
- **收益**：要点列表，每条不超过 12 个字，例如"测试只穿过一个 interface""删掉 4 个转发 module"。
- **ADR / 铁律提示**（如适用）：琥珀色底的一行。

图要一段话才能看懂时，重画这张图。

## 图的模式

按候选选模式，混合使用。

- **Mermaid flowchart**：表达"X 调 Y 调 Z，看这团乱麻"。用 classDef 把泄漏边标红、deep module 标深色，外面套一张 Tailwind 卡片。sequence diagram 适合"之前 6 次往返，之后 1 次"。
- **手写方框和箭头**：Mermaid 布局不顺手时用。module 用带边框的 div，箭头用绝对定位在相对容器上的内联 SVG `<line>` / `<path>`。适合把"之后"画成一个粗边框的 deep module，内部部件淡化。
- **截面图**：表达层层转发。横条（`h-12 border-l-4`）堆叠表示一次调用穿过的各层。之前是 6 条什么都不做的细层，之后是 1 条标注合并后职责的粗带。
- **质量图**：表达"interface 和 implementation 一样宽"。每个 module 两个矩形，一个表示 interface 面积，一个表示 implementation。之前两个几乎一样高（shallow），之后 interface 矮、implementation 高（deep）。
- **调用图折叠**：之前是嵌套方框表示的调用树，之后整棵树折进一个方框，内部调用淡化显示。

## 风格

- 偏编辑排版，留白充足。标题可用 `font-serif` 配 stone / slate。
- 一个强调色（emerald 或 indigo），红色表示泄漏，琥珀色表示警告。
- 图高约 320px，前后对比并排无需滚动。
- 图内 module 标签用 `text-xs uppercase tracking-wider`，读起来像示意图。

## 首选推荐

一张较大的卡片：候选名称、一句理由、指向其卡片的锚点链接。

## 文字

正文用中文，架构术语用 [SKILL.md](SKILL.md)「词汇」中的英文原词，领域名词用 aut 文档中的名词。示例：

- "回包门槛 module 是 shallow 的：interface 几乎等于 implementation。"
- "改写逻辑跨 seam 泄漏到 chief。"
- "deepen：一个 interface，一处测试。"
- "两个 adapter 让 seam 成立：Live `Layer` 用于生产，Test `Layer` 用于测试。"

收益要点用词汇里的术语描述收获，例如"locality：bug 集中在一个 module""leverage：一个 interface，N 个调用点""interface 收窄，implementation 吸收转发层"。能写成要点的句子就写成要点，能删的要点就删。
