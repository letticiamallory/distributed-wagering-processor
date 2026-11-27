import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

// N-4 da segunda avaliação: o MiniStack e o aws-cli estavam sem tag (pegavam `latest`) no compose e no
// CI. Uma versão nova pode mudar a fila ou o endpoint de health e quebrar a subida de quem avaliar
// depois. Toda imagem tem uma tag explícita, e as duas que flutuavam ficam nas versões que estavam
// funcionando em 27/11/2026.
const FILES = ['docker-compose.yml', '.github/workflows/ci.yml'];

const imagesOf = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(
    (m) => m[1] as string,
  );

describe('container images are pinned', () => {
  for (const file of FILES) {
    test(`${file}: every image has an explicit tag other than latest`, () => {
      const images = imagesOf(file);
      expect(images.length).toBeGreaterThan(0);
      const floating = images.filter(
        (image) => !/:[^/]+$/.test(image) || image.endsWith(':latest'),
      );
      expect(floating).toEqual([]);
    });
  }

  test('MiniStack 1.5.44 and aws-cli 2.42.3, the same in the compose and in the CI', () => {
    const all = FILES.flatMap(imagesOf);
    for (const image of all.filter((i) => i.startsWith('ministackorg/'))) {
      expect(image).toBe('ministackorg/ministack:1.5.44');
    }
    for (const image of all.filter((i) => i.startsWith('amazon/aws-cli'))) {
      expect(image).toBe('amazon/aws-cli:2.42.3');
    }
    expect(all).toContain('ministackorg/ministack:1.5.44');
    expect(all).toContain('amazon/aws-cli:2.42.3');
  });
});
