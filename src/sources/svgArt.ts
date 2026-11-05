function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromText(text: string): number {
  let seed = 2166136261;

  for (let index = 0; index < text.length; index += 1) {
    seed = Math.imul(seed ^ text.charCodeAt(index), 16777619);
  }

  return seed >>> 0;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function dataUri(svg: string): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function coordinate(value: number): string {
  return value.toFixed(2);
}

function wrapTitle(title: string): string[] {
  const width = 12;
  const lines: string[] = [];
  let line = '';

  for (const word of title.trim().split(/\s+/u)) {
    const characters = Array.from(word);

    for (let offset = 0; offset < characters.length; offset += width) {
      const chunk = characters.slice(offset, offset + width).join('');
      const candidate = line ? `${line} ${chunk}` : chunk;

      if (Array.from(candidate).length > width) {
        lines.push(line);
        line = chunk;
      } else {
        line = candidate;
      }
    }
  }

  if (line) {
    lines.push(line);
  }

  return lines.length > 0 ? lines : [''];
}

export function coverArt(
  title: string,
  author: string | undefined,
  hue: number,
): string {
  const random = mulberry32(
    seedFromText(`${title}\u0000${author ?? ''}\u0000${hue}`),
  );
  const decorations: string[] = [];

  for (let index = 0; index < 8; index += 1) {
    const x = coordinate(random() * 600);
    const y = coordinate(random() * 800);
    const radius = coordinate(35 + random() * 135);
    const opacity = coordinate(0.04 + random() * 0.09);

    decorations.push(
      `<circle cx="${x}" cy="${y}" r="${radius}" fill="#fff" opacity="${opacity}"/>`,
    );
  }

  for (let index = 0; index < 3; index += 1) {
    const y = coordinate(random() * 800);
    const height = coordinate(25 + random() * 55);
    const angle = coordinate(-35 + random() * 20);

    decorations.push(
      `<rect x="-200" y="${y}" width="1000" height="${height}" fill="#fff" opacity="0.06" transform="rotate(${angle} 300 400)"/>`,
    );
  }

  const lines = wrapTitle(title);
  const titleText = lines
    .map(
      (line, index) =>
        `<text x="300" y="${300 + index * 64}">${escapeXml(line)}</text>`,
    )
    .join('');

  const authorText =
    author !== undefined
      ? `<text x="300" y="${300 + lines.length * 64 + 16}" text-anchor="middle" font-size="25" fill="#fff" opacity="0.85">${escapeXml(author)}</text>`
      : '';

  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800" font-family="sans-serif">
      <title>${escapeXml(title)}</title>
      <defs>
        <linearGradient id="cover-background" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="hsl(${hue},45%,32%)"/>
          <stop offset="100%" stop-color="hsl(${hue},55%,16%)"/>
        </linearGradient>
      </defs>
      <rect width="600" height="800" fill="url(#cover-background)"/>
      ${decorations.join('')}
      <g text-anchor="middle" font-size="54" font-weight="700" fill="#fff">
        ${titleText}
      </g>
      ${authorText}
      <rect x="0" y="706" width="600" height="94" fill="#000" opacity="0.2"/>
      <text x="300" y="762" text-anchor="middle" font-size="20" letter-spacing="7" fill="#fff" opacity="0.65">SAMPLE</text>
    </svg>`,
  );
}

function starPoints(cx: number, cy: number, radius: number): string {
  const points: string[] = [];

  for (let index = 0; index < 10; index += 1) {
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    const distance = index % 2 === 0 ? radius : radius * 0.43;

    points.push(
      `${coordinate(cx + Math.cos(angle) * distance)},${coordinate(cy + Math.sin(angle) * distance)}`,
    );
  }

  return points.join(' ');
}

function panelShape(
  kind: number,
  cx: number,
  cy: number,
  size: number,
  hue: number,
  random: () => number,
): string {
  switch (kind) {
    case 0:
      return `<circle cx="${coordinate(cx)}" cy="${coordinate(cy)}" r="${coordinate(size)}" fill="hsl(43,75%,82%)" stroke="#222" stroke-width="3"/>`;

    case 1: {
      const left = coordinate(cx - size * 1.45);
      const right = coordinate(cx + size * 1.45);
      const top = coordinate(cy - size);
      const bottom = coordinate(cy + size);
      const center = coordinate(cx);

      return `<g stroke="#222" stroke-width="3" stroke-linejoin="round">
        <polygon points="${left},${bottom} ${center},${top} ${right},${bottom}" fill="hsl(${hue + 20},24%,53%)"/>
        <polygon points="${coordinate(cx - size * 0.51)},${coordinate(cy - size * 0.3)} ${center},${top} ${coordinate(cx + size * 0.51)},${coordinate(cy - size * 0.3)}" fill="#f5f1e8" stroke="none"/>
      </g>`;
    }

    case 2:
      return `<polygon points="${starPoints(cx, cy, size)}" fill="hsl(${hue + 150},55%,80%)" stroke="#222" stroke-width="3" stroke-linejoin="round"/>`;

    default: {
      const lineCount = 2 + Math.floor(random() * 2);
      const strokes: string[] = [];

      for (let index = 0; index < lineCount; index += 1) {
        const halfWidth = size * (0.45 + random() * 0.2);
        const lineY = cy + (index - (lineCount - 1) / 2) * size * 0.26;

        strokes.push(
          `<path d="M ${coordinate(cx - halfWidth)} ${coordinate(lineY)} H ${coordinate(cx + halfWidth)}"/>`,
        );
      }

      return `<g>
        <ellipse cx="${coordinate(cx)}" cy="${coordinate(cy)}" rx="${coordinate(size * 1.35)}" ry="${coordinate(size * 0.8)}" fill="#fffdf8" stroke="#222" stroke-width="3"/>
        <g fill="none" stroke="#444" stroke-width="4" stroke-linecap="round">
          ${strokes.join('')}
        </g>
      </g>`;
    }
  }
}

export function pageArt(opts: {
  title: string;
  chapterName: string;
  page: number;
  total: number;
  hue: number;
}): string {
  const { title, chapterName, page, total, hue } = opts;
  const random = mulberry32(page * 31 + hue);
  const panelCount = 3 + Math.floor(random() * 2);
  const gap = 22;
  const availableHeight = 1070 - gap * (panelCount - 1);
  const weights = Array.from(
    { length: panelCount },
    () => 0.8 + random() * 0.6,
  );
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const definitions: string[] = [];
  const panels: string[] = [];
  let y = 40;

  weights.forEach((weight, index) => {
    const height = (weight / weightSum) * availableHeight;
    const panelHue = hue + Math.round((random() - 0.5) * 50);
    const gradientId = `panel-gradient-${index}`;
    const clipId = `panel-clip-${index}`;
    const shapes: string[] = [];
    const shapeCount = 1 + Math.floor(random() * 2);

    definitions.push(
      `<linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${panelHue},42%,87%)"/>
        <stop offset="100%" stop-color="hsl(${panelHue + 15},32%,70%)"/>
      </linearGradient>
      <clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">
        <rect x="3" y="3" width="714" height="${coordinate(height - 6)}"/>
      </clipPath>`,
    );

    for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex += 1) {
      const kind = Math.floor(random() * 4);
      const cx =
        (720 * (shapeIndex + 1)) / (shapeCount + 1) +
        (random() - 0.5) * 40;
      const cy = height * (0.44 + random() * 0.12);
      const size = Math.min(height * 0.28, 95) * (0.85 + random() * 0.15);

      shapes.push(panelShape(kind, cx, cy, size, panelHue, random));
    }

    panels.push(
      `<g transform="translate(40 ${coordinate(y)})">
        <rect width="720" height="${coordinate(height)}" fill="url(#${gradientId})"/>
        <g clip-path="url(#${clipId})">
          ${shapes.join('')}
        </g>
        <rect width="720" height="${coordinate(height)}" fill="none" stroke="#222" stroke-width="6"/>
      </g>`,
    );

    y += height + gap;
  });

  const caption = `${chapterName} — page ${page}/${total}`;

  return dataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200" font-family="sans-serif">
      <title>${escapeXml(`${title} — ${caption}`)}</title>
      <defs>${definitions.join('')}</defs>
      <rect width="800" height="1200" fill="#f5f1e8"/>
      ${panels.join('')}
      <rect x="40" y="1140" width="720" height="40" fill="#ebe6dc"/>
      <path d="M 40 1140 H 760" fill="none" stroke="#c9c2b5" stroke-width="1"/>
      <text x="400" y="1168" text-anchor="middle" font-size="22" fill="#444">${escapeXml(caption)}</text>
    </svg>`,
  );
}
