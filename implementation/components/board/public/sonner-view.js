const elk = new globalThis.ELK();

function titleWidth(value) {
  return Math.max(92, Math.min(260, Math.ceil(28 + [...value].length * 7.2)));
}

export function roundedWorkLink(points, radius = 8) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const commands = [`M ${points[0].x} ${points[0].y}`];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const corner = points[index];
    const next = points[index + 1];
    const incoming = Math.hypot(previous.x - corner.x, previous.y - corner.y);
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
    const cross = (corner.x - previous.x) * (next.y - corner.y)
      - (corner.y - previous.y) * (next.x - corner.x);
    if (incoming === 0 || outgoing === 0 || Math.abs(cross) < 0.001) {
      commands.push(`L ${corner.x} ${corner.y}`);
      continue;
    }
    const curve = Math.min(radius, incoming / 2, outgoing / 2);
    const entry = {
      x: corner.x + ((previous.x - corner.x) * curve / incoming),
      y: corner.y + ((previous.y - corner.y) * curve / incoming),
    };
    const exit = {
      x: corner.x + ((next.x - corner.x) * curve / outgoing),
      y: corner.y + ((next.y - corner.y) * curve / outgoing),
    };
    commands.push(`L ${entry.x} ${entry.y}`, `Q ${corner.x} ${corner.y} ${exit.x} ${exit.y}`);
  }
  const final = points.at(-1);
  commands.push(`L ${final.x} ${final.y}`);
  return commands.join(" ");
}

export async function layoutWorkGraph(works, { nodeHeight = 38 } = {}) {
  const laidOut = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "1",
      "elk.padding": "[top=12,left=12,bottom=12,right=12]",
      "elk.spacing.nodeNode": "26",
      "elk.spacing.edgeEdge": "10",
      "elk.layered.spacing.nodeNodeBetweenLayers": "38",
      "elk.layered.spacing.edgeNodeBetweenLayers": "14",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
    },
    children: works.map((work) => ({ id: work.id, width: titleWidth(work.id), height: nodeHeight })),
    edges: works.flatMap((work) => work.inputs.map((input) => ({
      id: `${input}->${work.id}`,
      sources: [input],
      targets: [work.id],
    }))),
  });

  return {
    width: laidOut.width,
    height: laidOut.height,
    nodes: laidOut.children.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height,
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    })),
    edges: laidOut.edges.flatMap((edge) => edge.sections.map((section) => ({
      source: edge.sources[0],
      target: edge.targets[0],
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
        .map(({ x, y }) => ({ x, y })),
    }))),
  };
}
